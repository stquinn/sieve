package requesthandlers

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/protocol"
)

// dialWorkspaceWS dials the workspace wire and consumes the connect-time jobs
// snapshot, so a test sees only the traffic it asked for. That the snapshot
// arrives FIRST on every workspace socket is asserted here for all of them.
func dialWorkspaceWS(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	c := dialWorkspaceWSRaw(t, srv)
	if first := readFrame(t, c, 2*time.Second); first["type"] != protocol.TypeJobsChanged {
		t.Fatalf("first frame on a workspace socket = %v, want the jobs snapshot", first["type"])
	}
	return c
}

// waitFor polls until settled, failing with why after two seconds. An
// unanswered frame is written and returns; the write it causes lands on the
// server's own schedule, so a test that asserts the effect has to wait for it.
func waitFor(t *testing.T, settled func() bool, why string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !settled() {
		if time.Now().After(deadline) {
			t.Fatal(why)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// dialWorkspaceWSRaw dials without consuming anything — for the test that reads
// the connect-time push itself.
func dialWorkspaceWSRaw(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	c, _, err := wsDialer().Dial(wsAddr(srv, "/api/ws/workspace"), nil)
	if err != nil {
		t.Fatalf("dial workspace ws: %v", err)
	}
	return c
}

// The workspace socket answers ping with pong and opens NO shadow document.
func TestWS_WorkspaceChannel_PingPong_NoShadow(t *testing.T) {
	srv, sp, _, _ := newWsTestServer(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]string{"type": "ping"}); err != nil {
		t.Fatal(err)
	}
	msg := readFrame(t, conn, 2*time.Second)
	if msg["type"] != "pong" {
		t.Fatalf("want pong, got %v", msg)
	}
	// No shadow was opened for the sentinel key.
	if sp.Editor != nil {
		if _, isOpen := sp.Editor.FrontendBlocks(workspaceChannelKey); isOpen {
			t.Fatal("workspace channel must not open a shadow")
		}
	}
}

// Render-backs to the workspace key land on the CURRENT workspace socket; a stale
// predecessor's teardown must not evict the successor (ownership guard).
func TestWS_WorkspaceChannel_SuccessorOwnsChannel(t *testing.T) {
	srv, _, h, _ := newWsTestServer(t)
	c1 := dialWorkspaceWS(t, srv)
	c2 := dialWorkspaceWS(t, srv) // successor registers over c1
	defer c2.Close()

	closeAndSettle(c1) // stale teardown — must NOT unregister c2
	h.sendTo(workspaceChannelKey, map[string]string{"type": "command-result", "correlationId": "c-x", "status": "PENDING"})

	msg := readFrame(t, c2, 2*time.Second)
	if msg["correlationId"] != "c-x" {
		t.Fatalf("successor did not receive workspace frame: %v", msg)
	}
}

// A dial naming neither wire reaches no upgrade at all: each wire owns a path,
// so the bare prefix is simply not a route.
func TestWS_DialAtBarePrefixIsNotAWire(t *testing.T) {
	srv, _, _, _ := newWsTestServer(t)
	_, resp, err := websocket.DefaultDialer.Dial(wsAddr(srv, "/api/ws"), nil)
	if err == nil {
		t.Fatal("expected error for dial at the bare /api/ws prefix, got nil")
	}
	if resp != nil && resp.StatusCode != 404 {
		t.Fatalf("expected 404 Not Found, got %d", resp.StatusCode)
	}
}

// session-scroll persists a tab's offset and answers nothing: caret-class state
// is not a shared UI change. It names its tab because the workspace channel is
// bound to no document.
func TestWS_SessionScroll_PersistsTheTabsOffset(t *testing.T) {
	srv, sp, _, uuid := newWsTestServer(t)
	session := sp.State.LoadSession()
	session.Tabs = []domain.Tab{{ID: uuid, Mode: "wysiwyg"}}
	if err := sp.State.SaveSession(session); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}

	c := dialWorkspaceWS(t, srv)
	defer c.Close()
	if err := c.WriteJSON(map[string]interface{}{"type": "session-scroll", "id": uuid, "scroll": 420}); err != nil {
		t.Fatalf("write session-scroll: %v", err)
	}

	waitFor(t, func() bool {
		tabs := sp.State.LoadSession().Tabs
		return len(tabs) == 1 && tabs[0].Scroll == 420
	}, "scroll never persisted")

	// Unanswered: a short read yields nothing rather than an ack.
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, raw, err := c.ReadMessage(); err == nil {
		t.Errorf("session-scroll must be unanswered, got %q", string(raw))
	}
}

// "Answers nothing" is the SERVED case only. A frame the handler cannot read —
// an unreadable payload, or one naming no tab — is refused out loud, because
// silence there is indistinguishable from a scroll that was quietly lost.
func TestWS_SessionScroll_UnservableFrameIsRefused(t *testing.T) {
	srv, _, _, _ := newWsTestServer(t)
	c := dialWorkspaceWS(t, srv)
	defer c.Close()

	for _, unservable := range []struct{ name, frame string }{
		{"unreadable payload", `{"type":"session-scroll","id":"tab-1","scroll":"top"}`},
		{"names no tab", `{"type":"session-scroll","scroll":10}`},
	} {
		t.Run(unservable.name, func(t *testing.T) {
			send(t, c, unservable.frame)
			got := readUntil(t, c, "error", 2*time.Second)
			if msg, _ := got["message"].(string); !strings.Contains(msg, "session-scroll") {
				t.Errorf("error message = %q, want it to name the session-scroll frame", msg)
			}
		})
	}
}

// THE SPELLING VERBS CROSS THE WIRES. Each is sent on the workspace wire —
// none of them is about a document — and what a client sees is a text-marks
// frame on the DOCUMENT channel it opened, because clearing a squiggle is the
// only news there is.
//
// The two rows are the two grammars: a word accepted is the feature's own verb,
// while switching the feature off is the lifecycle control frame every producer
// shares.
//
// The ignored word is nonsense on purpose: the harness shares one parsed
// dictionary across the whole test binary, so a word accepted here stays
// accepted, and it must be one nothing else in this package writes.
func TestWS_SpellingVerbsClearMarksOnTheDocumentWire(t *testing.T) {
	cases := []struct {
		name  string
		word  string
		frame string
	}{
		{name: "ignore", word: "zzblorp", frame: `{"type":"spell-ignore","word":"zzblorp"}`},
		{name: "disable", word: "zzquux", frame: `{"type":"feature-control","feature":"spell-check","enabled":false,"parameters":{}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			block.RegisterProcessor(&processors.ProseProcessor{})
			srv, sp, _, uuid := newWsTestServer(t)
			seedBody(t, sp, uuid, "a "+tc.word+" here")

			doc := dialWS(t, srv, uuid)
			marked := readUntil(t, doc, protocol.TypeTextMarks, 2*time.Second)
			if got, _ := marked["marks"].([]interface{}); len(got) != 1 {
				t.Fatalf("opening the document pushed %v, want the one mark", marked["marks"])
			}

			ws := dialWorkspaceWS(t, srv)
			send(t, ws, tc.frame)

			cleared := readUntil(t, doc, protocol.TypeTextMarks, 2*time.Second)
			if got, _ := cleared["marks"].([]interface{}); len(got) != 0 {
				t.Errorf("after %s the document heard %v, want an EMPTY mark set", tc.name, cleared["marks"])
			}
			_ = ws.Close()
			closeAndSettle(doc)
		})
	}
}

// The toggle is a PERSISTED global: the control frame writes settings.json
// BEFORE it is applied, so the answer survives the run that gave it.
func TestWS_FeatureControl_PersistsTheSpellcheckSetting(t *testing.T) {
	srv, sp, _, _ := newWsTestServer(t)
	c := dialWorkspaceWS(t, srv)
	defer c.Close()

	if !sp.State.LoadSettings().SpellcheckEnabled() {
		t.Fatal("spelling starts off; the default is on")
	}
	send(t, c, `{"type":"feature-control","feature":"spell-check","enabled":false,"parameters":{}}`)
	waitFor(t, func() bool { return !sp.State.LoadSettings().SpellcheckEnabled() },
		"the spellcheck setting was never persisted as off")

	send(t, c, `{"type":"feature-control","feature":"spell-check","enabled":true,"parameters":{}}`)
	waitFor(t, func() bool { return sp.State.LoadSettings().SpellcheckEnabled() },
		"the spellcheck setting was never persisted back on")
}
