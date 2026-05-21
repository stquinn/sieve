package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sieve/logger"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type AiHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	EmitNotesChanged func()
	Broadcast        func(event, data string)
}

func (h *AiHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)
	r.Post("/api/ai/ask", h.handleAiAsk)
	r.Post("/api/ai/explain", h.handleAiExplain)
	r.Post("/api/ai/refine-language", h.handleRefineLanguage)
	r.Post("/api/ai/describe-image", h.handleDescribeImage)
	r.Get("/api/link-preview", h.handleLinkPreview)
}

func (h *AiHandler) handleAiSmartFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.evaluateAndFile(w, id, true, false)
}

func (h *AiHandler) handleAiSmartMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	h.evaluateAndFile(w, id, false, false)
}

func (h *AiHandler) handleAiKeepAndFile(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "uuid")
	doc, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	doc, err = h.ServiceProvider.Documents.SetUserIntent(doc, "keep")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Broadcast immediately so sidebar/meta panel reflect the keep intent
	// before the AI evaluation (~30s) completes.
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
	h.evaluateAndFile(w, id, true, false)
}

func (h *AiHandler) evaluateAndFile(w http.ResponseWriter, id string, fileAfter bool, allowDiscard bool) {

	_, err := h.ServiceProvider.Documents.LoadByUUID(id)
	if err != nil {
		http.Error(w, "document not found", http.StatusNotFound)
		return
	}

	outcome, err := h.ServiceProvider.AI.EvaluateAndFileDoc(id, fileAfter, allowDiscard)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	session := h.ServiceProvider.State.LoadSession()
	if !outcome.Discarded && outcome.Document != nil {
		for i := range session.Tabs {
			if session.Tabs[i].ID == id {
				session.Tabs[i].Status = outcome.Document.Meta().Status()
				session.Tabs[i].DisplayName = outcome.Document.Meta().DisplayName()
				if outcome.Document.Meta().UserIntent() != nil {
					session.Tabs[i].UserIntent = *outcome.Document.Meta().UserIntent()
				}
				break
			}
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	type EvaluateAndFileResult struct {
		Discarded bool           `json:"discarded"`
		Doc       sieve.Document `json:"doc"`
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(outcome)
	if h.EmitNotesChanged != nil {
		h.EmitNotesChanged()
	}
}

type askRequest struct {
	Content       string   `json:"content"`
	History       string   `json:"history"`
	Question      string   `json:"question"`
	NoteUUID      string   `json:"noteUUID"`
	ImageBlockIds []string `json:"imageBlockIds"`
	BlkID         string   `json:"blkId"`
	Body          string   `json:"body"`
}

func (h *AiHandler) handleAiAsk(w http.ResponseWriter, r *http.Request) {
	var req askRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Save body immediately so the PENDING block is on disk before AI runs.
	if req.BlkID != "" && req.Body != "" && req.NoteUUID != "" {
		if doc, err := h.ServiceProvider.Documents.LoadByUUID(req.NoteUUID); err == nil {
			doc.SetBody([]byte(req.Body))
			if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
				logger.Error("handleAiAsk: save body failed", "err", err)
			}
		}
	}

	resp, err := h.ServiceProvider.AI.RunAsk(req.Content, req.History, req.Question, req.NoteUUID, req.ImageBlockIds)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if req.BlkID != "" && req.NoteUUID != "" {
		if err := h.ServiceProvider.AI.ResolveAiBlock(req.NoteUUID, req.BlkID, resp, "", "ASK"); err != nil {
			logger.Error("handleAiAsk: ResolveAiBlock failed", "err", err)
		} else if h.Broadcast != nil {
			data, _ := json.Marshal(map[string]string{"uuid": req.NoteUUID, "blkId": req.BlkID})
			h.Broadcast("ai:block-resolved", string(data))
		}
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(resp))
}

type explainRequest struct {
	Content       string   `json:"content"`
	History       string   `json:"history"`
	NoteUUID      string   `json:"noteUUID"`
	ImageBlockIds []string `json:"imageBlockIds"`
	BlkID         string   `json:"blkId"`
	Body          string   `json:"body"`
}

func (h *AiHandler) handleAiExplain(w http.ResponseWriter, r *http.Request) {
	var req explainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Save body immediately so the PENDING block is on disk before AI runs.
	if req.BlkID != "" && req.Body != "" && req.NoteUUID != "" {
		if doc, err := h.ServiceProvider.Documents.LoadByUUID(req.NoteUUID); err == nil {
			doc.SetBody([]byte(req.Body))
			if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
				logger.Error("handleAiExplain: save body failed", "err", err)
			}
		}
	}

	resp, err := h.ServiceProvider.AI.RunExplain(req.Content, req.History, req.NoteUUID, req.ImageBlockIds)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if req.BlkID != "" && req.NoteUUID != "" {
		if err := h.ServiceProvider.AI.ResolveAiBlock(req.NoteUUID, req.BlkID, resp, "", "EXPLAIN"); err != nil {
			logger.Error("handleAiExplain: ResolveAiBlock failed", "err", err)
		} else if h.Broadcast != nil {
			data, _ := json.Marshal(map[string]string{"uuid": req.NoteUUID, "blkId": req.BlkID})
			h.Broadcast("ai:block-resolved", string(data))
		}
	}

	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(resp))
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
	lang, err := h.ServiceProvider.AI.RefineLanguage(req.Content)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(lang))
}

type describeImageRequest struct {
	UUID string `json:"uuid"`
	Path string `json:"path"`
	ID   string `json:"id"`
}

func (h *AiHandler) handleDescribeImage(w http.ResponseWriter, r *http.Request) {
	var req describeImageRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	desc, err := h.ServiceProvider.AI.DescribeImage(req.UUID, req.Path, req.ID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(desc)
}

func (h *AiHandler) handleLinkPreview(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		http.Error(w, "url required", http.StatusBadRequest)
		return
	}
	title, err := h.ServiceProvider.AI.GetLinkTitle(url)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "text/plain")
	w.Write([]byte(title))
}
