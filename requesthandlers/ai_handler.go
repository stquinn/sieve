package requesthandlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/aiblock"
	"sieve/store"
)

type AiHandler struct {
	ServiceProvider  *sieve.ServiceProvider
	EmitNotesChanged func()
	Broadcast        func(event, data string)
	JobTracker       *sieve.JobTracker
}

func (h *AiHandler) emitJobStarted(jobID, label, docID string, spinTab bool) {
	if h.JobTracker != nil {
		h.JobTracker.Start(sieve.JobInfo{JobID: jobID, Label: label, DocID: docID, SpinTab: spinTab})
	}
}

func (h *AiHandler) emitJobEnded(jobID, docID string) {
	if h.JobTracker != nil {
		h.JobTracker.End(jobID)
	}
}

func (h *AiHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/ai/smartFile/{id}", h.handleAiSmartFile)
	r.Post("/api/ai/smartMetadata/{id}", h.handleAiSmartMetadata)
	r.Post("/api/ai/keepAndFile/{uuid}", h.handleAiKeepAndFile)
	r.Post("/api/ai/ask", h.handleAiAsk)
	r.Post("/api/ai/explain", h.handleAiExplain)
	r.Post("/api/ai/refine-language", h.handleRefineLanguage)
	r.Get("/api/ai/active-jobs", func(w http.ResponseWriter, r *http.Request) {
		if h.JobTracker != nil {
			h.JobTracker.ServeActiveJobs(w, r)
		} else {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"jobs":[]}`))
		}
	})
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

	label := "Updating metadata..."
	if fileAfter {
		label = "Filing note..."
	}
	h.emitJobStarted(id, label, id, true)
	defer h.emitJobEnded(id, id)

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

type aiBlockRequest struct {
	Content       string   `json:"content"`
	History       string   `json:"history"`
	Question      string   `json:"question"`
	NoteUUID      string   `json:"noteUUID"`
	ImageBlockIds []string `json:"imageBlockIds"`
	ID            string   `json:"id"`  // optional: reuse existing block ID (retry path)
	Ref           string   `json:"ref"` // insertion anchor
}

type aiBlockResponse struct {
	ID    string `json:"id"`
	Fence string `json:"fence"`
}

func (h *AiHandler) handleAiAsk(w http.ResponseWriter, r *http.Request) {
	var req aiBlockRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.NoteUUID == "" {
		http.Error(w, "noteUUID is required", http.StatusBadRequest)
		return
	}

	blkID, fence := h.insertPendingBlock(req, "ASK")

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(aiBlockResponse{ID: blkID, Fence: fence})

	go h.runAiBlock(req.NoteUUID, blkID, "ASK", req.Content, req.History, req.Question, req.ImageBlockIds)
}

func (h *AiHandler) handleAiExplain(w http.ResponseWriter, r *http.Request) {
	var req aiBlockRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	if req.NoteUUID == "" {
		http.Error(w, "noteUUID is required", http.StatusBadRequest)
		return
	}

	blkID, fence := h.insertPendingBlock(req, "EXPLAIN")

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(aiBlockResponse{ID: blkID, Fence: fence})

	go h.runAiBlock(req.NoteUUID, blkID, "EXPLAIN", req.Content, req.History, req.Question, req.ImageBlockIds)
}

// insertPendingBlock writes the PENDING fence to disk and returns (blkID, fence).
// On the retry path (req.ID != ""), it skips insertion and returns the existing ID with empty fence.
func (h *AiHandler) insertPendingBlock(req aiBlockRequest, blockType string) (blkID, fence string) {
	if req.ID != "" {
		return req.ID, ""
	}

	blkID = fmt.Sprintf("ai-%s", randomHex(2))
	ref := req.Ref
	if ref == "" {
		ref = "doc"
	}
	pending := aiblock.AiBlockData{
		ID:        blkID,
		Ref:       ref,
		Status:    "PENDING",
		Type:      blockType,
		Question:  req.Question,
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	pendingYAML := aiblock.SerializeYAML(pending)
	fence = "```ai-block\n" + pendingYAML + "\n```"

	for attempt := 0; attempt < 3; attempt++ {
		doc, err := h.ServiceProvider.Documents.LoadByUUID(req.NoteUUID)
		if err != nil {
			logger.Error("insertPendingBlock: load failed", "err", err)
			break
		}
		docContent := string(doc.Body())
		newBody := aiblock.InsertAfterRef(docContent, req.Ref, fence)
		doc.SetBody([]byte(newBody))
		if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
			if errors.Is(err, store.ErrStaleStorable) {
				continue
			}
			logger.Error("insertPendingBlock: save failed", "err", err)
		}
		break
	}

	return blkID, fence
}

func (h *AiHandler) runAiBlock(uuid, blkID, blockType, content, history, question string, imageBlockIds []string) {
	label := "Asking AI..."
	if blockType == "EXPLAIN" {
		label = "Explaining..."
	}
	h.emitJobStarted(blkID, label, uuid, false)

	settings := h.ServiceProvider.State.LoadSettings()
	model := settings.Model

	var resp string
	var runErr error
	if blockType == "ASK" {
		resp, runErr = h.ServiceProvider.AI.RunAsk(content, history, question, uuid, imageBlockIds)
	} else {
		resp, runErr = h.ServiceProvider.AI.RunExplain(content, history, uuid, imageBlockIds)
	}

	var status, completedAt string
	if runErr != nil {
		if strings.Contains(runErr.Error(), "timeout") {
			status = "TIMEOUT"
		} else {
			status = "ERROR"
		}
		model = ""
		resp = ""
		h.resolveAiBlockStatus(uuid, blkID, status, blockType)
	} else {
		status = "COMPLETE"
		completedAt = time.Now().UTC().Format(time.RFC3339)
		if err := h.ServiceProvider.AI.ResolveAiBlock(uuid, blkID, resp, model, blockType); err != nil {
			logger.Error("runAiBlock: ResolveAiBlock failed", "id", blkID, "err", err)
		}
	}

	payload, _ := json.Marshal(map[string]string{
		"uuid":        uuid,
		"blkId":       blkID,
		"status":      status,
		"response":    resp,
		"model":       model,
		"completedAt": completedAt,
	})
	if h.Broadcast != nil {
		h.Broadcast("ai:block-resolved", string(payload))
	}

	// Emit ended after ai:block-resolved so the editor updates before the spinner clears.
	h.emitJobEnded(blkID, uuid)
}

// resolveAiBlockStatus updates a block to TIMEOUT or ERROR status in the document.
// Used when runAiBlock encounters an error (ResolveAiBlock only handles COMPLETE).
func (h *AiHandler) resolveAiBlockStatus(uuid, blkID, status, blockType string) {
	doc, err := h.ServiceProvider.Documents.LoadByUUID(uuid)
	if err != nil {
		logger.Error("resolveAiBlockStatus: load failed", "id", blkID, "err", err)
		return
	}
	body := string(doc.Body())
	blocks := aiblock.ParseAll(body)
	var found aiblock.AiBlockData
	for _, b := range blocks {
		if b.ID == blkID {
			found = b
			break
		}
	}
	if found.ID == "" {
		logger.Error("resolveAiBlockStatus: block not found", "id", blkID)
		return
	}
	found.Status = status
	if blockType != "" {
		found.Type = blockType
	}
	newBody, err := aiblock.Replace(body, found)
	if err != nil {
		logger.Error("resolveAiBlockStatus: replace failed", "id", blkID, "err", err)
		return
	}
	doc.SetBody([]byte(newBody))
	if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
		logger.Error("resolveAiBlockStatus: save failed", "id", blkID, "err", err)
	}
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


func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
