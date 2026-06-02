package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sync"

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

	// gorilla/websocket allows one concurrent writer — protect with a mutex so
	// the debounce goroutine and the message-loop goroutine don't race.
	var writeMu sync.Mutex
	write := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			logger.Debug("ws: write failed", "uuid", uuid, "err", err)
		}
	}

	notifySaved := func() {
		ack, _ := json.Marshal(map[string]string{"type": "flush-ack", "uuid": uuid})
		write(ack)
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
			h.handleBlockUpdate(uuid, raw)
		case "flush":
			h.handleFlush(write, uuid)
		case "enter-markdown":
			h.handleEnterMarkdown(write, uuid)
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

// handleBlockUpdate merges per-block attr updates into the shadow so Remux can
// substitute authoritative YAML over TipTap's potentially-stale rawYaml.
// TODO: no JS sender yet — shadow.Blocks is always empty during WYSIWYG editing
// until TipTap block extensions are updated to emit block-update messages.
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

func (h *WsHandler) handleFlush(write func([]byte), uuid string) {
	_ = h.ServiceProvider.Editor.Flush(uuid)
	ack, _ := json.Marshal(map[string]string{"type": "flush-ack", "uuid": uuid})
	write(ack)
}

// handleEnterMarkdown embeds current block state into Markdown, sets mode = markdown,
// and returns merged content to JS as the seed for the markdown editor.
func (h *WsHandler) handleEnterMarkdown(write func([]byte), uuid string) {
	merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
	h.persistTabMode(uuid, "markdown")
	resp, _ := json.Marshal(map[string]string{
		"type":     "markdown-content",
		"uuid":     uuid,
		"markdown": merged,
	})
	write(resp)
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
