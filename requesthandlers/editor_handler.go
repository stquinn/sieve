package requesthandlers

import (
	"encoding/json"
	"html/template"
	"net/http"
	"strings"

	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type EditorHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	Broadcast       func(event, data string)
}

type editorShellData struct {
	UUID string
	Mode string
}

func (h *EditorHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/editor", h.handleEditorShell)
	r.Get("/api/editor/load", h.handleEditorLoad)
	r.Post("/api/editor/save", h.handleEditorSave)
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

func (h *EditorHandler) handleEditorLoad(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	type loadResponse struct {
		Body string `json:"body"`
		Mode string `json:"mode"`
		Path string `json:"path"`
	}

	if strings.HasPrefix(uuid, "prompt:") {
		name := strings.TrimPrefix(uuid, "prompt:")
		if body, err := h.ServiceProvider.Prompts.GetPromptContent(name); err == nil {
			json.NewEncoder(w).Encode(loadResponse{Body: body, Mode: "markdown", Path: uuid})
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if b, err := h.ServiceProvider.Buffers.LoadByUUID(uuid); err == nil {
		mode := b.Meta().All()["mode"]
		if mode == "" {
			mode = "wysiwyg"
		}
		json.NewEncoder(w).Encode(loadResponse{Body: string(b.Body()), Mode: mode, Path: b.Path()})
		return
	}

	if n, err := h.ServiceProvider.Notes.LoadByUUID(uuid); err == nil {
		mode := n.Meta().All()["mode"]
		if mode == "" {
			mode = "wysiwyg"
		}
		json.NewEncoder(w).Encode(loadResponse{Body: string(n.Body()), Mode: mode, Path: n.Path()})
		return
	}
	json.NewEncoder(w).Encode(loadResponse{Body: "", Mode: "wysiwyg", Path: ""})
}

func (h *EditorHandler) handleEditorSave(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	if strings.HasPrefix(uuid, "prompt:") {
		name := strings.TrimPrefix(uuid, "prompt:")

		if err := h.ServiceProvider.Prompts.SavePrompt(name, req.Body); err == nil {
			if h.Broadcast != nil {
				h.Broadcast("prompts:changed", "{}")
			}
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]int{"version": 0})
			return
		}

		http.Error(w, "save failed", http.StatusInternalServerError)
		return
	}

	if b, err := h.ServiceProvider.Buffers.LoadByUUID(uuid); err == nil {
		b.SetBody([]byte(req.Body))
		if saved, err := h.ServiceProvider.Buffers.Save(b); err == nil {
			json.NewEncoder(w).Encode(map[string]int{"version": saved.Meta().Version()})
			return
		}
	}
	if n, err := h.ServiceProvider.Notes.LoadByUUID(uuid); err == nil {
		n.SetBody([]byte(req.Body))
		if saved, err := h.ServiceProvider.Notes.Save(n); err == nil {
			json.NewEncoder(w).Encode(map[string]int{"version": saved.Meta().Version()})
			return
		}
	}
	http.Error(w, "save failed", http.StatusInternalServerError)
}
