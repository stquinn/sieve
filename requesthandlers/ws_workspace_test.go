package requesthandlers

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

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

// dialWorkspaceWSRaw dials without consuming anything — for the test that reads
// the connect-time push itself.
func dialWorkspaceWSRaw(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws/workspace"
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
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
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
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

	deadline := time.Now().Add(2 * time.Second)
	for {
		tabs := sp.State.LoadSession().Tabs
		if len(tabs) == 1 && tabs[0].Scroll == 420 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("scroll never persisted, tabs = %v", tabs)
		}
		time.Sleep(20 * time.Millisecond)
	}

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
