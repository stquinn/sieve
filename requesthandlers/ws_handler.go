package requesthandlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/command"
	"sieve/sieve/domain"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
)

// WsHandler manages one persistent WebSocket connection per open document.
// It dispatches incoming messages to EditorService and sends acks back.
type WsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	upgrader        websocket.Upgrader
	channelsMu      sync.RWMutex
	channels        map[string]*wsConn // uuid -> the LATEST connection's channel
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
	// still falling back to the current session owner once the requester dies —
	// without it, a co-claimant session socket (dev-server tab + app window)
	// that re-registers __session__ mid-job silently swallows the reply.
	closed atomic.Bool
}

func NewWsHandler(sp *sieve.ServiceProvider) *WsHandler {
	h := &WsHandler{
		ServiceProvider: sp,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
		channels: make(map[string]*wsConn),
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
// inside "extract" (via its Operation/Action), so it needs no separate case.
func (h *WsHandler) isMutating(frameType string) bool {
	switch frameType {
	case "doc-update", "block-op", "extract", "retry-block-job", "enter-markdown", "enter-wysiwyg":
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
// unregister (commit 6e2ccfc): once c is installed here, a deposed connection's
// later death sees h.channels[uuid] != itself and touches neither the channel nor
// the shadow. No-op — and silent — when c already owns uuid.
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

// sessionChannelKey is the reserved workspace channel — the session command
// plane's seed (#55). It lives in the SAME channels map as the per-uuid doc
// channels so sendTo() is the one render-back path; the sentinel can never
// collide with a real uuid. No shadow, no claim-on-write: commands are
// workspace traffic, not doc mutations.
const sessionChannelKey = "__session__"

func (h *WsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/ws", h.handleWS)
}

func (h *WsHandler) handleWS(w http.ResponseWriter, r *http.Request) {
	sess := r.URL.Query().Get("session")
	if sess == "1" || sess == "true" {
		h.handleSessionWS(w, r)
		return
	}

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

	ch := &wsConn{write: writeMsg}
	h.register(uuid, ch)

	// ONE teardown path, ownership-guarded: only the connection that still owns
	// the channel closes the shadow. A stale connection whose successor already
	// registered must not evict the successor's channel or close its shadow.
	defer func() {
		if h.unregister(uuid, ch) {
			h.ServiceProvider.Editor.Close(uuid)
		} else {
			logger.Info("ws: stale teardown — successor active, skipping close", "uuid", uuid)
		}
		logger.Info("ws: connection closed", "uuid", uuid)
	}()

	if err := h.ServiceProvider.Editor.Open(uuid, notifySaved); err != nil {
		logger.Warn("ws: could not open shadow", "uuid", uuid, "err", err)
	}

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

		// Claim-on-write: a mutating frame is evidence THIS connection is the one a
		// human is editing through, so it re-registers as uuid's listener BEFORE the
		// op runs — the op's synchronous render-back then lands here, not on a
		// co-claimant that happened to register last. Reads/heartbeats never claim.
		if h.isMutating(msg.Type) {
			h.claimOnWrite(uuid, ch)
		}

		switch msg.Type {
		case "ping":
			writeMsg(map[string]string{"type": "pong"})
		case "doc-update":
			h.handleDocUpdate(uuid, raw)
		case "flush":
			h.handleFlush(writeMsg, uuid, raw)
		case "enter-markdown":
			h.handleEnterMarkdown(writeMsg, uuid, raw)
		case "enter-wysiwyg":
			h.handleEnterWysiwyg(uuid, raw, writeMsg)
		case "retry-block-job":
			h.handleRetryBlockJob(uuid, raw, writeMsg)
		case "extract":
			h.handleExtract(uuid, raw, writeMsg)
		case "block-op":
			h.handleBlockOp(uuid, raw, writeMsg)
		}
	}
}

// handleBlockOp applies one granular block operation (create/update/delete/move)
// to the open document's authoritative block tree.
func (h *WsHandler) handleBlockOp(uuid string, raw []byte, writeMsg func(interface{})) {
	var msg struct {
		// OpID is the client-minted request correlation handle (issue #49 Phase 2).
		// It rides the OUTER envelope beside uuid — NOT inside BlockOp, which
		// describes the mutation, not the request. Absent → no ack (compat).
		OpID string        `json:"opId"`
		Op   block.BlockOp `json:"op"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		logger.Warn("ws: block-op decode failed", "uuid", uuid, "err", err)
		return
	}
	// Render-backs (insert-block / replace-block / block-attrs-updated) fire
	// SYNCHRONOUSLY inside HandleBlockOp via the lifecycle listener, so the ack
	// emitted after this call is strictly AFTER its render-back on the same socket.
	err := h.ServiceProvider.Editor.HandleBlockOp(uuid, msg.Op)
	if err != nil {
		logger.Warn("ws: block-op failed", "uuid", uuid, "op", msg.Op.Type, "block", msg.Op.BlockID, "err", err)
		// The generic error frame is UNCHANGED (the pre-existing error path); the
		// ack below carries the opId-correlated outcome.
		writeMsg(map[string]interface{}{
			"type":    "error",
			"message": fmt.Sprintf("block-op %s failed: %v", msg.Op.Type, err),
		})
	}
	if msg.OpID != "" {
		writeMsg(h.ackFrame("block-op-ack", msg.OpID, err))
	}
}

// ackFrame builds a request-correlated ack ({type, opId, ok, error?}). A nil err
// is ok:true; a non-nil err is ok:false plus its message. The block-op / extract
// ack contract (issue #49 Phase 2): the ack IS the opId carrier, emitted after
// the operation (and thus after any synchronous render-back).
func (h *WsHandler) ackFrame(ackType, opID string, err error) map[string]interface{} {
	ack := map[string]interface{}{"type": ackType, "opId": opID, "ok": err == nil}
	if err != nil {
		ack["error"] = err.Error()
	}
	return ack
}

// requestOpID reads the optional client-minted opId off a request envelope
// (issue #49 Phase 2). Present only on reply-expecting frames; absent for
// fire-and-forget frames (doc-update, retry, ping), whose replies carry no opId
// and behave exactly as before.
func (h *WsHandler) requestOpID(raw []byte) string {
	var m struct {
		OpID string `json:"opId"`
	}
	_ = json.Unmarshal(raw, &m)
	return m.OpID
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

// handleFlush is the REQUEST-correlated flush (echoes the request's opId, when
// present). The unsolicited background flush-ack (notifySaved) is a separate path
// with no request and thus no opId — it stays untouched.
func (h *WsHandler) handleFlush(writeMsg func(interface{}), uuid string, raw []byte) {
	_ = h.ServiceProvider.Editor.Flush(uuid)
	ack := map[string]string{"type": "flush-ack", "uuid": uuid}
	if opID := h.requestOpID(raw); opID != "" {
		ack["opId"] = opID
	}
	writeMsg(ack)
}

// handleEnterMarkdown embeds current block state into Markdown, sets mode = markdown,
// and returns merged content to JS as the seed for the markdown editor. Echoes the
// request's opId on the markdown-content reply when present (issue #49 Phase 2).
func (h *WsHandler) handleEnterMarkdown(writeMsg func(interface{}), uuid string, raw []byte) {
	merged := h.ServiceProvider.Editor.EnterMarkdown(uuid)
	h.persistTabMode(uuid, "markdown")
	reply := map[string]string{
		"type":     "markdown-content",
		"uuid":     uuid,
		"markdown": merged,
	}
	if opID := h.requestOpID(raw); opID != "" {
		reply["opId"] = opID
	}
	writeMsg(reply)
}

// handleEnterWysiwyg picks up the latest markdown (the frontend's textarea value,
// since a pending doc-update may not have flushed), re-parses shadow.Doc from it,
// sets mode = wysiwyg, and returns the reparsed blocks so JS can render the
// WYSIWYG editor immediately — symmetric to handleEnterMarkdown returning
// markdown-content. Without the blocks the editor mounts empty until a tab switch
// reloads via /api/editor/load.
func (h *WsHandler) handleEnterWysiwyg(uuid string, raw []byte, writeMsg func(interface{})) {
	// A pointer distinguishes "no markdown field" (other callers) from an
	// intentionally-empty doc; only adopt the markdown when the field is present.
	var msg struct {
		Markdown *string `json:"markdown"`
	}
	if err := json.Unmarshal(raw, &msg); err == nil && msg.Markdown != nil {
		h.ServiceProvider.Editor.UpdateMarkdown(uuid, *msg.Markdown)
	}
	h.ServiceProvider.Editor.EnterWysiwyg(uuid)
	h.persistTabMode(uuid, "wysiwyg")
	if blocks, ok := h.ServiceProvider.Editor.FrontendBlocks(uuid); ok {
		reply := map[string]interface{}{
			"type":   "wysiwyg-content",
			"uuid":   uuid,
			"blocks": blocks,
		}
		if opID := h.requestOpID(raw); opID != "" {
			reply["opId"] = opID
		}
		writeMsg(reply)
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
	h.ServiceProvider.Editor.UpdateBlock(uuid, block.SieveBlock{
		ID: msg.ID,
		Attrs: map[string]interface{}{
			"status":    block.BlockStatusPending,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
			"error":     "",
		},
	})
	h.ServiceProvider.Editor.DispatchJobIfNeeded(uuid, msg.ID)
}

// OnBlockCreated implements sieve.BlockLifecycleListener.
func (h *WsHandler) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string) {
	h.sendTo(uuid, map[string]interface{}{
		"type":     "insert-block",
		"kind":     kind,
		"id":       blockID,
		"attrs":    attrs,
		"index":    index,    // document position for the render-back insert
		"markdown": markdown, // markdown-mode buffer only; WYSIWYG renders from attrs
		"token":    token,    // transient correlation handle echoed for the pending-prose swap
	})
}

// OnBlockUpdated implements sieve.BlockLifecycleListener.
func (h *WsHandler) OnBlockUpdated(uuid, blockID string, attrs map[string]interface{}) {
	h.sendTo(uuid, map[string]interface{}{
		"type":  "block-attrs-updated",
		"id":    blockID,
		"attrs": attrs,
	})
}

// OnBlockReplaced implements block.BlockLifecycleListener.
func (h *WsHandler) OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string) {
	h.sendTo(uuid, map[string]interface{}{
		"type":    "replace-block",
		"oldId":   oldID,
		"newId":   newID,
		"newKind": newKind,
		"attrs":   attrs,
		"newYaml": markdown,
	})
}

func (h *WsHandler) handleExtract(uuid string, raw []byte, writeMsg func(interface{})) {
	var p struct {
		// OpID rides the OUTER envelope (issue #49 Phase 2), correlating the
		// request. The transform path had no direct reply before; extract-ack is it.
		OpID       string               `json:"opId"`
		BlockID    string               `json:"blockId"`
		TargetKind string               `json:"targetKind"`
		Operation  string               `json:"operation"`
		Entries    []block.ContentEntry `json:"entries"`
		Index      int                  `json:"index"`
	}
	p.Index = -1 // default: append when the frontend doesn't specify a position
	if err := json.Unmarshal(raw, &p); err != nil {
		logger.Warn("ws: bad extract payload", "err", err)
		return
	}

	action := block.Action(p.Operation)
	if action == "" {
		action = block.ActionExtract // back-compat default: additive
	}

	newID, rawYaml, err := h.ServiceProvider.Editor.CreateBlockFromEntries(
		uuid, p.TargetKind, p.Entries, p.Index, action, p.BlockID)
	if err != nil {
		logger.Warn("ws: extract block failed", "err", err)
		// Generic error frame UNCHANGED; the extract-ack below carries the opId.
		writeMsg(map[string]interface{}{
			"type":    "error",
			"message": fmt.Sprintf("Failed to extract block: %v", err),
		})
		if p.OpID != "" {
			writeMsg(h.ackFrame("extract-ack", p.OpID, err))
		}
		return
	}

	// TRANSFORM replaces in place — its render-back goes out via OnBlockReplaced
	// ("replace-block"). Only the additive ops (paste/extract) need this caller hint
	// to swap their local placeholder for the newly created block.
	if action != block.ActionTransform {
		writeMsg(map[string]interface{}{
			"type":       "block-extracted",
			"originalId": p.BlockID,
			"newId":      newID,
			"newKind":    p.TargetKind,
			"newYaml":    rawYaml,
		})
	}
	if p.OpID != "" {
		writeMsg(h.ackFrame("extract-ack", p.OpID, nil))
	}
}

func (h *WsHandler) handleSessionWS(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Warn("ws: session upgrade failed", "err", err)
		return
	}
	defer conn.Close()

	var writeMu sync.Mutex
	writeMsg := func(v interface{}) {
		data, err := json.Marshal(v)
		if err != nil {
			return
		}
		writeMu.Lock()
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			logger.Debug("ws: session write failed", "err", err)
		}
		writeMu.Unlock()
	}

	logger.Info("ws: session channel connected")

	ch := &wsConn{write: writeMsg}
	h.register(sessionChannelKey, ch)
	defer func() {
		ch.closed.Store(true)
		h.unregister(sessionChannelKey, ch)
		logger.Info("ws: session channel closed")
	}()

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
		case "ping":
			writeMsg(map[string]string{"type": "pong"})
		case "command":
			h.handleCommand(ch, raw)
		case "command-cancel":
			h.handleCommandCancel(raw)
		case "mention-query":
			h.handleMentionQuery(ch, raw)
		case "mention-resolve":
			h.handleMentionResolve(ch, raw)
		}
	}
}

type commandEnvelope struct {
	Family string `json:"family"`
	Cmd    string `json:"cmd"`
	Args   struct {
		Text string `json:"text"`
	} `json:"args"`
	CorrelationID string          `json:"correlationId"`
	Context       json.RawMessage `json:"context"`
	// Attachments ride EVERY command, not just the AI family. `@` is a composer
	// affordance and the composer is the same textarea that dispatches `/`
	// commands, so the wire carries them unconditionally; what a backend does
	// with them is that backend's problem. They are a SIBLING of Context, never
	// part of it: Context is lens-authored, these are composer-authored.
	Attachments []domain.Attachment `json:"attachments"`
}

// replyTo sends a correlated reply REQUESTER-AFFINELY, per the ownership rule
// (acks→requester, render-backs→registered owner). Every correlated session
// reply is ack-shaped, so it goes back on the socket the request arrived on: the
// registered __session__ owner may have changed since (a dev-server tab
// registering beside the app window silently deposes it — that stole two live
// /btw answers on 2026-07-26). Only when the requester is gone (reconnect) does
// it fall back to the current session owner, so a long-running reply still lands
// somewhere useful.
//
// EVERY session-frame handler must reply through here. Reaching for
// sendTo(sessionChannelKey) directly is precisely the bug.
func (h *WsHandler) replyTo(requester *wsConn, frame interface{}) {
	if requester != nil && !requester.closed.Load() {
		requester.write(frame)
		return
	}
	h.sendTo(sessionChannelKey, frame)
}

// handleCommand dispatches a command frame, replying requester-affinely.
func (h *WsHandler) handleCommand(requester *wsConn, raw []byte) {
	var env commandEnvelope
	if err := json.Unmarshal(raw, &env); err != nil || env.CorrelationID == "" {
		return
	}
	emit := func(o command.Outcome) {
		frame := map[string]interface{}{
			"type":          "command-result",
			"correlationId": env.CorrelationID,
			"cmd":           env.Cmd,
			"status":        o.Status,
		}
		if o.Block != nil {
			frame["block"] = map[string]interface{}{"kind": o.Block.Kind, "attrs": o.Block.Attrs}
		}
		if o.Err != "" {
			frame["error"] = o.Err
		}
		h.replyTo(requester, frame)
	}
	reg := h.ServiceProvider.Commands
	if reg == nil {
		emit(command.Outcome{Status: command.StatusError, Err: "commands unavailable"})
		return
	}
	// Family is passed as an INTEGRITY expectation, not a policy gate: Dispatch
	// validates it against the registered command's declared Family() and emits
	// an ERROR on mismatch. An empty family skips the check (tolerant floor).
	//
	// The Context is assembled HERE, at the wire edge, from BOTH of the
	// envelope's context-bearing fields — the lens-authored `context` JSON and
	// the composer-authored `attachments` list.
	reg.Dispatch(env.Cmd, env.Family, env.Args.Text,
		command.NewContext(env.Context, env.Attachments), env.CorrelationID, emit)
}

// Mention query budget. The limit is client-supplied, so it is floored (an
// absent limit is still a useful query) and capped (an unbounded limit is an
// unbounded library scan on the UI's own socket).
const (
	mentionDefaultLimit = 8
	mentionMaxLimit     = 25
)

// handleMentionQuery answers the `@`-picker's typeahead from the Router's
// enumeration face.
//
// It is a SIBLING FRAME TYPE, not a command: a typeahead needs a sub-100ms
// answer with no JobEngine job, no worker pool and no result block, none of
// which the command envelope's PENDING/COMPLETE lifecycle can give it. It rides
// the same session socket because two sockets on one session is the shape that
// produced silent-dead-UI on document channels (6e2ccfc).
//
// A mention-result is correlated and therefore ack-shaped: it replies through
// replyTo, so a second tab cannot silently steal this tab's typeahead.
func (h *WsHandler) handleMentionQuery(requester *wsConn, raw []byte) {
	var msg struct {
		Q             string `json:"q"`
		Limit         int    `json:"limit"`
		CorrelationID string `json:"correlationId"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.CorrelationID == "" {
		return
	}
	limit := msg.Limit
	if limit <= 0 {
		limit = mentionDefaultLimit
	}
	if limit > mentionMaxLimit {
		limit = mentionMaxLimit
	}

	// Never null: the picker renders a list, and a null is an undefined-length
	// crash rather than "no matches".
	candidates := []domain.Candidate{}
	if h.ServiceProvider.Nodes != nil {
		candidates = append(candidates, h.ServiceProvider.Nodes.Search(msg.Q, limit)...)
	}
	h.replyTo(requester, map[string]interface{}{
		"type":          "mention-result",
		"correlationId": msg.CorrelationID,
		"candidates":    candidates,
	})
}

// handleMentionResolve answers "where does this coordinate open?" from the
// Router's navigation face — the sibling of handleMentionQuery's enumeration.
//
// IT EXISTS SO THE FRONTEND HOLDS COORDINATES AS OPAQUE STRINGS. The click on an
// attachment chip used to decode `container:{uuid}` in JavaScript, which is a
// second implementation of a grammar Go owns (#75) and fails SILENTLY on every
// form it does not know: a `block:{container}/{handle}` address fell through the
// guard and the chip did nothing, with no error anywhere. So the reply carries
// what JS can ACT on — a uuid to open, a block id to reveal — and never anything
// it would have to parse.
//
// An unresolvable address is an ANSWER (found:false + a reason), not a dropped
// frame: a request with no reply is the same silence in a slower costume. Like
// mention-result this is correlated and therefore ack-shaped, so it replies
// through replyTo — requester-affinely.
func (h *WsHandler) handleMentionResolve(requester *wsConn, raw []byte) {
	var msg struct {
		URI           string `json:"uri"`
		CorrelationID string `json:"correlationId"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.CorrelationID == "" {
		return
	}
	// Every key is present in every reply, resolvable or not: a consumer reading
	// `frame.uuid` must never have to tell "absent" from "empty".
	frame := map[string]interface{}{
		"type":          "mention-resolved",
		"correlationId": msg.CorrelationID,
		"uri":           msg.URI,
		"found":         false,
		"uuid":          "",
		"blockId":       "",
		"kind":          "",
		"title":         "",
	}
	switch target, err := h.resolveTarget(msg.URI); {
	case err != nil:
		frame["error"] = err.Error()
	default:
		frame["found"] = true
		frame["uuid"] = target.UUID
		frame["blockId"] = target.BlockID
		frame["kind"] = target.Kind
		frame["title"] = target.Title
	}
	h.replyTo(requester, frame)
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

func (h *WsHandler) handleCommandCancel(raw []byte) {
	var msg struct {
		CorrelationID string `json:"correlationId"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil || msg.CorrelationID == "" {
		return
	}
	if h.ServiceProvider.Commands != nil {
		h.ServiceProvider.Commands.Cancel(msg.CorrelationID)
	}
}
