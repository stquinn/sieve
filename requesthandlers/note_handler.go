package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type NoteHandler struct {
	GetSession  func() sieve.Session
	SaveSession func(sieve.Session) error
	NewBuffer   func() (string, error)
	DeleteNote  func(uuid string) error
	Tmpl        *template.Template
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
	session := h.GetSession()

	exists := false
	for i, t := range session.Tabs {
		if t.ID == id {
			session.ActiveIdx = i
			exists = true
			break
		}
	}

	if !exists {
		session.Tabs = append(session.Tabs, sieve.Tab{ID: id, Mode: "wysiwyg"})
		session.ActiveIdx = len(session.Tabs) - 1
	}

	_ = h.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, id)
}

func (h *NoteHandler) handleNoteNew(w http.ResponseWriter, r *http.Request) {
	uuid, err := h.NewBuffer()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.GetSession()
	session.Tabs = append(session.Tabs, sieve.Tab{ID: uuid, Mode: "wysiwyg"})
	session.ActiveIdx = len(session.Tabs) - 1
	_ = h.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, uuid)
}

func (h *NoteHandler) handleTabsCloseAll(w http.ResponseWriter, r *http.Request) {
	uuid, err := h.NewBuffer()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.GetSession()
	session.Tabs = []sieve.Tab{{ID: uuid, Mode: "wysiwyg"}}
	session.ActiveIdx = 0
	_ = h.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, uuid)
}

func (h *NoteHandler) handleTabsClose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	session := h.GetSession()
	
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
		uuid, _ := h.NewBuffer()
		session.Tabs = []sieve.Tab{{ID: uuid, Mode: "wysiwyg"}}
		session.ActiveIdx = 0
	}
	
	_ = h.SaveSession(session)

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
	
	session := h.GetSession()
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
	
	_ = h.SaveSession(session)
	
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *NoteHandler) handleNoteDelete(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	
	if err := h.DeleteNote(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.GetSession()
	
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
		uuid, _ := h.NewBuffer()
		session.Tabs = []sieve.Tab{{ID: uuid, Mode: "wysiwyg"}}
		session.ActiveIdx = 0
	}
	
	_ = h.SaveSession(session)

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
