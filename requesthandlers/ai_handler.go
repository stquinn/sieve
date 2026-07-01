package requesthandlers

import (
	"encoding/json"
	"net/http"

	"sieve/sieve"
	"sieve/sieve/services"

	"github.com/go-chi/chi/v5"
)

type AiHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	EmitNotesChanged func()
	Broadcast        func(event, data string)
	JobTracker       *services.JobTracker
}

func (h *AiHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)

	r.Post("/api/ai/refine-language", h.handleRefineLanguage)
	r.Get("/api/ai/active-jobs", func(w http.ResponseWriter, r *http.Request) {
		if h.JobTracker != nil {
			h.JobTracker.ServeActiveJobs(w, r)
		} else {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jobs":[]}`))
		}
	})
	r.Get("/api/jobs", func(w http.ResponseWriter, r *http.Request) {
		if h.JobTracker != nil {
			h.JobTracker.ServeJobs(w, r)
		} else {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"active":[],"queued":[]}`))
		}
	})
}

// ack writes the fire-and-forget queued acknowledgement. The frontend
// (ai-actions.js saveAndPost) ignores the response body — the filing result
// reaches the UI via SSE (notes:changed for the moved doc, jobs:changed for the
// spinner), so these handlers only confirm the job was queued.
func (h *AiHandler) ack(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"queued":true}`))
}

func (h *AiHandler) handleAiSmartFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := h.ServiceProvider.Documents.LoadByUUID(id); err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}
	h.ServiceProvider.Editor.FileDocument(id)
	h.ack(w)
}

func (h *AiHandler) handleAiSmartMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if _, err := h.ServiceProvider.Documents.LoadByUUID(id); err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}
	h.ServiceProvider.Editor.UpdateMetadata(id)
	h.ack(w)
}

func (h *AiHandler) handleAiKeepAndFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uuid")
	doc, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	// user_intent is user-owned — set it here, in the explicit user-action handler.
	if _, err = h.ServiceProvider.Documents.SetUserIntent(doc, "keep"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	h.ServiceProvider.Editor.KeepAndFile(id)
	h.ack(w)
}

type refineLanguageRequest struct {
	Content string `json:"content"`
}

func (h *AiHandler) handleRefineLanguage(w http.ResponseWriter, r *http.Request) {
	var req refineLanguageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	lang, err := h.ServiceProvider.AI.RefineLanguage(req.Content, "", "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(lang))
}
