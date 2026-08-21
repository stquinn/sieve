package requesthandlers

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sieve/sieve/protocol"
)

// A peer that stops reading must not park the writer forever: writerFor sets
// wsWriteTimeout on every write, so a stalled connection times out instead of
// blocking the fan-out (and its caller — a JobEngine pool worker or the
// fs-watcher goroutine) indefinitely. wsWriteTimeout is shrunk here so the
// timeout itself, not wall-clock luck, is what bounds the test.
func TestWsHandler_WriterForBoundsAStalledWrite(t *testing.T) {
	prevTimeout := wsWriteTimeout
	wsWriteTimeout = 100 * time.Millisecond
	defer func() { wsWriteTimeout = prevTimeout }()

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	connCh := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		connCh <- c
	}))
	defer srv.Close()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	client, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer client.Close()
	// The point of the test: this connection never reads again, so its TCP
	// receive window stops advancing and the server's send buffer fills.
	if tcp, ok := client.UnderlyingConn().(*net.TCPConn); ok {
		_ = tcp.SetReadBuffer(1024)
	}

	var server *websocket.Conn
	select {
	case server = <-connCh:
	case <-time.After(2 * time.Second):
		t.Fatal("server never upgraded")
	}
	if tcp, ok := server.UnderlyingConn().(*net.TCPConn); ok {
		_ = tcp.SetWriteBuffer(1024)
	}

	h := &WsHandler{}
	write := h.writerFor(server, protocol.ChannelWorkspace, "")

	// Large enough, and enough of them, to exceed any plausible kernel send
	// buffer even if the shrink above is only a hint the OS partially honours.
	payload := strings.Repeat("x", 64*1024)
	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			write(map[string]string{"type": "probe", "payload": payload})
		}
		close(done)
	}()

	select {
	case <-done:
		// writerFor returned for every call — the stalled peer cost at most
		// wsWriteTimeout, not a permanent block.
	case <-time.After(3 * time.Second):
		t.Fatal("writerFor never returned for a stalled peer — SetWriteDeadline is not bounding the write")
	}
}
