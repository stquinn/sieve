package requesthandlers

import (
	"fmt"
	"html/template"
	"log"
	"net/http"
	"sieve/sieve"
	"strings"

	"github.com/go-chi/chi/v5"
)

type ContextMenuHandler struct {
	ServiceProvider    *sieve.ServiceProvider
	Tmpl               *template.Template
	EmitNotesChanged   func()
	EmitPromptsChanged func()
}

func (h *ContextMenuHandler) RegisterPaths(r chi.Router) {
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
	r.Post("/api/sidebar/move", h.handleMoveItem)
}

// ── Actions → return refreshed sidebar ───────────────────────────────────────

func (h *ContextMenuHandler) handleIntent(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	value := r.URL.Query().Get("value")

	doc, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err == nil {
		if _, err := h.ServiceProvider.Documents.SetUserIntent(doc, value); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	session := h.ServiceProvider.State.LoadSession()
	for i := range session.Tabs {
		if session.Tabs[i].ID == id {

			session.Tabs[i].Status = doc.Meta().Status()
			session.Tabs[i].DisplayName = doc.Meta().DisplayName()
			if doc.Meta().UserIntent() != nil {
				session.Tabs[i].UserIntent = *doc.Meta().UserIntent()
			}
			break
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", fmt.Sprintf(`{"intent:changed": {"uuid": "%s"}, "notes:changed": true}`, id))
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleDeleteNote(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	doc, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err == nil {
		if err := h.ServiceProvider.Documents.Delete(doc); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleDeleteFolder(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	if err := h.ServiceProvider.Documents.DeleteFolder(id); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
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
	note, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	renamed, err := h.ServiceProvider.Documents.Rename(note, name)
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

func (h *ContextMenuHandler) handleRenameFolder(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	name := r.FormValue("name")
	if name == "" {
		name = r.URL.Query().Get("name")
	}
	if err := h.ServiceProvider.Documents.RenameFolder(id, name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
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
	name := r.FormValue("name")
	if name == "" {
		name = r.URL.Query().Get("name")
	}

	if err := h.ServiceProvider.Documents.NewFolder(name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleRevertPrompt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	log.Println("Reverting prompt:", id, r.URL.Query())
	if strings.HasPrefix(id, "prompt:") {
		name := strings.TrimPrefix(id, "prompt:")
		_ = h.ServiceProvider.Prompts.DeletePrompt(name)
		if h.EmitPromptsChanged != nil {
			h.EmitPromptsChanged()
		}
	}

	w.Header().Set("HX-Trigger", `{"prompts:changed": true, "notes:changed": true}`)
	w.WriteHeader(http.StatusNoContent)
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
}

func (h *ContextMenuHandler) handleMoveItem(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	targetFolder := r.URL.Query().Get("target")

	doc, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err == nil {
		if _, err := h.ServiceProvider.Documents.Move(doc, targetFolder); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}
