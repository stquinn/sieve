package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type ContextMenuHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	DeleteFolder    func(id string) error
	RenameFolder    func(id, name string) error
}

func (h *ContextMenuHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/context-menu", h.handleMenu)
	r.Post("/api/sidebar/intent", h.handleIntent)
	r.Post("/api/sidebar/delete-note", h.handleDeleteNote)
	r.Post("/api/sidebar/delete-folder", h.handleDeleteFolder)
	r.Get("/api/sidebar/delete-prompt", h.handleDeletePrompt)
	r.Get("/api/sidebar/rename-prompt", h.handleRenamePrompt)
	r.Post("/api/sidebar/rename-note", h.handleRenameNote)
	r.Post("/api/sidebar/rename-folder", h.handleRenameFolder)
}

// ── Menu content ──────────────────────────────────────────────────────────────

type contextMenuData struct {
	ID     string
	Name   string
	Intent string
	IsDir  bool
}

func (h *ContextMenuHandler) handleMenu(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	data := contextMenuData{
		ID:     q.Get("id"),
		Name:   q.Get("name"),
		Intent: q.Get("intent"),
		IsDir:  q.Get("isDir") == "true",
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	tplName := "note-context-menu.html"
	if data.IsDir {
		tplName = "folder-context-menu.html"
	}
	if err := h.Tmpl.ExecuteTemplate(w, tplName, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// ── Actions → return refreshed sidebar ───────────────────────────────────────

func (h *ContextMenuHandler) handleIntent(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	value := r.URL.Query().Get("value")

	n, err := h.ServiceProvider.Notes.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if _, err := h.ServiceProvider.Notes.SetIntent(n, value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleDeleteNote(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	note, err := h.ServiceProvider.Notes.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := h.ServiceProvider.Notes.Delete(note); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	if err := h.DeleteFolder(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleRenamePrompt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	name := r.URL.Query().Get("name")
	itemType := r.URL.Query().Get("type")

	data := struct {
		ID   string
		Name string
		Type string
	}{
		ID:   id,
		Name: name,
		Type: itemType,
	}

	if err := h.Tmpl.ExecuteTemplate(w, "rename.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *ContextMenuHandler) handleDeletePrompt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	name := r.URL.Query().Get("name")
	itemType := r.URL.Query().Get("type")

	data := struct {
		ID   string
		Name string
		Type string
	}{
		ID:   id,
		Name: name,
		Type: itemType,
	}

	if err := h.Tmpl.ExecuteTemplate(w, "delete.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *ContextMenuHandler) handleRenameNote(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	name := r.FormValue("name")
	if name == "" {
		name = r.URL.Query().Get("name")
	}
	note, err := h.ServiceProvider.Notes.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_, err = h.ServiceProvider.Notes.Rename(note, name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleRenameFolder(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	name := r.FormValue("name")
	if name == "" {
		name = r.URL.Query().Get("name")
	}
	if err := h.RenameFolder(id, name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}
