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
	r.Post("/api/editor/smart-paste", h.handleSmartPaste)
	r.Post("/api/detect-extractions", h.handleDetectExtractions)
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
		Body   string                `json:"body"`
		Mode   string                `json:"mode"`
		UUID   string                `json:"uuid"`
		Blocks []sieve.FrontendBlock `json:"blocks,omitempty"`
	}

	if strings.HasPrefix(uuid, "prompt:") {
		name := strings.TrimPrefix(uuid, "prompt:")
		if body, err := h.ServiceProvider.Prompts.GetPromptContent(name); err == nil {
			json.NewEncoder(w).Encode(loadResponse{Body: body, Mode: "markdown", UUID: uuid})
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	if b, err := h.ServiceProvider.Documents.LoadByUUID(uuid); err == nil {
		mode := b.Meta().All()["mode"]
		if mode == "" {
			mode = "wysiwyg"
		}
		body := string(b.Body())
		resp := loadResponse{Body: body, Mode: mode, UUID: b.UUID()}
		// WYSIWYG renders from the block list (Stage D.2). Load THROUGH the shadow
		// (identity step): ensure the shadow is open — minting prose handles — and
		// return its blocks, so the editor and shadow share identity (anchors get a
		// real data-id, the sync cache is seeded). Open is idempotent, so the WS
		// connection that follows reuses this same shadow. Markdown mode keeps
		// serving raw body only; the client never builds blocks there.
		if mode != "markdown" {
			_ = h.ServiceProvider.Editor.Open(uuid, nil)
			if blocks, ok := h.ServiceProvider.Editor.FrontendBlocks(uuid); ok {
				resp.Blocks = blocks
			}
		}
		json.NewEncoder(w).Encode(resp)
		return
	}
	json.NewEncoder(w).Encode(loadResponse{Body: "", Mode: "wysiwyg", UUID: ""})
}

func (h *EditorHandler) handleEditorSave(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")

	var req struct {
		Body string `json:"body"`
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	// Update session tab mode if present
	session := h.ServiceProvider.State.LoadSession()
	for i, t := range session.Tabs {
		if t.ID == uuid {
			if req.Mode != "" {
				session.Tabs[i].Mode = req.Mode
			}
			break
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

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

	if b, err := h.ServiceProvider.Documents.LoadByUUID(uuid); err == nil {
		b.SetBody([]byte(req.Body))
		if req.Mode != "" {
			b.Meta().SetMode(req.Mode)
		}
		if saved, err := h.ServiceProvider.Documents.Save(b); err == nil {
			json.NewEncoder(w).Encode(map[string]int{"version": saved.Meta().Version()})
			return
		}
	}

	http.Error(w, "save failed", http.StatusInternalServerError)
}

func (h *EditorHandler) handleSmartPaste(w http.ResponseWriter, r *http.Request) {
	var req struct {
		UUID    string             `json:"uuid"`
		Entries []sieve.ContentEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UUID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	kind, id, rawYaml, matched := h.ServiceProvider.Editor.HandlePaste(req.UUID, req.Entries)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Matched bool   `json:"matched"`
		Kind    string `json:"kind,omitempty"`
		ID      string `json:"id,omitempty"`
		RawYaml string `json:"rawYaml,omitempty"`
	}{
		Matched: matched,
		Kind:    kind,
		ID:      id,
		RawYaml: rawYaml,
	})
}

func (h *EditorHandler) handleDetectExtractions(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SourceKind string               `json:"sourceKind"`
		Entries    []sieve.ContentEntry `json:"entries"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	candidates := sieve.DetectExtractions(req.SourceKind, req.Entries)
	if candidates == nil {
		candidates = []sieve.ExtractionCandidate{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(candidates)
}
