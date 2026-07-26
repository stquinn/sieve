package requesthandlers

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func dialSessionWS(t *testing.T, srv *httptest.Server) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws?session=1"
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial session ws: %v", err)
	}
	return c
}

// Session socket connects with ?session=1 (no uuid), answers ping with pong,
// and opens NO shadow document.
func TestWS_SessionChannel_PingPong_NoShadow(t *testing.T) {
	srv, sp, _, _ := newWsTestServer(t)
	conn := dialSessionWS(t, srv)
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
		if _, isOpen := sp.Editor.FrontendBlocks(sessionChannelKey); isOpen {
			t.Fatal("session channel must not open a shadow")
		}
	}
}

// Render-backs to the session key land on the CURRENT session socket; a stale
// predecessor's teardown must not evict the successor (ownership guard).
func TestWS_SessionChannel_SuccessorOwnsChannel(t *testing.T) {
	srv, _, h, _ := newWsTestServer(t)
	c1 := dialSessionWS(t, srv)
	c2 := dialSessionWS(t, srv) // successor registers over c1
	defer c2.Close()

	closeAndSettle(c1) // stale teardown — must NOT unregister c2
	h.sendTo(sessionChannelKey, map[string]string{"type": "command-result", "correlationId": "c-x", "status": "PENDING"})

	msg := readFrame(t, c2, 2*time.Second)
	if msg["correlationId"] != "c-x" {
		t.Fatalf("successor did not receive session frame: %v", msg)
	}
}

func TestWS_SessionChannel_NoUUIDOrSession400(t *testing.T) {
	srv, _, _, _ := newWsTestServer(t)
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws"
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil {
		t.Fatal("expected error for dial with no params, got nil")
	}
	if resp != nil && resp.StatusCode != 400 {
		t.Fatalf("expected 400 Bad Request, got %d", resp.StatusCode)
	}
}
