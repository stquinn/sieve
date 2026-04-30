package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type AiHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	EmitNotesChanged func()
}

func (h *AiHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)
	r.Post("/api/ai/ask", h.handleAiAsk)
	r.Post("/api/ai/explain", h.handleAiExplain)
}

func (h *AiHandler) handleAiSmartFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.evaluateAndFile(w, id, true, true)
}

func (h *AiHandler) handleAiSmartMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.evaluateAndFile(w, id, false, false)
}

func (h *AiHandler) handleAiKeepAndFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uuid")

	buffers := *h.ServiceProvider.Buffers
	notes := *h.ServiceProvider.Notes

	if buf, err := buffers.LoadByUUID(id); err == nil {
		intent := "keep"
		buf.Meta().SetUserIntent(&intent)
		if _, err := buffers.Save(buf); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else if note, err := notes.LoadByUUID(id); err == nil {
		intent := "keep"
		note.Meta().SetUserIntent(&intent)
		if _, err := notes.Save(note); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	} else {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	h.evaluateAndFile(w, id, true, false)
}

func (h *AiHandler) evaluateAndFile(w http.ResponseWriter, id string, fileAfter bool, allowDiscard bool) {
	var path string
	if buf, err := h.ServiceProvider.Buffers.LoadByUUID(id); err == nil {
		path = buf.Path()
	} else if note, err := h.ServiceProvider.Notes.LoadByUUID(id); err == nil {
		path = note.Path()
	} else {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	outcome, err := h.ServiceProvider.AI.EvaluateAndFileDoc(path, fileAfter, allowDiscard)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.ServiceProvider.State.LoadSession()
	for i := range session.Tabs {
		if session.Tabs[i].ID == id {
			if outcome.Buffer != nil {
				session.Tabs[i].Status = outcome.Buffer.Meta().Status()
				session.Tabs[i].DisplayName = outcome.Buffer.Meta().DisplayName()
				if outcome.Buffer.Meta().UserIntent() != nil {
					session.Tabs[i].UserIntent = *outcome.Buffer.Meta().UserIntent()
				}
			} else if outcome.Note != nil {
				session.Tabs[i].Status = outcome.Note.Meta().Status()
				session.Tabs[i].DisplayName = outcome.Note.Meta().DisplayName()
				if outcome.Note.Meta().UserIntent() != nil {
					session.Tabs[i].UserIntent = *outcome.Note.Meta().UserIntent()
				}
			}
			break
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	type EvaluateAndFileResult struct {
		Discarded bool        `json:"discarded"`
		Doc       interface{} `json:"doc"`
	}

	var doc interface{}
	if outcome.Buffer != nil {
		doc = map[string]interface{}{
			"kind":     "buffer",
			"uuid":     outcome.Buffer.UUID(),
			"path":     outcome.Buffer.Path(),
			"slug":     outcome.Buffer.Slug(),
			"body":     string(outcome.Buffer.Body()),
			"meta":     outcome.Buffer.Meta().All(),
			"versions": outcome.Buffer.Versions(),
		}
	} else if outcome.Note != nil {
		doc = map[string]interface{}{
			"kind":     "note",
			"uuid":     outcome.Note.UUID(),
			"path":     outcome.Note.Path(),
			"slug":     outcome.Note.Slug(),
			"body":     string(outcome.Note.Body()),
			"meta":     outcome.Note.Meta().All(),
			"versions": outcome.Note.Versions(),
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(EvaluateAndFileResult{
		Discarded: outcome.Discarded,
		Doc:       doc,
	})
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
}

type askRequest struct {
	Content         string   `json:"content"`
	History         string   `json:"history"`
	Question        string   `json:"question"`
	NotePath        string   `json:"notePath"`
	ImageStorePaths []string `json:"imageStorePaths"`
}

func (h *AiHandler) handleAiAsk(w http.ResponseWriter, r *http.Request) {
	var req askRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	resp, err := h.ServiceProvider.AI.RunAsk(req.Content, req.History, req.Question, req.NotePath, req.ImageStorePaths)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(resp))
}

type explainRequest struct {
	Content         string   `json:"content"`
	History         string   `json:"history"`
	NotePath        string   `json:"notePath"`
	ImageStorePaths []string `json:"imageStorePaths"`
}

func (h *AiHandler) handleAiExplain(w http.ResponseWriter, r *http.Request) {
	var req explainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	resp, err := h.ServiceProvider.AI.RunExplain(req.Content, req.History, req.NotePath, req.ImageStorePaths)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(resp))
}
