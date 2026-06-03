package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

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
	channelsMu      sync.RWMutex
	channels        map[string]func(interface{}) // uuid -> writeMsg function
}

func NewWsHandler(sp *sieve.ServiceProvider) *WsHandler {
	h := &WsHandler{
		ServiceProvider: sp,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		channels: make(map[string]func(interface{})),
	}
	return h
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

	if h.ServiceProvider.Editor != nil {
		h.ServiceProvider.Editor.SetLifecycleListener(h)
	}

	// gorilla/websocket allows one concurrent writer — protect with a mutex so
	// the debounce goroutine and the message-loop goroutine don't race.
	var writeMu sync.Mutex
	writeMsg := func(v interface{}) {
		data, err := json.Marshal(v)
		if err != nil {
			return
		}
		writeMu.Lock()
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			logger.Debug("ws: write failed", "uuid", uuid, "err", err)
		}
		writeMu.Unlock()
	}

	notifySaved := func() {
		writeMsg(map[string]string{"type": "flush-ack", "uuid": uuid})
	}

	logger.Info("ws: connection established", "uuid", uuid)
	
	h.channelsMu.Lock()
	h.channels[uuid] = writeMsg
	h.channelsMu.Unlock()

	defer func() {
		h.channelsMu.Lock()
		delete(h.channels, uuid)
		h.channelsMu.Unlock()
	}()

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
// OnChange on the processor so it can re-run heuristics.
func (h *WsHandler) handleBlockUpdate(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		ID    string                 `json:"id"`
		Kind  string                 `json:"kind"`
		Attrs map[string]interface{} `json:"attrs"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return
	}
	h.ServiceProvider.Editor.HandleBlockUpdate(uuid, msg.Kind, msg.ID, msg.Attrs)
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
		Kind  string                 `json:"kind"`
		Attrs map[string]interface{} `json:"attrs"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.Kind == "" {
		return
	}
	_, _, err := h.ServiceProvider.Editor.CreateBlock(uuid, msg.Kind, msg.Attrs)
	if err != nil {
		logger.Warn("ws: create-block failed", "uuid", uuid, "kind", msg.Kind, "err", err)
		return
	}
}

func (h *WsHandler) handleRetryBlockJob(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.ID == "" {
		return
	}
	// Reset both status and createdAt. The DISPATCHED notifyBlockUpdated that fires
	// immediately will carry the fresh createdAt, so the frontend's isJobStale()
	// won't fire and re-show "interrupted" instead of the spinner.
	h.ServiceProvider.Editor.UpdateBlock(uuid, sieve.SieveBlock{
		ID: msg.ID,
		Attrs: map[string]interface{}{
			"status":    sieve.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
			"error":     "",
		},
	})
	h.ServiceProvider.Editor.DispatchJobIfNeeded(uuid, msg.ID)
}

// OnBlockCreated implements sieve.BlockLifecycleListener.
func (h *WsHandler) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, serialisedForm string) {
	h.channelsMu.RLock()
	writeMsg, ok := h.channels[uuid]
	h.channelsMu.RUnlock()
	if ok {
		writeMsg(map[string]interface{}{
			"type":           "insert-block",
			"kind":           kind,
			"id":             blockID,
			"attrs":          attrs,
			"serialisedForm": serialisedForm,
		})
	}
}

// OnBlockUpdated implements sieve.BlockLifecycleListener.
func (h *WsHandler) OnBlockUpdated(uuid, blockID string, attrs map[string]interface{}, serialisedForm string) {
	h.channelsMu.RLock()
	writeMsg, ok := h.channels[uuid]
	h.channelsMu.RUnlock()
	if ok {
		writeMsg(map[string]interface{}{
			"type":           "block-attrs-updated",
			"id":             blockID,
			"attrs":          attrs,
			"serialisedForm": serialisedForm,
		})
	}
}

