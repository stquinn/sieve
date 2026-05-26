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
	"sieve/sieve/webclip"
	"sieve/store"
)

func randomHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type InternalizeHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Broadcast       func(event, data string)
}

func (h *InternalizeHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/internalize", h.handleInternalize)
}

type internalizeRequest struct {
	UUID   string `json:"uuid"`
	Source string `json:"source"`
	Mode   string `json:"mode"`
}

type internalizeResponse struct {
	ID    string `json:"id"`
	Fence string `json:"fence"` // complete fenced block including backticks, Go-generated
}

func (h *InternalizeHandler) handleInternalize(w http.ResponseWriter, r *http.Request) {
	var req internalizeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	if req.UUID == "" || req.Source == "" {
		http.Error(w, "uuid and source are required", http.StatusBadRequest)
		return
	}
	if req.Mode != "fetch" && req.Mode != "summarise" {
		req.Mode = "fetch"
	}

	// Generate the PENDING block. Go owns all YAML generation.
	blkID := fmt.Sprintf("wc-%s", randomHex(6))
	pending := webclip.WebClipData{
		ID:        blkID,
		Source:    req.Source,
		Mode:      req.Mode,
		Status:    "PENDING",
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	pendingYAML := webclip.SerializeYAML(pending)
	fence := "```web-clip\n" + pendingYAML + "\n```"

	// Load current body (docContent for Summarise), append PENDING block, save.
	var docContent string
	for attempt := 0; attempt < 3; attempt++ {
		doc, err := h.ServiceProvider.Documents.LoadByUUID(req.UUID)
		if err != nil {
			logger.Error("handleInternalize: load failed", "err", err)
			break
		}
		docContent = string(doc.Body())
		newBody := strings.TrimRight(docContent, "\n") + "\n\n" + fence + "\n"
		doc.SetBody([]byte(newBody))
		if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
			if errors.Is(err, store.ErrStaleStorable) {
				continue
			}
			logger.Error("handleInternalize: save failed", "err", err)
		}
		break
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(internalizeResponse{ID: blkID, Fence: fence})

	go h.runInBackground(req.UUID, blkID, req.Source, req.Mode, docContent)
}

func (h *InternalizeHandler) runInBackground(uuid, id, source, mode, docContent string) {
	settings := h.ServiceProvider.State.LoadSettings()
	model := settings.Model

	title, content, cliErr := h.ServiceProvider.AI.RunWebClip(uuid, id, source, mode, docContent)

	var status, errMsg, completedAt string
	if cliErr != nil {
		if strings.Contains(cliErr.Error(), "timeout") {
			status = "TIMEOUT"
		} else {
			status = "ERROR"
			errMsg = "Claude could not retrieve this page. Check that your MCP configuration can access this URL."
			model = ""
		}
		title = ""
		content = ""
	} else {
		status = "COMPLETE"
		completedAt = time.Now().UTC().Format(time.RFC3339)
	}

	if err := h.ServiceProvider.AI.ResolveWebClip(uuid, id, title, content, model, errMsg, status, completedAt); err != nil {
		logger.Error("handleInternalize: ResolveWebClip failed", "id", id, "err", err)
	}

	payload, _ := json.Marshal(map[string]string{
		"uuid":        uuid,
		"blkId":       id,
		"status":      status,
		"title":       title,
		"content":     content,
		"model":       model,
		"completedAt": completedAt,
		"error":       errMsg,
	})
	if h.Broadcast != nil {
		h.Broadcast("ai:web-clip-resolved", string(payload))
	}
}
