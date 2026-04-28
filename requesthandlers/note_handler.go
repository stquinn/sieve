package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type NoteHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (h *NoteHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/note/open/{id}", h.handleNoteOpen)
	r.Post("/api/note/new", h.handleNoteNew)
	r.Post("/api/tabs/close/{id}", h.handleTabsClose)
	r.Post("/api/tabs/closeAll", h.handleTabsCloseAll)
	r.Post("/api/tabs/reorder", h.handleTabsReorder)
	r.Delete("/api/note/{id}", h.handleNoteDelete)
}

func (h *NoteHandler) handleNoteOpen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	note, err := h.ServiceProvider.Notes.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
		session.Tabs = append(session.Tabs, sieve.Tab{ID: id, Mode: "wysiwyg", DisplayName: note.Meta().DisplayName()})
		session.ActiveIdx = len(session.Tabs) - 1
	}

	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; display: flex; flex-direction: column;"></div>
	</div>`, id)
}

func (h *NoteHandler) handleNoteNew(w http.ResponseWriter, r *http.Request) {
	newNote, err := h.ServiceProvider.Buffers.New()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	session.Tabs = append(session.Tabs, sieve.Tab{ID: newNote.UUID(), Mode: "wysiwyg", DisplayName: newNote.Meta().DisplayName()})
	session.ActiveIdx = len(session.Tabs) - 1
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; display: flex; flex-direction: column;"></div>
	</div>`, newNote.UUID())
}

func (h *NoteHandler) handleTabsCloseAll(w http.ResponseWriter, r *http.Request) {
	newNote, err := h.ServiceProvider.Buffers.New()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.ServiceProvider.State.LoadSession()
	session.Tabs = []sieve.Tab{{ID: newNote.UUID(), Mode: "wysiwyg"}}
	session.ActiveIdx = 0
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, newNote.UUID())
}

func (h *NoteHandler) handleTabsClose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	session := h.ServiceProvider.State.LoadSession()

	newTabs := []sieve.Tab{}
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
		newNote, _ := h.ServiceProvider.Buffers.New()
		session.Tabs = []sieve.Tab{{ID: newNote.UUID(), Mode: "wysiwyg", DisplayName: newNote.Meta().DisplayName()}}
		session.ActiveIdx = 0
	}

	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	activeID := session.Tabs[session.ActiveIdx].ID
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, activeID)
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

	tabs = append(tabs[:toIdx], append([]sieve.Tab{moved}, tabs[toIdx:]...)...)
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

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *NoteHandler) handleNoteDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	note, err := h.ServiceProvider.Notes.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.ServiceProvider.Notes.Delete(note); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.ServiceProvider.State.LoadSession()

	newTabs := []sieve.Tab{}
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
		newNote, _ := h.ServiceProvider.Buffers.New()
		session.Tabs = []sieve.Tab{{ID: newNote.UUID(), Mode: "wysiwyg", DisplayName: newNote.Meta().DisplayName()}}
		session.ActiveIdx = 0
	}

	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	fmt.Fprint(w, `<div id="htmx-sidebar" hx-swap-oob="true" class="sidebar" hx-get="/api/sidebar" hx-trigger="load"></div>`)

	activeID := session.Tabs[session.ActiveIdx].ID
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, activeID)
}
