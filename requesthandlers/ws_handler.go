package requesthandlers

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"

	"sieve/logger"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

// WsHandler manages one persistent WebSocket connection per open document.
// It dispatches incoming messages to EditorService and sends acks back.
type WsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	upgrader        websocket.Upgrader
}

func NewWsHandler(sp *sieve.ServiceProvider) *WsHandler {
	return &WsHandler{
		ServiceProvider: sp,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}
}

func (h *WsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/ws", h.handleWS)
}

func (h *WsHandler) handleWS(w http.ResponseWriter, r *http.Request) {
	uuid := r.URL.Query().Get("uuid")
	if uuid == "" {
		http.Error(w, "uuid required", http.StatusBadRequest)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("ws: upgrade failed", "uuid", uuid, "err", err)
		return
	}
	defer conn.Close()

	// gorilla/websocket allows one concurrent writer — protect with a mutex so
	// the debounce goroutine and the message-loop goroutine don't race.
	var writeMu sync.Mutex
	writeMsg := func(v interface{}) {
		data, err := json.Marshal(v)
		if err != nil {
			return
		}
		writeMu.Lock()
		_ = conn.WriteMessage(websocket.TextMessage, data)
		writeMu.Unlock()
	}

	notifySaved := func() {
		writeMsg(map[string]string{"type": "flush-ack", "uuid": uuid})
	}

	logger.Info("ws: connection established", "uuid", uuid)
	if err := h.ServiceProvider.Editor.Open(uuid, notifySaved); err != nil {
		logger.Warn("ws: could not open shadow", "uuid", uuid, "err", err)
	}
	defer h.ServiceProvider.Editor.Close(uuid)
	defer logger.Info("ws: connection closed", "uuid", uuid)

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "doc-update":
			h.handleDocUpdate(uuid, raw)
		case "block-update":
			h.handleBlockUpdate(uuid, raw, writeMsg)
		case "create-block":
			h.handleCreateBlock(uuid, raw, writeMsg)
		case "smart-paste":
			h.handlePaste(uuid, raw, writeMsg)
		case "flush":
			h.handleFlush(writeMsg, uuid)
		case "enter-markdown":
			h.handleEnterMarkdown(writeMsg, uuid)
		case "enter-wysiwyg":
			h.handleEnterWysiwyg(uuid)
		case "retry-block-job":
			h.handleRetryBlockJob(uuid, raw, writeMsg)
		}
	}
}

func (h *WsHandler) handleDocUpdate(uuid string, raw []byte) {
	var msg struct {
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	h.ServiceProvider.Editor.UpdateMarkdown(uuid, msg.Markdown)
}

// handleBlockUpdate merges the user's attr patch into the shadow, then calls
// OnUpdate on the processor so it can re-run heuristics or schedule a RunJob.
func (h *WsHandler) handleBlockUpdate(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		ID    string                 `json:"id"`
		Kind  string                 `json:"kind"`
		Attrs map[string]interface{} `json:"attrs"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	h.ServiceProvider.Editor.HandleBlockUpdate(uuid, msg.Kind, msg.ID, msg.Attrs, func(blkID, rawYaml string) {
		writeMsg(map[string]string{
			"type":    "block-attrs-updated",
			"id":      blkID,
			"rawYaml": rawYaml,
		})
	})
}

func (h *WsHandler) handleFlush(writeMsg func(interface{}), uuid string) {
	_ = h.ServiceProvider.Editor.Flush(uuid)
	writeMsg(map[string]string{"type": "flush-ack", "uuid": uuid})
}

// handleEnterMarkdown embeds current block state into Markdown, sets mode = markdown,
// and returns merged content to JS as the seed for the markdown editor.
func (h *WsHandler) handleEnterMarkdown(writeMsg func(interface{}), uuid string) {
	merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
	h.persistTabMode(uuid, "markdown")
	writeMsg(map[string]string{
		"type":     "markdown-content",
		"uuid":     uuid,
		"markdown": merged,
	})
}

// handleEnterWysiwyg re-parses shadow.Blocks from shadow.Markdown and sets mode = wysiwyg.
func (h *WsHandler) handleEnterWysiwyg(uuid string) {
	h.ServiceProvider.Editor.EnterWysiwyg(uuid)
	h.persistTabMode(uuid, "wysiwyg")
}

// persistTabMode updates the session tab's mode field so the tab bar renders correctly.
func (h *WsHandler) persistTabMode(uuid, mode string) {
	if h.ServiceProvider.State == nil {
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	for i, t := range session.Tabs {
		if t.ID == uuid {
			session.Tabs[i].Mode = mode
			break
		}
	}
	_ = h.ServiceProvider.State.SaveSession(session)
}

// handleCreateBlock is the primary UI-triggered block creation path.
// JS sends this when the user uses a keyboard shortcut, toolbar button, or command.
func (h *WsHandler) handleCreateBlock(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.Kind == "" {
		return
	}
	id, rawYaml, err := h.ServiceProvider.Editor.CreateBlock(uuid, msg.Kind, nil)
	if err != nil {
		logger.Warn("ws: create-block failed", "uuid", uuid, "kind", msg.Kind, "err", err)
		return
	}
	writeMsg(map[string]string{
		"type":    "insert-block",
		"kind":    msg.Kind,
		"id":      id,
		"rawYaml": rawYaml,
	})
	go h.ServiceProvider.Editor.RunJob(context.Background(), uuid, id, func(blkID, updatedRawYaml string) {
		writeMsg(map[string]string{
			"type":    "block-attrs-updated",
			"id":      blkID,
			"rawYaml": updatedRawYaml,
		})
	})
}

func (h *WsHandler) handleRetryBlockJob(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.ID == "" {
		return
	}
	go h.ServiceProvider.Editor.RunJob(context.Background(), uuid, msg.ID, func(blkID, rawYaml string) {
		writeMsg(map[string]string{
			"type":    "block-attrs-updated",
			"id":      blkID,
			"rawYaml": rawYaml,
		})
	})
}

func (h *WsHandler) handlePaste(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	kind, id, rawYaml, matched := h.ServiceProvider.Editor.HandlePaste(uuid, []sieve.PasteEntry{{MIMEType: "text/plain", Content: msg.Content}})
	if !matched {
		// No processor claimed this paste — tell JS to fall back to normal insertion.
		writeMsg(map[string]string{"type": "paste-no-match", "uuid": uuid})
		return
	}

	writeMsg(map[string]string{
		"type":    "insert-block",
		"kind":    kind,
		"id":      id,
		"rawYaml": rawYaml,
	})
	go h.ServiceProvider.Editor.RunJob(context.Background(), uuid, id, func(blkID, updatedRawYaml string) {
		writeMsg(map[string]string{
			"type":    "block-attrs-updated",
			"id":      blkID,
			"rawYaml": updatedRawYaml,
		})
	})
}
