package requesthandlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"sieve/logger"
	"sieve/sieve"
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

	if err := h.ServiceProvider.Editor.Open(uuid); err != nil {
		logger.Warn("ws: could not open shadow", "uuid", uuid, "err", err)
	}
	defer h.ServiceProvider.Editor.Close(uuid)

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
			h.handleBlockUpdate(uuid, raw)
		case "flush":
			h.handleFlush(conn, uuid)
		case "enter-markdown":
			h.handleEnterMarkdown(conn, uuid)
		case "enter-wysiwyg":
			h.handleEnterWysiwyg(uuid)
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

func (h *WsHandler) handleBlockUpdate(uuid string, raw []byte) {
	var msg struct {
		ID    string                 `json:"id"`
		Kind  string                 `json:"kind"`
		Attrs map[string]interface{} `json:"attrs"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	h.ServiceProvider.Editor.UpdateBlock(uuid, msg.Kind, msg.ID, msg.Attrs)
}

func (h *WsHandler) handleFlush(conn *websocket.Conn, uuid string) {
	_ = h.ServiceProvider.Editor.Flush(uuid)
	ack, _ := json.Marshal(map[string]string{"type": "flush-ack", "uuid": uuid})
	_ = conn.WriteMessage(websocket.TextMessage, ack)
}

// handleEnterMarkdown: embed current block state into Markdown, set mode = markdown,
// return merged content to JS as the seed for the markdown editor.
func (h *WsHandler) handleEnterMarkdown(conn *websocket.Conn, uuid string) {
	merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
	resp, _ := json.Marshal(map[string]string{
		"type":     "markdown-content",
		"uuid":     uuid,
		"markdown": merged,
	})
	_ = conn.WriteMessage(websocket.TextMessage, resp)
}

// handleEnterWysiwyg: re-parse shadow.Blocks from shadow.Markdown, set mode = wysiwyg.
func (h *WsHandler) handleEnterWysiwyg(uuid string) {
	h.ServiceProvider.Editor.EnterWysiwyg(uuid)
}
