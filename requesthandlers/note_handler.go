package requesthandlers

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"
	"sieve/sieve/domain"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
)

type editorSwap struct {
	UUID string
	Mode string
}

type NoteHandler struct {
	ServiceProvider    *sieve.ServiceProvider
	Tmpl               *template.Template
	EmitSessionChanged func()
}

func (h *NoteHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/note/open/{id}", h.handleNoteOpen)
	r.Post("/api/note/new", h.handleNoteNew)
	r.Post("/api/tabs/close", h.handleTabsClose)
	r.Post("/api/tabs/reorder", h.handleTabsReorder)
	r.Delete("/api/note/{id}", h.handleNoteDelete)
	r.Post("/api/note/focus/{id}", h.handleNoteFocus)
}

func (h *NoteHandler) handleNoteOpen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	var displayName string
	var status string
	var userIntent string
	note, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err == nil {
		displayName = note.Meta().DisplayName()
		status = note.Kind().FiledStatus()
		if note.Meta().UserIntent() != nil {
			userIntent = *note.Meta().UserIntent()
		}
	} else if strings.HasPrefix(id, "prompt:") {
		promptName := strings.TrimPrefix(id, "prompt:")
		displayName = promptName + " Prompt"
		for _, pe := range h.ServiceProvider.Prompts.ListPrompts() {
			if pe.ID == id {
				displayName = pe.DisplayName
				break
			}
		}
		status = "filed"
	} else {
		http.Error(w, "document not found", http.StatusNotFound)
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
		tabMode := "wysiwyg"
		if strings.HasPrefix(id, "prompt:") {
			tabMode = "markdown"
		} else if note != nil {
			if m := note.Meta().All()["mode"]; m != "" {
				tabMode = m
			}
		}
		session.Tabs = append(session.Tabs, domain.Tab{
			ID:          id,
			Mode:        tabMode,
			DisplayName: displayName,
			Status:      status,
			UserIntent:  userIntent,
		})
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
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: activeTab.ID, Mode: activeTab.Mode}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
}

func (h *NoteHandler) handleNoteNew(w http.ResponseWriter, r *http.Request) {
	newNote, err := h.ServiceProvider.Documents.New()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	session.Tabs = append(session.Tabs, domain.Tab{
		ID:          newNote.UUID(),
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

	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: newNote.UUID(), Mode: "wysiwyg"}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

}

// handleTabsClose is the ONE close mechanism: it takes a JSON body {"ids":[…]}
// and closes every listed tab. A single close sends one id, Close All sends every
// tab's id, Close Others sends the complement of the kept tab — the frontend
// computes the set; the server closes it. Session.CloseTabs owns the tab-list +
// active-index math; each closed DOC (non-prompt) rides the SAME Smart-Close
// filing path a single close always used (Editor.CloseDocument). An emptied
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
	// path a single close used. Prompt tabs return nothing to file.
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
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: activeTab.ID, Mode: activeTab.Mode}); err != nil {
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

	session := h.ServiceProvider.State.LoadSession()

	newTabs := []domain.Tab{}
	for _, t := range session.Tabs {
		if t.ID != id {
			newTabs = append(newTabs, t)
		}
	}
	session.Tabs = newTabs
	if session.ActiveIdx >= len(session.Tabs) {
		session.ActiveIdx = len(session.Tabs) - 1
	}
	if session.ActiveIdx < 0 && len(session.Tabs) > 0 {
		session.ActiveIdx = 0
	}

	if len(session.Tabs) == 0 {
		newNote, _ := h.ServiceProvider.Documents.New()
		session.Tabs = []domain.Tab{{
			ID:          newNote.UUID(),
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

	fmt.Fprint(w, `<div id="htmx-sidebar" hx-swap-oob="true" class="sidebar" hx-get="/api/sidebar" hx-trigger="load"></div>`)

	activeTab := session.Tabs[session.ActiveIdx]
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorSwap{UUID: activeTab.ID, Mode: activeTab.Mode}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
}

func (h *NoteHandler) handleNoteFocus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if strings.HasPrefix(id, "prompt:") {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if note, err := h.ServiceProvider.Documents.LoadByUUID(id); err == nil {
		h.ServiceProvider.Documents.IncrementFocusCount(note)
	} else {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
