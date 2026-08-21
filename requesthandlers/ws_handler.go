package requesthandlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/protocol"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

// WsHandler serves both WebSocket wires: one document channel per open document,
// and the workspace channel the app window holds. Every inbound frame is
// dispatched through protocol.Registry, so a type word the contract does not
// carry ON THE ARRIVING CHANNEL cannot reach a handler at all.
type WsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	upgrader        websocket.Upgrader
	registry        *protocol.Registry
	broadcast       *WorkspaceBroadcast
	documentFrames  map[string]frameHandler
	workspaceFrames map[string]frameHandler
	channelsMu      sync.RWMutex
	channels        map[string]*wsConn // uuid (or the workspace sentinel) -> the LATEST connection's channel
}

// wsConn identifies one live connection's write channel. The uuid's channel —
// and shadow-teardown responsibility — belongs to the LATEST registrant: a
// stale connection dying after its successor registered must not evict the
// successor's channel or close its shadow (that race silently dropped
// render-backs and lost updates on reconnect overlap; ws_takeover_test.go).
type wsConn struct {
	write func(interface{})
	// closed marks the conn's reader as torn down. Command emits check it to
	// stay requester-affine (reply to the socket the command arrived on) while
	// still falling back to the current workspace owner once the requester dies —
	// without it, a co-claimant workspace socket (dev-server tab + app window)
	// that re-registers the sentinel mid-job silently swallows the reply.
	closed atomic.Bool
}

// inboundFrame is one frame as it arrived: the bytes to decode, the connection
// that sent it, and — on a document channel — the document that channel is bound
// to. Handlers take nothing else, so one dispatch table serves both wires.
type inboundFrame struct {
	conn *wsConn
	uuid string // empty on the workspace channel, which is bound to no document
	raw  []byte
}

// reply writes a frame back on the connection this one arrived on.
func (f inboundFrame) reply(frame interface{}) {
	f.conn.write(frame)
}

// frameHandler serves one inbound frame type.
type frameHandler func(inboundFrame)

// NewWsHandler builds the handler for both wires. The broadcast comes from
// outside because it outlives any one socket: the app holds it from startup and
// pushes through it, while this handler is only what fills and empties it.
func NewWsHandler(sp *sieve.ServiceProvider, broadcast *WorkspaceBroadcast) *WsHandler {
	h := &WsHandler{
		ServiceProvider: sp,
		registry:        protocol.NewRegistry(),
		broadcast:       broadcast,
		channels:        make(map[string]*wsConn),
	}
	// Assigned rather than set in the literal because the gate is a method on the
	// handler it guards. gorilla's zero-value CheckOrigin is same-origin-only,
	// which would refuse the app's own custom-scheme window — see allowOrigin.
	h.upgrader.CheckOrigin = h.allowOrigin
	h.documentFrames = map[string]frameHandler{
		protocol.TypePing:              h.handlePing,
		protocol.TypeDocUpdate:         h.handleDocUpdate,
		protocol.TypeFlush:             h.handleFlush,
		protocol.TypeEnterMarkdown:     h.handleEnterMarkdown,
		protocol.TypeEnterWysiwyg:      h.handleEnterWysiwyg,
		protocol.TypeRetryBlockJob:     h.handleRetryBlockJob,
		protocol.TypeExtract:           h.handleExtract,
		protocol.TypeBlockOp:           h.handleBlockOp,
		protocol.TypeLoad:              h.handleLoad,
		protocol.TypePaste:             h.handlePaste,
		protocol.TypeDetectExtractions: h.handleDetectExtractions,
		protocol.TypeExport:            h.handleExport,
		protocol.TypeFocus:             h.handleFocus,
	}
	h.workspaceFrames = map[string]frameHandler{
		protocol.TypePing:           h.handlePing,
		protocol.TypeCommand:        h.handleCommand,
		protocol.TypeCommandCancel:  h.handleCommandCancel,
		protocol.TypeMentionQuery:   h.handleMentionQuery,
		protocol.TypeMentionResolve: h.handleMentionResolve,
		protocol.TypeSessionScroll:  h.handleSessionScroll,
	}
	return h
}

// register installs c as uuid's channel, taking over from any predecessor.
func (h *WsHandler) register(uuid string, c *wsConn) {
	h.channelsMu.Lock()
	h.channels[uuid] = c
	h.channelsMu.Unlock()
}

// isMutating reports whether an incoming frame type changes the open document
// (or its mode) and therefore fires a synchronous render-back that MUST reach
// the acting connection. Such a frame re-claims listener ownership before it is
// processed (claim-on-write). enter-markdown/enter-wysiwyg count as mutating:
// they flip doc mode and expect follow-up render traffic on the acting socket.
// Reads (ping heartbeats, flush persistence) are excluded — a backgrounded
// stale tab proving liveness or syncing to disk is not evidence a human edits
// there, so it must not steal ownership from the real editor. transform rides
// inside extract (via its Operation/Action), so it needs no separate case.
func (h *WsHandler) isMutating(frameType string) bool {
	switch frameType {
	case protocol.TypeDocUpdate, protocol.TypeBlockOp, protocol.TypeExtract,
		protocol.TypeRetryBlockJob, protocol.TypeEnterMarkdown, protocol.TypeEnterWysiwyg,
		protocol.TypePaste:
		return true
	default:
		return false
	}
}

// claimOnWrite makes c the registered listener for uuid before a mutating op is
// processed, so the op's synchronous render-back (fired inside the handler,
// before the ack) flows to the acting connection rather than to a co-claimant
// (dev-server tab + app window, reconnect/re-init races). It reuses register()'s
// single map + lock — no second registry. It composes with the ownership-guarded
// unregister: once c is installed here, a deposed connection's later death sees
// h.channels[uuid] != itself and touches neither the channel nor the shadow.
// No-op — and silent — when c already owns uuid.
func (h *WsHandler) claimOnWrite(uuid string, c *wsConn) {
	h.channelsMu.Lock()
	deposed := h.channels[uuid] != nil && h.channels[uuid] != c
	h.channels[uuid] = c
	h.channelsMu.Unlock()
	if deposed {
		logger.Info("ws: claim-on-write takeover — mutating frame from non-registered conn", "uuid", uuid, "conn", fmt.Sprintf("%p", c))
	}
}

// unregister removes uuid's channel ONLY if c still owns it. Returns true when
// c was the owner — the caller then also owns shadow teardown. A stale
// connection (owner == a successor) must touch nothing.
func (h *WsHandler) unregister(uuid string, c *wsConn) bool {
	h.channelsMu.Lock()
	defer h.channelsMu.Unlock()
	if h.channels[uuid] != c {
		return false
	}
	delete(h.channels, uuid)
	return true
}

// sendTo writes v to uuid's CURRENT channel, if any (render-back path).
func (h *WsHandler) sendTo(uuid string, v interface{}) {
	h.channelsMu.RLock()
	c := h.channels[uuid]
	h.channelsMu.RUnlock()
	if c != nil {
		c.write(v)
	}
}

// workspaceChannelKey is the reserved workspace channel's key. It lives in the
// SAME channels map as the per-uuid document channels so sendTo() is the one
// render-back path; the sentinel can never collide with a real uuid. No shadow,
// no claim-on-write: workspace traffic is not a document mutation.
const workspaceChannelKey = "__workspace__"

// RegisterPaths mounts the two wires. Each has its own path, so which wire a
// dial asks for is decided by chi before the upgrade rather than by inspecting
// the query string afterwards.
func (h *WsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/ws/document/{uuid}", h.handleDocumentWS)
	r.Get("/api/ws/workspace", h.handleWorkspaceWS)
}

// wsWriteTimeout bounds every socket write. WorkspaceBroadcast.Send walks its
// connection set and writes to each SEQUENTIALLY, from a JobEngine pool worker
// or the fs-watcher goroutine (job transitions, notes/library invalidation) —
// and /api/ws/workspace is reachable through the loopback bridge. With no
// deadline, one peer that stops reading (a full TCP send buffer) blocks that
// write forever, which blocks the rest of the fan-out AND parks the caller. A
// peer that cannot take a frame within wsWriteTimeout is gone: failing its
// connection beats parking a job worker or the watcher indefinitely. A var,
// not a const, so a test can shrink it to force the timeout deterministically.
var wsWriteTimeout = 5 * time.Second

// writerFor returns conn's write func. gorilla/websocket allows one concurrent
// writer, so every writer — the debounce goroutine, the read loop, a job
// finishing — goes through this one mutex.
func (h *WsHandler) writerFor(conn *websocket.Conn, channel protocol.Channel, uuid string) func(interface{}) {
	var mu sync.Mutex
	return func(v interface{}) {
		data, err := json.Marshal(v)
		if err != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			logger.Debug("ws: write failed", "channel", channel, "uuid", uuid, "err", err)
		}
	}
}

// readLoop pumps one connection until it dies, dispatching every frame it reads.
func (h *WsHandler) readLoop(conn *websocket.Conn, channel protocol.Channel, handlers map[string]frameHandler, c *wsConn, uuid string) {
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var msg struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		// Claim-on-write: a mutating frame is evidence THIS connection is the one a
		// human is editing through, so it re-registers as uuid's listener BEFORE the
		// op runs — the op's synchronous render-back then lands here, not on a
		// co-claimant that happened to register last. Reads/heartbeats never claim,
		// and the workspace channel owns no document to claim.
		if channel == protocol.ChannelDocument && h.isMutating(msg.Type) {
			h.claimOnWrite(uuid, c)
		}

		h.dispatch(channel, handlers, msg.Type, inboundFrame{conn: c, uuid: uuid, raw: raw})
	}
}

// dispatch routes one frame to its handler. The registry is the gate: a type
// word it does not carry on THIS channel never reaches a handler, which refuses
// a workspace frame arriving on a document socket for free.
//
// A refusal is an ANSWER, because a client given silence waits forever on a
// reply that is never coming. The two refusals are worded apart on purpose:
// "I don't know that word" and "I know it but serve nothing for it yet" are
// different problems for whoever reads the log.
func (h *WsHandler) dispatch(channel protocol.Channel, handlers map[string]frameHandler, frameType string, f inboundFrame) {
	if entry, known := h.registry.Frame(channel, frameType); !known || entry.Direction != protocol.Inbound {
		logger.Warn("ws: unknown inbound frame type", "channel", channel, "type", frameType, "uuid", f.uuid)
		f.reply(protocol.NewErrorFrame(fmt.Sprintf("unknown %s frame type %q", channel, frameType)))
		return
	}
	handler, served := handlers[frameType]
	if !served {
		logger.Warn("ws: registered frame type has no handler", "channel", channel, "type", frameType, "uuid", f.uuid)
		f.reply(protocol.NewErrorFrame(fmt.Sprintf("%s frame %q is not handled yet", channel, frameType)))
		return
	}
	handler(f)
}

// errCorrelationless is why a well-formed correlated frame is still unservable:
// its answer would have nowhere to go, and the client is waiting for one.
var errCorrelationless = errors.New("no correlation id")

// refuse answers a frame the handler could not read. It is dispatch's third
// refusal — "I know the word and serve it, but THIS payload is not one" — and it
// replies on the arriving connection for the same reason the other two do:
// silence leaves a client waiting forever on an answer that is never coming, and
// a dropped mutation looks exactly like a slow one. It goes back on f.conn
// rather than through replyTo because a refusal is immediate, so the requester
// is by definition still there.
func (h *WsHandler) refuse(f inboundFrame, frameType string, err error) {
	logger.Warn("ws: unreadable frame payload", "type", frameType, "uuid", f.uuid, "err", err)
	f.reply(protocol.NewErrorFrame(fmt.Sprintf("%s frame is unreadable: %v", frameType, err)))
}

// allowOrigin is the upgrade gate on both wires: default-deny, admitting only
// the app's own window and local non-browser clients.
//
// It is load-bearing rather than hygiene. The wires ride the loopback listener
// (WebKitGTK cannot carry a WebSocket upgrade over the app's custom scheme), and
// a loopback listener is reachable from any page the user happens to open in a
// real browser — the classic cross-site-WebSocket hijack, which the same-origin
// policy does NOT stop. The document wire creates blocks, serves whole documents
// and, since native-drop, READS LOCAL FILES, so an allow-all check hands every
// one of those to any web page the user visits.
//
// The three admitted shapes:
//
//   - NO Origin header. Not a browser: the contained AI CLI's MCP client, a test
//     dialling with a bare client. A browser always sends one on a WS upgrade,
//     so this cannot be a drive-by page. (It does leave a local process able to
//     dial in — that is the gap auth-on-upgrade, #83, closes; this check is
//     about the browser, which cannot forge an absent Origin.)
//   - The `wails://` scheme. The app's own window: Wails serves the app from a
//     custom scheme, and no web page can claim one. The WebKitGTK window sends
//     `Origin: wails://wails` (measured, dev and production alike; the Linux and
//     macOS start URL is `wails://wails/`), and the SCHEME is what is matched so
//     a host of `wails.localhost:port` — the spelling Wails uses when it hands
//     the webview an asset-server port — is admitted too. TRAP for a future
//     Windows build: WebView2 serves the app from `http://wails.localhost`
//     instead, which this refuses as written.
//   - A LOOPBACK http(s) origin. `wails dev` serves the same app over
//     127.0.0.1/localhost for a real browser, which is how the UI is driven under
//     test. A page must already be served from this machine to hold one.
//
// Everything else is refused and logged with the origin that asked, because a
// wrong entry here kills every wire in the app and the log line is the only way
// to tell that apart from a dead socket.
func (h *WsHandler) allowOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		logger.Warn("ws: refused upgrade (unparseable origin)", "origin", origin, "err", err)
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "wails":
		return true
	case "http", "https":
		if h.isLoopback(u.Hostname()) {
			return true
		}
	}
	logger.Warn("ws: refused upgrade (foreign origin)", "origin", origin, "path", r.URL.Path)
	return false
}

// isLoopback reports whether host names this machine. The literal addresses are
// matched as ADDRESSES, not strings, so every spelling of them ("127.1",
// "[::1]") answers the same; "localhost" is matched by name because it is not an
// address and resolving it here would make the gate depend on DNS.
func (h *WsHandler) isLoopback(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (h *WsHandler) handleDocumentWS(w http.ResponseWriter, r *http.Request) {
	uuid := chi.URLParam(r, "uuid")
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

	writeMsg := h.writerFor(conn, protocol.ChannelDocument, uuid)

	logger.Info("ws: connection established", "uuid", uuid)

	ch := &wsConn{write: writeMsg}
	h.register(uuid, ch)

	// ONE teardown path, ownership-guarded: only the connection that still owns
	// the channel closes the shadow. A stale connection whose successor already
	// registered must not evict the successor's channel or close its shadow.
	defer func() {
		ch.closed.Store(true)
		if h.unregister(uuid, ch) {
			h.ServiceProvider.Editor.Close(uuid)
		} else {
			logger.Info("ws: stale teardown — successor active, skipping close", "uuid", uuid)
		}
		logger.Info("ws: connection closed", "uuid", uuid)
	}()

	if err := h.ServiceProvider.Editor.Open(uuid); err != nil {
		logger.Warn("ws: could not open shadow", "uuid", uuid, "err", err)
	}

	h.readLoop(conn, protocol.ChannelDocument, h.documentFrames, ch, uuid)
}

func (h *WsHandler) handleWorkspaceWS(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("ws: workspace upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	logger.Info("ws: workspace channel connected")

	ch := &wsConn{write: h.writerFor(conn, protocol.ChannelWorkspace, "")}
	h.register(workspaceChannelKey, ch)
	h.broadcast.join(ch)
	defer func() {
		ch.closed.Store(true)
		h.broadcast.leave(ch)
		h.unregister(workspaceChannelKey, ch)
		logger.Info("ws: workspace channel closed")
	}()

	// The job snapshot is PUSHED and nothing polls for it, so a socket is handed
	// the current one before it reads anything: a client that connected after the
	// last transition would otherwise show an empty status bar until the next.
	ch.write(h.broadcast.jobsFrame())

	h.readLoop(conn, protocol.ChannelWorkspace, h.workspaceFrames, ch, "")
}

// handlePing answers the liveness probe on either wire.
func (h *WsHandler) handlePing(f inboundFrame) {
	f.reply(protocol.NewPongFrame())
}

func (h *WsHandler) handleBlockOp(f inboundFrame) {
	var msg protocol.BlockOpFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeBlockOp, err)
		return
	}
	err := h.ServiceProvider.Editor.HandleBlockOp(f.uuid, msg.Op)
	if err != nil {
		logger.Warn("ws: block-op failed", "uuid", f.uuid, "op", msg.Op.Type, "block", msg.Op.BlockID, "err", err)
		f.reply(protocol.NewErrorFrame(fmt.Sprintf("block-op %s failed: %v", msg.Op.Type, err)))
	}
	if msg.OpID != "" {
		f.reply(protocol.NewBlockOpAckFrame(msg.OpID, err))
	}
}

func (h *WsHandler) handleDocUpdate(f inboundFrame) {
	var msg protocol.DocUpdateFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeDocUpdate, err)
		return
	}
	h.ServiceProvider.Editor.UpdateMarkdown(f.uuid, msg.Markdown)
}

// handleFlush persists and answers nothing. The envelope is never decoded —
// there is nothing under the type word to read, so a malformed one still
// flushes, which is the whole point: persistence must not depend on the shape of
// the request asking for it. A successful write announces itself to the whole
// workspace as container-saved (EditorService's save chokepoint), so the
// requester hears the news the same way every other client does.
func (h *WsHandler) handleFlush(f inboundFrame) {
	_ = h.ServiceProvider.Editor.Flush(f.uuid)
}

func (h *WsHandler) handleEnterMarkdown(f inboundFrame) {
	var msg protocol.EnterMarkdownFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeEnterMarkdown, err)
		return
	}
	merged := h.ServiceProvider.Editor.EnterMarkdown(f.uuid)
	h.persistTabMode(f.uuid, "markdown")
	reply := protocol.NewMarkdownContentFrame(f.uuid, merged)
	if msg.OpID != "" {
		reply = reply.WithOpID(msg.OpID)
	}
	f.reply(reply)
}

// handleEnterWysiwyg re-parses the shadow from the markdown the client holds,
// sets mode = wysiwyg, and returns the reparsed blocks so JS can render
// immediately — symmetric to handleEnterMarkdown returning markdown-content.
func (h *WsHandler) handleEnterWysiwyg(f inboundFrame) {
	var msg protocol.EnterWysiwygFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeEnterWysiwyg, err)
		return
	}
	if msg.Markdown != nil {
		h.ServiceProvider.Editor.UpdateMarkdown(f.uuid, *msg.Markdown)
	}
	h.ServiceProvider.Editor.EnterWysiwyg(f.uuid)
	h.persistTabMode(f.uuid, "wysiwyg")
	if blocks, ok := h.ServiceProvider.Editor.FrontendBlocks(f.uuid); ok {
		reply := protocol.NewWysiwygContentFrame(f.uuid, blocks)
		if msg.OpID != "" {
			reply = reply.WithOpID(msg.OpID)
		}
		f.reply(reply)
	}
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

func (h *WsHandler) handleRetryBlockJob(f inboundFrame) {
	var msg protocol.RetryBlockJobFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeRetryBlockJob, err)
		return
	}
	if msg.ID == "" {
		h.refuse(f, protocol.TypeRetryBlockJob, errors.New("no block id"))
		return
	}
	// Reset both status and createdAt. The DISPATCHED notifyBlockUpdated that fires
	// immediately will carry the fresh createdAt, so the frontend's isJobStale()
	// won't fire and re-show "interrupted" instead of the spinner.
	h.ServiceProvider.Editor.UpdateBlock(f.uuid, block.SieveBlock{
		ID: msg.ID,
		Attrs: map[string]interface{}{
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
			"error":     "",
		},
	})
	h.ServiceProvider.Editor.DispatchJobIfNeeded(f.uuid, msg.ID)
}

// OnBlockCreated implements sieve.BlockLifecycleListener.
func (h *WsHandler) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string) {
	h.sendTo(uuid, protocol.NewInsertBlockFrame(kind, blockID, attrs, index, markdown, token))
}

// OnBlockUpdated implements sieve.BlockLifecycleListener.
func (h *WsHandler) OnBlockUpdated(uuid, blockID string, attrs map[string]interface{}) {
	h.sendTo(uuid, protocol.NewBlockAttrsUpdatedFrame(blockID, attrs))
}

// OnBlockReplaced implements block.BlockLifecycleListener.
func (h *WsHandler) OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string) {
	h.sendTo(uuid, protocol.NewReplaceBlockFrame(oldID, newKind, newID, attrs, markdown))
}

// Either way the created block reaches the client as a render-back
// (insert-block, or replace-block for a transform); the ack only reports the
// outcome.
func (h *WsHandler) handleExtract(f inboundFrame) {
	var p protocol.ExtractFrame
	if err := json.Unmarshal(f.raw, &p); err != nil {
		h.refuse(f, protocol.TypeExtract, err)
		return
	}

	action := p.Operation
	if action == "" {
		action = block.ActionExtract
	}

	_, _, err := h.ServiceProvider.Editor.CreateBlockFromEntries(
		f.uuid, p.TargetKind, p.Entries, p.Index, action, p.BlockID)
	if err != nil {
		logger.Warn("ws: extract block failed", "err", err)
		f.reply(protocol.NewErrorFrame(fmt.Sprintf("Failed to extract block: %v", err)))
	}
	if p.OpID != "" {
		f.reply(protocol.NewExtractAckFrame(p.OpID, err))
	}
}

// handleLoad answers with the document this channel is bound to. Finding
// nothing is an ANSWER too — empty content, which the client mounts as an empty
// document — because the editor is already on screen waiting for one.
func (h *WsHandler) handleLoad(f inboundFrame) {
	var msg protocol.LoadFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeLoad, err)
		return
	}

	content, found := documentContent{sp: h.ServiceProvider}.read(f.uuid)
	if !found {
		content = protocol.DocumentContent{Mode: "wysiwyg"}
	}
	reply := protocol.NewLoadContentFrame(content)
	if msg.OpID != "" {
		reply = reply.WithOpID(msg.OpID)
	}
	f.reply(reply)
}

// handlePaste hands a clipboard to the block registry to make sense of. Every
// kind's created blocks arrive as insert-block render-backs — the authoritative
// render signal — so the ack reports only what happened.
func (h *WsHandler) handlePaste(f inboundFrame) {
	var msg protocol.PasteFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypePaste, err)
		return
	}

	if msg.Kind == protocol.PasteKindNativeDrop {
		// The entries name files rather than carrying them: the server reads the
		// bytes off disk. See PasteKindNativeDrop for why that capability is on this
		// wire at all, and allowOrigin for what keeps it off a foreign page's.
		f.reply(protocol.NewPasteAckFrame(msg.OpID,
			h.ServiceProvider.Editor.HandleNativeDrop(f.uuid, msg.Entries, msg.Index)))
		return
	}

	if msg.Kind == protocol.PasteKindSlice {
		if _, err := h.ServiceProvider.Editor.HandlePasteSlice(f.uuid, msg.Slice, msg.Index); err != nil {
			logger.Warn("ws: paste slice failed", "uuid", f.uuid, "err", err)
			f.reply(protocol.NewPasteFailedFrame(msg.OpID, err))
			return
		}
		// A slice reconstruction creates several blocks and names none of them: the
		// outcome alone says the server took the clipboard, and the empty identity
		// is the point — there is no single block for a caret to be consumed
		// against.
		f.reply(protocol.NewPasteAckFrame(msg.OpID, block.PasteBlock("", "", "")))
		return
	}

	f.reply(protocol.NewPasteAckFrame(msg.OpID,
		h.ServiceProvider.Editor.HandlePaste(f.uuid, msg.Entries, msg.Index)))
}

// handleDetectExtractions answers which kinds would accept a selection. It
// creates nothing, so it claims no listener ownership.
func (h *WsHandler) handleDetectExtractions(f inboundFrame) {
	var msg protocol.DetectExtractionsFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeDetectExtractions, err)
		return
	}
	f.reply(protocol.NewDetectExtractionsResultFrame(msg.OpID,
		block.DetectExtractions(msg.SourceKind, msg.Entries)))
}

// handleExport serves clean whole-document markdown. THIS handler owns the
// exclusion policy — the closure dropping ai-blocks, because prior Q&A is
// conversation rather than document content; another caller may filter
// differently.
func (h *WsHandler) handleExport(f inboundFrame) {
	var msg protocol.ExportFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeExport, err)
		return
	}
	format := msg.Format
	if format == "" {
		format = "markdown"
	}
	if format != "markdown" {
		f.reply(protocol.NewErrorFrame(fmt.Sprintf("unsupported export format %q", format)))
		return
	}
	md, err := h.ServiceProvider.Editor.ExportMarkdown(f.uuid,
		func(b block.SieveBlock) bool { return b.Kind != "ai-block" })
	if err != nil {
		f.reply(protocol.NewErrorFrame(fmt.Sprintf("export failed: %v", err)))
		return
	}
	f.reply(protocol.NewExportContentFrame(msg.OpID, format, md))
}

// handleFocus records that the user is dwelling on this document. It answers
// nothing: the count is read from the meta panel, never from this frame.
func (h *WsHandler) handleFocus(f inboundFrame) {
	doc, err := h.ServiceProvider.Documents.LoadByUUID(f.uuid)
	if err != nil {
		logger.Debug("ws: focus for an unknown document", "uuid", f.uuid, "err", err)
		return
	}
	h.ServiceProvider.Documents.IncrementFocusCount(doc)
}

// handleSessionScroll persists one tab's scroll offset. It lives on the
// workspace wire because the tab it names may be any tab, open document or not,
// and a SERVED frame answers nothing: this is caret-class state, so there is no
// shared UI change to broadcast. A tab closed mid-flight is a harmless no-op —
// but a frame that could not be read at all is refused out loud, like every
// other unservable frame.
func (h *WsHandler) handleSessionScroll(f inboundFrame) {
	var msg protocol.SessionScrollFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeSessionScroll, err)
		return
	}
	if msg.ID == "" {
		h.refuse(f, protocol.TypeSessionScroll, errors.New("no tab id"))
		return
	}
	if h.ServiceProvider.State == nil {
		return
	}
	session := h.ServiceProvider.State.LoadSession()
	for i, t := range session.Tabs {
		if t.ID == msg.ID {
			session.Tabs[i].Scroll = msg.Scroll
			_ = h.ServiceProvider.State.SaveSession(session)
			return
		}
	}
}

// replyTo sends a correlated reply REQUESTER-AFFINELY, per the ownership rule
// (acks→requester, render-backs→registered owner). Every correlated workspace
// reply is ack-shaped, so it goes back on the socket the request arrived on: the
// registered workspace owner may have changed since (a dev-server tab
// registering beside the app window silently deposes it — that stole two live
// /btw answers on 2026-07-26). Only when the requester is gone (reconnect) does
// it fall back to the current workspace owner, so a long-running reply still
// lands somewhere useful.
//
// EVERY workspace-frame handler must reply through here. Reaching for
// sendTo(workspaceChannelKey) directly is precisely the bug.
func (h *WsHandler) replyTo(requester *wsConn, frame interface{}) {
	if requester != nil && !requester.closed.Load() {
		requester.write(frame)
		return
	}
	h.sendTo(workspaceChannelKey, frame)
}

// handleCommand dispatches a command frame, replying requester-affinely.
func (h *WsHandler) handleCommand(f inboundFrame) {
	var env protocol.CommandFrame
	if err := json.Unmarshal(f.raw, &env); err != nil {
		h.refuse(f, protocol.TypeCommand, err)
		return
	}
	if env.CorrelationID == "" {
		h.refuse(f, protocol.TypeCommand, errCorrelationless)
		return
	}
	emit := func(o command.Outcome) {
		frame := protocol.NewCommandResultFrame(env.CorrelationID, env.Cmd, o.Status)
		if o.Block != nil {
			frame = frame.WithBlock(o.Block.Kind, o.Block.Attrs)
		}
		if o.Err != "" {
			frame = frame.WithError(o.Err)
		}
		h.replyTo(f.conn, frame)
	}
	reg := h.ServiceProvider.Commands
	if reg == nil {
		emit(command.Outcome{Status: command.StatusError, Err: "commands unavailable"})
		return
	}
	// The Context is assembled HERE, at the wire edge, from BOTH of the envelope's
	// context-bearing fields — the lens-authored `context` JSON and the
	// composer-authored `attachments` list.
	reg.Dispatch(env.Cmd, env.Family, env.Args.Text,
		command.NewContext(env.Context, env.Attachments), env.CorrelationID, emit)
}

// The client-supplied mention limit is floored and capped to these.
const (
	mentionDefaultLimit = 8
	mentionMaxLimit     = 25
)

// handleMentionQuery answers the `@`-picker's typeahead from the Router's
// enumeration face.
func (h *WsHandler) handleMentionQuery(f inboundFrame) {
	var msg protocol.MentionQueryFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeMentionQuery, err)
		return
	}
	if msg.CorrelationID == "" {
		h.refuse(f, protocol.TypeMentionQuery, errCorrelationless)
		return
	}
	limit := msg.Limit
	if limit <= 0 {
		limit = mentionDefaultLimit
	}
	if limit > mentionMaxLimit {
		limit = mentionMaxLimit
	}

	var candidates []domain.Candidate
	if h.ServiceProvider.Nodes != nil {
		candidates = h.ServiceProvider.Nodes.Search(msg.Q, limit)
	}
	h.replyTo(f.conn, protocol.NewMentionResultFrame(msg.CorrelationID, candidates))
}

// handleMentionResolve answers "where does this coordinate open?" from the
// Router's navigation face — the sibling of handleMentionQuery's enumeration.
func (h *WsHandler) handleMentionResolve(f inboundFrame) {
	var msg protocol.MentionResolveFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeMentionResolve, err)
		return
	}
	if msg.CorrelationID == "" {
		h.refuse(f, protocol.TypeMentionResolve, errCorrelationless)
		return
	}
	target, err := h.resolveTarget(msg.URI)
	if err != nil {
		h.replyTo(f.conn, protocol.NewMentionUnresolvedFrame(msg.CorrelationID, msg.URI, err))
		return
	}
	h.replyTo(f.conn, protocol.NewMentionResolvedFrame(msg.CorrelationID, msg.URI, target))
}

// resolveTarget asks the Router where an address opens, treating an unwired
// Router as a refusal rather than a panic — the same unconfigured floor
// handleMentionQuery answers an empty list on.
func (h *WsHandler) resolveTarget(uri string) (domain.OpenTarget, error) {
	if h.ServiceProvider.Nodes == nil {
		return domain.OpenTarget{}, errors.New("address resolution is unavailable")
	}
	return h.ServiceProvider.Nodes.Target(uri)
}

func (h *WsHandler) handleCommandCancel(f inboundFrame) {
	var msg protocol.CommandCancelFrame
	if err := json.Unmarshal(f.raw, &msg); err != nil {
		h.refuse(f, protocol.TypeCommandCancel, err)
		return
	}
	if msg.CorrelationID == "" {
		h.refuse(f, protocol.TypeCommandCancel, errCorrelationless)
		return
	}
	if h.ServiceProvider.Commands != nil {
		h.ServiceProvider.Commands.Cancel(msg.CorrelationID)
	}
}
