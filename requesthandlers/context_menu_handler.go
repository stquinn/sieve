package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"strings"

	"github.com/go-chi/chi/v5"
)

type ContextMenuHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	// EmitContainerDeleted announces one accomplished deletion by uuid. Deleting
	// a folder deletes every container under it, so this fires once per
	// container — see handleFolderDelete.
	EmitContainerDeleted func(uuid string)
	EmitSessionChanged   func()
	EmitNotesChanged     func()
	EmitPromptsChanged   func()
	// EmitIntentChanged announces that some document's user_intent changed. It is
	// its own topic rather than a flavour of notes: the tree is unaffected, and
	// the only view that restates an intent is the meta panel.
	EmitIntentChanged func()
}

// RegisterPaths mounts the folder's lifecycle and the sidebar item actions that
// are not a note's own (intent, move, revert). The three confirm/entry dialogs
// share ONE route: which dialog is a parameter, because they differ only in the
// template they render.
func (h *ContextMenuHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/sidebar/dialog/{kind}", h.handleDialog)
	r.Post("/api/folder", h.handleFolderCreate)
	r.Patch("/api/folder/{id}", h.handleFolderPatch)
	r.Delete("/api/folder/{id}", h.handleFolderDelete)
	r.Post("/api/sidebar/intent", h.handleIntent)
	r.Post("/api/sidebar/revert-prompt", h.handleRevertPrompt)
	r.Post("/api/sidebar/move", h.handleMoveItem)
}

// ── Actions → return refreshed sidebar ───────────────────────────────────────

func (h *ContextMenuHandler) handleIntent(w http.ResponseWriter, r *http.Request) {

	id := r.URL.Query().Get("id")
	value := r.URL.Query().Get("value")

	// A failed load used to fall THROUGH: the intent was silently not written, and
	// the tab loop below then dereferenced the nil document — so a request naming
	// an unknown uuid that also matched an open tab id crashed the handler (#92).
	// Nothing was ever accomplished down that path, so say so instead.
	doc, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if _, err := h.ServiceProvider.Documents.SetUserIntent(doc, value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	for i := range session.Tabs {
		if session.Tabs[i].ID == id {

			status := "unfiled"
			if doc.Kind() == domain.KindNote {
				status = "filed"
			}
			session.Tabs[i].Status = status
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
	if h.EmitIntentChanged != nil {
		h.EmitIntentChanged()
	}
	w.Header().Set("HX-Trigger", fmt.Sprintf(`{"intent:changed": {"uuid": "%s"}, "notes:changed": true}`, id))
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleFolderCreate(w http.ResponseWriter, r *http.Request) {
	req, err := requestBody{r}.folderCreate()
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if err := h.ServiceProvider.Documents.NewFolder(req.Name); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.notesChanged(w)
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

// handleFolderPatch changes a folder's properties: its name, its expanded
// state, or both in one request. Open is a folder property, so it is patched
// like any other rather than hidden in a sidebar query parameter.
func (h *ContextMenuHandler) handleFolderPatch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	req, err := requestBody{r}.folderPatch()
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if req.Name != nil {
		if err := h.ServiceProvider.Documents.RenameFolder(id, *req.Name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		h.notesChanged(w)
	}
	if req.Open != nil {
		session := h.ServiceProvider.State.LoadSession()
		session.SetFolderOpen(id, *req.Open)
		_ = h.ServiceProvider.State.SaveSession(session)
	}
	RenderSidebar(w, h.ServiceProvider.Documents, h.ServiceProvider.State, h.Tmpl)
}

func (h *ContextMenuHandler) handleFolderDelete(w http.ResponseWriter, r *http.Request) {
	deleted, err := h.ServiceProvider.Documents.DeleteFolder(chi.URLParam(r, "id"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// Deleting the folder deleted every document under it. Each is announced by
	// uuid so clients reconcile: a note open in a tab has no other way to learn
	// its document ceased to exist.
	if h.EmitContainerDeleted != nil {
		for _, uuid := range deleted {
			h.EmitContainerDeleted(uuid)
		}
	}

	// A folder delete answers with the whole workspace, not just the tree it
	// visibly changed, because those broadcasts have just told every client to
	// destroy the editors behind the deleted documents. If the ACTIVE note was
	// one of them, the sidebar alone would leave the window with a torn-down
	// editor and no mount to replace it — a blank dead end. The note delete
	// answers the same shape for the same reason, through the same seam.
	h.deletionReconciler().reconcile(w, deleted...)
}

// deletionReconciler builds the shared second half of a deletion from this
// handler's own dependencies — see NoteHandler.deletionReconciler.
func (h *ContextMenuHandler) deletionReconciler() deletionReconciler {
	return deletionReconciler{
		sp:                 h.ServiceProvider,
		tmpl:               h.Tmpl,
		emitSessionChanged: h.EmitSessionChanged,
		emitNotesChanged:   h.EmitNotesChanged,
	}
}

// notesChanged announces a changed note tree both ways: the header htmx reads
// and the push every other client listens on. It must run before the fragment
// is written, because a header set after the body is lost.
func (h *ContextMenuHandler) notesChanged(w http.ResponseWriter) {
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	w.Header().Set("HX-Trigger", "notes:changed")
}

// handleDialog renders one of the sidebar's dialogs. They differ only in their
// template and in which of the four parameters that template reads, so they are
// one route with the dialog as a parameter — an unknown kind is a 404 rather
// than an empty dialog.
func (h *ContextMenuHandler) handleDialog(w http.ResponseWriter, r *http.Request) {
	templates := map[string]string{
		"create-folder": "create_folder.html",
		"delete":        "delete.html",
		"rename":        "rename.html",
	}
	name, known := templates[chi.URLParam(r, "kind")]
	if !known {
		http.NotFound(w, r)
		return
	}

	query := r.URL.Query()
	data := struct {
		ID       string
		Name     string
		Type     string
		ParentID string
		// Contents is what a folder delete would take with it (#89). The delete is
		// os.RemoveAll and enumerates nothing, so the dialog has to be told before
		// it asks — a confirmation that cannot name what it destroys is not one.
		Contents services.FolderContents
	}{
		ID:       query.Get("id"),
		Name:     query.Get("name"),
		Type:     query.Get("type"),
		ParentID: query.Get("parentId"),
	}
	if name == "delete.html" && data.Type == "folder" {
		// A folder that cannot be read is still deletable, and the zero count reads
		// as empty — which is the LEAST alarming wording. Refuse rather than
		// under-state what is at stake.
		contents, err := h.ServiceProvider.Documents.FolderContents(data.ID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		data.Contents = contents
	}
	if err := h.Tmpl.ExecuteTemplate(w, name, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *ContextMenuHandler) handleRevertPrompt(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	logger.Info("revert prompt", "id", id)
	if strings.HasPrefix(id, "prompt:") {
		name := strings.TrimPrefix(id, "prompt:")
		// A failed revert announces NOTHING — the same doctrine a failed save
		// follows: the news is that something HAPPENED, so absence is the honest
		// signal when it did not. Emitting anyway would have every client refetch
		// a prompt library that still holds the override.
		if err := h.ServiceProvider.Prompts.DeletePrompt(name); err != nil {
			logger.Warn("revert prompt failed", "id", id, "err", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
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
