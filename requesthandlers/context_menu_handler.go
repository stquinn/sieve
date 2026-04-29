package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"
	"strings"

	"github.com/go-chi/chi/v5"
)

type ContextMenuHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	Tmpl             *template.Template
	DeleteFolder     func(id string) error
	RenameFolder     func(id, name string) error
	CreateFolder     func(parentFolderID, name string) error
	EmitNotesChanged func()
	EmitPromptsChanged func()
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
	r.Get("/api/sidebar/create-folder-prompt", h.handleCreateFolderPrompt)
	r.Post("/api/sidebar/create-folder", h.handleCreateFolder)
	r.Post("/api/sidebar/revert-prompt", h.handleRevertPrompt)
}

// ── Menu content ──────────────────────────────────────────────────────────────

type contextMenuData struct {
	ID        string
	Name      string
	Intent    string
	IsDir     bool
	IsPrompt  bool
	IsVirtual bool
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
	if strings.HasPrefix(data.ID, "prompt:") {
		data.IsPrompt = true
		data.IsVirtual = true
		for _, pe := range h.ServiceProvider.Prompts.ListPrompts() {
			if pe.ID == data.ID {
				data.IsVirtual = pe.IsVirtual
				break
			}
		}
		tplName = "prompt-context-menu.html"
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
	if err == nil {
		if _, err := h.ServiceProvider.Notes.SetIntent(n, value); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		b, err := h.ServiceProvider.Buffers.LoadByUUID(id)
		if err != nil {
			http.Error(w, "not found in notes or buffers", http.StatusNotFound)
			return
		}
		if _, err := h.ServiceProvider.Buffers.SetIntent(b, value); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	session := h.ServiceProvider.State.LoadSession()
	for i := range session.Tabs {
		if session.Tabs[i].ID == id {
			if n, err := h.ServiceProvider.Notes.LoadByUUID(id); err == nil {
				session.Tabs[i].Status = n.Meta().Status()
				session.Tabs[i].DisplayName = n.Meta().DisplayName()
				if n.Meta().UserIntent() != nil {
					session.Tabs[i].UserIntent = *n.Meta().UserIntent()
				}
			} else if b, err := h.ServiceProvider.Buffers.LoadByUUID(id); err == nil {
				session.Tabs[i].Status = b.Meta().Status()
				session.Tabs[i].DisplayName = b.Meta().DisplayName()
				if b.Meta().UserIntent() != nil {
					session.Tabs[i].UserIntent = *b.Meta().UserIntent()
				}
			}
			break
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", fmt.Sprintf(`{"intent:changed": {"uuid": "%s"}}`, id))
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleDeleteNote(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	note, err := h.ServiceProvider.Notes.LoadByUUID(id)
	if err == nil {
		if err := h.ServiceProvider.Notes.Delete(note); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		buf, err := h.ServiceProvider.Buffers.LoadByUUID(id)
		if err != nil {
			http.Error(w, "not found in notes or buffers", http.StatusNotFound)
			return
		}
		if err := h.ServiceProvider.Buffers.Discard(buf); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	if err := h.DeleteFolder(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
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
	if err == nil {
		if _, err := h.ServiceProvider.Notes.Rename(note, name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		buf, err := h.ServiceProvider.Buffers.LoadByUUID(id)
		if err != nil {
			http.Error(w, "not found in notes or buffers", http.StatusNotFound)
			return
		}
		if _, err := h.ServiceProvider.Buffers.Rename(buf, name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
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
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleCreateFolderPrompt(w http.ResponseWriter, r *http.Request) {
	parentId := r.URL.Query().Get("parentId")
	data := struct {
		ParentID string
	}{
		ParentID: parentId,
	}

	if err := h.Tmpl.ExecuteTemplate(w, "create_folder.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *ContextMenuHandler) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	parentId := r.URL.Query().Get("parentId")
	name := r.FormValue("name")
	if name == "" {
		name = r.URL.Query().Get("name")
	}

	if err := h.CreateFolder(parentId, name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	RenderSidebar(w, h.ServiceProvider.Notes, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleRevertPrompt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if strings.HasPrefix(id, "prompt:") {
		name := strings.TrimPrefix(id, "prompt:")
		_ = h.ServiceProvider.Prompts.DeletePrompt(name)
		if h.EmitPromptsChanged != nil {
			h.EmitPromptsChanged()
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
