package requesthandlers

import (
	"encoding/json"
	"html/template"
	"net/http"
	"strings"

	"sieve/sieve"
	"sieve/sieve/protocol"

	"github.com/go-chi/chi/v5"
)

type EditorHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	// EmitContainerSaved announces that a container's content reached disk. A
	// prompt is the ONE container whose write does not funnel through
	// EditorService's flush chokepoint — it has no shadow — so this is the second
	// and only other emission site for the fact.
	EmitContainerSaved func(uuid string, version int)
	EmitPromptsChanged func()
}

type editorShellData struct {
	UUID string
	Mode string
}

// RegisterPaths mounts the editor shell fragment and the CHANNEL-LESS document
// pair. Loading, saving, exporting and pasting a note all ride its document
// channel; a prompt pseudo-document opens none, so its read and its write stay
// here.
func (h *EditorHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/editor", h.handleEditorShell)
	r.Get("/api/document/load", h.handleDocumentLoad)
	r.Post("/api/document/save", h.handleDocumentSave)
}

func (h *EditorHandler) handleEditorShell(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	mode := r.URL.Query().Get("mode")
	if mode == "" {
		mode = "wysiwyg"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "editor.html", editorShellData{UUID: uuid, Mode: mode}); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleDocumentLoad serves a PROMPT pseudo-document's content: it opens no
// document channel, so it has no load frame to ask along. A note is refused
// here rather than served twice — its channel is the one way it loads.
func (h *EditorHandler) handleDocumentLoad(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	w.Header().Set("Cache-Control", "no-store")
	if !strings.HasPrefix(uuid, "prompt:") {
		http.Error(w, "documents load over their document channel", http.StatusBadRequest)
		return
	}
	content, ok := documentContent{sp: h.ServiceProvider}.read(uuid)
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(content)
}

// handleDocumentSave writes a PROMPT pseudo-document's buffer, the write half of
// handleDocumentLoad's pair. A note is refused here for the same reason it is
// refused there, and one sharper: its live shadow is the authority on its
// content, so a raw store write behind that shadow's back is silently reverted
// by the next flush.
func (h *EditorHandler) handleDocumentSave(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	var req protocol.DocumentSaveRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// The document travels as a query parameter, not a body field.
	req.UUID = r.URL.Query().Get("uuid")
	name, isPrompt := strings.CutPrefix(req.UUID, "prompt:")
	if !isPrompt {
		http.Error(w, "documents save over their document channel", http.StatusBadRequest)
		return
	}

	h.recordTabMode(req.UUID, req.Mode)

	if err := h.ServiceProvider.Prompts.SavePrompt(name, req.Body); err != nil {
		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}
	// Version 0, here and in the response below, is the truth and not a placeholder:
	// a prompt override is a plain file the store writes with no metadata and no
	// version history, so there is no number to report. The saved-fact's listeners
	// read 0 as "this container cannot order its saves".
	if h.EmitContainerSaved != nil {
		h.EmitContainerSaved(req.UUID, 0)
	}
	if h.EmitPromptsChanged != nil {
		h.EmitPromptsChanged()
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(protocol.DocumentSaveResponse{Version: 0})
}

// recordTabMode remembers which mode saved the tab, so the tab bar renders it
// the same way on the next session restore. An empty mode, or a uuid no open tab
// carries, leaves the session alone.
func (h *EditorHandler) recordTabMode(uuid, mode string) {
	if mode == "" || h.ServiceProvider.State == nil {
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	for i, t := range session.Tabs {
		if t.ID == uuid {
			session.Tabs[i].Mode = mode
			_ = h.ServiceProvider.State.SaveSession(session)
			return
		}
	}
}
