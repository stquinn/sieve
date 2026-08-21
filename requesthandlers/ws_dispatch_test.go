package requesthandlers

import (
	"strings"
	"testing"
	"time"

	"sieve/sieve/protocol"

	"github.com/gorilla/websocket"
)

// A word the contract does not carry is REFUSED, not ignored: the client that
// sent it learns immediately rather than waiting on a reply that is never coming.
func TestWS_UnknownFrameTypeIsRefusedOnBothChannels(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	doc := dialWS(t, srv, uuid)
	if err := doc.WriteJSON(map[string]string{"type": "not-a-frame"}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnknown(t, doc, "not-a-frame")
	closeAndSettle(doc)

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()
	if err := ws.WriteJSON(map[string]string{"type": "not-a-frame"}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnknown(t, ws, "not-a-frame")
}

// A server-only word landing on the channel it actually belongs to is still
// refused as UNKNOWN, not as "not handled yet": the registry entry exists, but
// its Direction is Outbound, so the gate must not treat presence alone as
// permission to reach the handler map.
func TestWS_OutboundOnlyFrameIsRefusedAsUnknown(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	doc := dialWS(t, srv, uuid)
	if err := doc.WriteJSON(map[string]string{"type": protocol.TypeInsertBlock}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnknown(t, doc, protocol.TypeInsertBlock)
	closeAndSettle(doc)

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()
	if err := ws.WriteJSON(map[string]string{"type": protocol.TypeJobsChanged}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnknown(t, ws, protocol.TypeJobsChanged)
}

// The channel is half of a frame's identity: a workspace word spoken on a
// document socket resolves to nothing in the registry and is refused there, and
// the reverse likewise — no handler map can be reached across the wires.
func TestWS_FrameFromTheOtherChannelIsRefused(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	doc := dialWS(t, srv, uuid)
	if err := doc.WriteJSON(map[string]string{"type": protocol.TypeMentionQuery, "correlationId": "c-1"}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnknown(t, doc, protocol.TypeMentionQuery)
	closeAndSettle(doc)

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()
	if err := ws.WriteJSON(map[string]string{"type": protocol.TypeFlush}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnknown(t, ws, protocol.TypeFlush)
}

// A registered word with no handler behind it yet also gets an answer, so the
// gap shows up as a refusal in the log and in the UI rather than as silence.
func TestWS_RegisteredFrameWithNoHandlerIsAnswered(t *testing.T) {
	srv, _, h, uuid := newWsTestServer(t)
	if _, ok := h.documentFrames[protocol.TypeLoad]; ok {
		t.Skip("load now has a handler — this pin covers only the unserved case")
	}

	doc := dialWS(t, srv, uuid)
	defer doc.Close()
	if err := doc.WriteJSON(map[string]string{"type": protocol.TypeLoad, "opId": "op-load"}); err != nil {
		t.Fatal(err)
	}
	assertRefusedAsUnhandled(t, doc, protocol.TypeLoad)
}

// Every frame type the dispatch tables serve must be in the registry on the
// channel it is served on — a handler the gate cannot open is dead code.
func TestWS_EveryHandledFrameTypeIsRegistered(t *testing.T) {
	h := NewWsHandler(nil, NewWorkspaceBroadcast(nil))
	reg := protocol.NewRegistry()
	tables := map[protocol.Channel]map[string]frameHandler{
		protocol.ChannelDocument:  h.documentFrames,
		protocol.ChannelWorkspace: h.workspaceFrames,
	}
	for channel, handlers := range tables {
		for frameType := range handlers {
			entry, ok := reg.Frame(channel, frameType)
			if !ok {
				t.Errorf("%s handler %q is not in the registry", channel, frameType)
				continue
			}
			if entry.Direction != protocol.Inbound {
				t.Errorf("%s handler %q is registered %s, want inbound", channel, frameType, entry.Direction)
			}
		}
	}
}

// Every served frame refuses a payload it cannot read, on both wires. The one
// exception is flush, which decodes nothing at all — there is nothing under its
// type word to misread, and persistence must not depend on the shape of the
// request asking for it.
func TestWS_EveryServedFrameRefusesAnUnreadablePayload(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	doc := dialWS(t, srv, uuid)
	for _, malformed := range []struct{ name, frame string }{
		{protocol.TypeBlockOp, `{"type":"block-op","op":"not-an-op"}`},
		{protocol.TypeDocUpdate, `{"type":"doc-update","markdown":[1,2]}`},
		{protocol.TypeRetryBlockJob, `{"type":"retry-block-job","id":42}`},
		{protocol.TypeExtract, `{"type":"extract","entries":"not-a-list"}`},
		{protocol.TypeEnterMarkdown, `{"type":"enter-markdown","opId":42}`},
		{protocol.TypeEnterWysiwyg, `{"type":"enter-wysiwyg","markdown":[1,2]}`},
	} {
		t.Run(malformed.name, func(t *testing.T) {
			send(t, doc, malformed.frame)
			assertRefusedAsUnreadable(t, doc, malformed.name)
		})
	}
	closeAndSettle(doc)

	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()
	for _, malformed := range []struct{ name, frame string }{
		{protocol.TypeCommand, `{"type":"command","correlationId":"c-1","args":"not-an-object"}`},
		{protocol.TypeCommandCancel, `{"type":"command-cancel","correlationId":7}`},
		{protocol.TypeMentionQuery, `{"type":"mention-query","correlationId":"c-1","q":[]}`},
		{protocol.TypeMentionResolve, `{"type":"mention-resolve","correlationId":"c-1","uri":9}`},
	} {
		t.Run(malformed.name, func(t *testing.T) {
			send(t, ws, malformed.frame)
			assertRefusedAsUnreadable(t, ws, malformed.name)
		})
	}
}

// A correlated frame carrying no correlation id is refused for the same reason:
// its answer would have nowhere to go, and the caller is waiting for one.
func TestWS_CorrelatedFrameWithNoCorrelationIDIsRefused(t *testing.T) {
	srv, _, _, _ := newWsTestServer(t)
	ws := dialWorkspaceWS(t, srv)
	defer ws.Close()

	for _, frameType := range []string{
		protocol.TypeCommand, protocol.TypeCommandCancel,
		protocol.TypeMentionQuery, protocol.TypeMentionResolve,
	} {
		t.Run(frameType, func(t *testing.T) {
			send(t, ws, `{"type":"`+frameType+`"}`)
			assertErrorFrame(t, ws, frameType, "correlation id")
		})
	}
}

// The two refusals are told apart by their wording, which is what makes the
// registry gate OBSERVABLE: a word refused as "unknown" never reached the
// handler map at all.
func assertRefusedAsUnknown(t *testing.T, c *websocket.Conn, frameType string) {
	t.Helper()
	assertErrorFrame(t, c, frameType, "unknown")
}

func assertRefusedAsUnhandled(t *testing.T, c *websocket.Conn, frameType string) {
	t.Helper()
	assertErrorFrame(t, c, frameType, "not handled yet")
}

// The third refusal: the word is known and served, but this payload is not one.
func assertRefusedAsUnreadable(t *testing.T, c *websocket.Conn, frameType string) {
	t.Helper()
	assertErrorFrame(t, c, frameType, "unreadable")
}

func assertErrorFrame(t *testing.T, c *websocket.Conn, frameType, reason string) {
	t.Helper()
	frame := readUntil(t, c, protocol.TypeError, 2*time.Second)
	msg, _ := frame["message"].(string)
	if !strings.Contains(msg, frameType) || !strings.Contains(msg, reason) {
		t.Fatalf("error message = %q, want it to name %q and read as %q", msg, frameType, reason)
	}
}
