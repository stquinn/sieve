package requesthandlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"
	"sieve/sieve/domain"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

// editorSwap is what editor.html mounts: the container, its kind and the mode
// it was last in.
type editorSwap struct {
	UUID string
	Mode string
	Kind string
}

type NoteHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	// EmitContainerDeleted announces an accomplished deletion by uuid to every
	// workspace socket, which is the only signal that reaches a client holding
	// the document open — see handleNoteDelete.
	EmitContainerDeleted func(uuid string)
	EmitSessionChanged   func()
	EmitNotesChanged     func()
}

// RegisterPaths mounts the note's own lifecycle — create, rename, delete — the
// opening of any container in a tab, and the tab operations that follow from it.
// A note is a RESOURCE here: the method says what happens to it, so there is one
// path per note rather than one path per verb.
func (h *NoteHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/note", h.handleNoteCreate)
	r.Post("/api/container/open/{id}", h.handleContainerOpen)
	r.Patch("/api/note/{id}", h.handleNotePatch)
	r.Delete("/api/note/{id}", h.handleNoteDelete)
	r.Post("/api/tabs/close", h.handleTabsClose)
	r.Post("/api/tabs/reorder", h.handleTabsReorder)
}

// handleContainerOpen opens a tab for any container — a prompt, a document, a
// block container or another node the Router resolves — or focuses the one
// already open, and answers with the tab strip and the editor mount.
func (h *NoteHandler) handleContainerOpen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	opened, err := h.tabFor(id)
	if err != nil {
		http.Error(w, "nothing to open: "+err.Error(), http.StatusNotFound)
		return
	}
	session := h.ServiceProvider.State.LoadSession()

	exists := false
	for i, t := range session.Tabs {
		if t.ID == id {
			session.ActiveIdx = i
			exists = true
			break
		}
	}

	if !exists {
		session.Tabs = append(session.Tabs, opened)
		session.ActiveIdx = len(session.Tabs) - 1
	}

	_ = h.ServiceProvider.State.SaveSession(session)
	if h.EmitSessionChanged != nil {
		h.EmitSessionChanged()
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	activeTab := session.Tabs[session.ActiveIdx]
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: activeTab.ID, Mode: activeTab.Mode, Kind: activeTab.ContainerKind()}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
}

// tabFor builds the tab that opens id. A prompt id is a prompt; anything else is
// what the Router resolves it to — a document, with its filed status, intent and
// last mode, or any other node, with its kind and title.
func (h *NoteHandler) tabFor(id string) (domain.Tab, error) {
	if name, isPrompt := strings.CutPrefix(id, "prompt:"); isPrompt {
		displayName := name + " Prompt"
		for _, pe := range h.ServiceProvider.Prompts.ListPrompts() {
			if pe.ID == id {
				displayName = pe.DisplayName
				break
			}
		}
		return domain.Tab{ID: id, Kind: domain.TabKindPrompt, Mode: "markdown", DisplayName: displayName, Status: "filed"}, nil
	}
	if h.ServiceProvider.Nodes == nil {
		return domain.Tab{}, errors.New("address resolution is unavailable")
	}
	node, err := h.ServiceProvider.Nodes.Resolve(domain.NewContainerAddress(id))
	if err != nil {
		return domain.Tab{}, err
	}
	note, err := h.documentOf(node)
	if err != nil {
		name := node.Title
		if name == "" {
			name = node.Kind
		}
		return domain.Tab{ID: id, Kind: node.Kind, DisplayName: name}, nil
	}
	tab := domain.Tab{
		ID:          id,
		Kind:        string(note.Kind()),
		Mode:        "wysiwyg",
		DisplayName: note.Meta().DisplayName(),
		Status:      note.Kind().FiledStatus(),
	}
	if m := note.Meta().All()["mode"]; m != "" {
		tab.Mode = m
	}
	if note.Meta().UserIntent() != nil {
		tab.UserIntent = *note.Meta().UserIntent()
	}
	return tab, nil
}

// documentOf is the document node is, read from the store only when node is of a
// document kind.
func (h *NoteHandler) documentOf(node domain.NodeDescriptor) (domain.Document, error) {
	if !domain.DocumentKind(node.Kind).IsDocument() {
		return nil, fmt.Errorf("%s is a %s, not a document", node.ID, node.Kind)
	}
	return h.ServiceProvider.Documents.LoadByUUID(node.ID)
}

func (h *NoteHandler) handleNoteCreate(w http.ResponseWriter, r *http.Request) {
	newNote, err := h.ServiceProvider.Documents.New()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	session.Tabs = append(session.Tabs, domain.Tab{
		ID:          newNote.UUID(),
		Kind:        string(newNote.Kind()),
		Mode:        "wysiwyg",
		DisplayName: newNote.Meta().DisplayName(),
		Status:      "unfiled",
	})
	session.ActiveIdx = len(session.Tabs) - 1
	_ = h.ServiceProvider.State.SaveSession(session)
	if h.EmitSessionChanged != nil {
		h.EmitSessionChanged()
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: newNote.UUID(), Mode: "wysiwyg", Kind: string(newNote.Kind())}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

}

// handleTabsClose is the ONE close mechanism: it takes a JSON body {"ids":[…]}
// and closes every listed tab. A single close sends one id, Close All sends every
// tab's id, Close Others sends the complement of the kept tab — the frontend
// computes the set; the server closes it. Session.CloseTabs owns the tab-list +
// active-index math; each closed DOCUMENT rides the SAME Smart-Close filing path
// a single close always used (Editor.CloseDocument), and a prompt or block
// container tab is only removed. An emptied
// session mints a fresh note, exactly as closing the last tab did before.
func (h *NoteHandler) handleTabsClose(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	session := h.ServiceProvider.State.LoadSession()

	// Smart Close background filing for every closed document — the SAME per-doc
	// path a single close used.
	for _, docID := range session.CloseTabs(payload.IDs) {
		h.ServiceProvider.Editor.CloseDocument(docID)
	}

	if len(session.Tabs) == 0 {
		newNote, err := h.ServiceProvider.Documents.New()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		session.Tabs = []domain.Tab{{
			ID:          newNote.UUID(),
			Kind:        string(newNote.Kind()),
			Mode:        "wysiwyg",
			DisplayName: newNote.Meta().DisplayName(),
			Status:      "unfiled",
		}}
		session.ActiveIdx = 0
	}

	_ = h.ServiceProvider.State.SaveSession(session)
	if h.EmitSessionChanged != nil {
		h.EmitSessionChanged()
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	activeTab := session.Tabs[session.ActiveIdx]
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: activeTab.ID, Mode: activeTab.Mode, Kind: activeTab.ContainerKind()}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
}

func (h *NoteHandler) handleTabsReorder(w http.ResponseWriter, r *http.Request) {
	fromStr := r.FormValue("from")
	toStr := r.FormValue("to")

	fromIdx, _ := strconv.Atoi(fromStr)
	toIdx, _ := strconv.Atoi(toStr)

	session := h.ServiceProvider.State.LoadSession()
	if fromIdx < 0 || fromIdx >= len(session.Tabs) || toIdx < 0 || toIdx > len(session.Tabs) {
		http.Error(w, "invalid indices", http.StatusBadRequest)
		return
	}

	tabs := session.Tabs
	moved := tabs[fromIdx]

	tabs = append(tabs[:fromIdx], tabs[fromIdx+1:]...)

	if toIdx > fromIdx {
		toIdx--
	}

	tabs = append(tabs[:toIdx], append([]domain.Tab{moved}, tabs[toIdx:]...)...)
	session.Tabs = tabs

	activeIdx := session.ActiveIdx
	if activeIdx == fromIdx {
		activeIdx = toIdx
	} else if activeIdx > fromIdx && activeIdx <= toIdx {
		activeIdx--
	} else if activeIdx < fromIdx && activeIdx >= toIdx {
		activeIdx++
	}
	session.ActiveIdx = activeIdx

	_ = h.ServiceProvider.State.SaveSession(session)
	if h.EmitSessionChanged != nil {
		h.EmitSessionChanged()
	}

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleNotePatch changes a note's properties — today its display name, which
// is a rename on disk. It answers with the refreshed sidebar, because that is
// the view the rename dialog swapped from.
func (h *NoteHandler) handleNotePatch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	req, err := requestBody{r}.notePatch()
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Name == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}

	note, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	renamed, err := h.ServiceProvider.Documents.Rename(note, req.Name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.ServiceProvider.State.LoadSession()
	for i := range session.Tabs {
		if session.Tabs[i].ID == id {
			session.Tabs[i].DisplayName = renamed.Meta().DisplayName()
			break
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

func (h *NoteHandler) handleNoteDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	note, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.ServiceProvider.Documents.Delete(note); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// The document is gone: that is news, broadcast to every workspace socket so
	// each client can reconcile — drop the tab it still holds and destroy that
	// tab's editor, closing its document socket. No swap in this response reaches
	// a client holding the note open in the BACKGROUND, and a client in another
	// window is not the requester at all.
	if h.EmitContainerDeleted != nil {
		h.EmitContainerDeleted(id)
	}

	h.deletionReconciler().reconcile(w, id)
}

// deletionReconciler builds the shared second half of a deletion from this
// handler's own dependencies — the folder delete assembles the same seam from
// its own, so neither owns it and the two answer identically.
func (h *NoteHandler) deletionReconciler() deletionReconciler {
	return deletionReconciler{
		sp:                 h.ServiceProvider,
		tmpl:               h.Tmpl,
		emitSessionChanged: h.EmitSessionChanged,
		emitNotesChanged:   h.EmitNotesChanged,
	}
}
