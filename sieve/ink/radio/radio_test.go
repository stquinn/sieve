package radio

import (
	"context"
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

func TestBoundedRun(t *testing.T) {
	failed := errors.New("failed")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	release := make(chan struct{})
	defer close(release)
	hang := func() (int, error) { <-release; return 1, nil }

	tests := []struct {
		name    string
		ctx     context.Context
		limit   time.Duration
		call    func() (int, error)
		want    int
		wantErr error
	}{
		{"passes the value through", context.Background(), time.Second, func() (int, error) { return 7, nil }, 7, nil},
		{"passes the error through", context.Background(), time.Second, func() (int, error) { return 0, failed }, 0, failed},
		{"times out a call that never returns", context.Background(), 20 * time.Millisecond, hang, 0, errTimedOut},
		{"ends when the context ends", cancelled, 0, hang, 0, context.Canceled},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			started := time.Now()
			got, err := bounded[int]{limit: tt.limit}.run(tt.ctx, tt.call)
			if got != tt.want || !errors.Is(err, tt.wantErr) {
				t.Errorf("got %d, %v; want %d, %v", got, err, tt.want, tt.wantErr)
			}
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Errorf("took %v", elapsed)
			}
		})
	}
}

func TestTCPDial(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	peerGot := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buf := make([]byte, 5)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return
		}
		peerGot <- string(buf)
		_, _ = conn.Write([]byte("world"))
		_, _ = io.Copy(io.Discard, conn)
	}()

	link, err := NewTCP(listener.Addr().String(), "companion-1").Dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if link.Identity() != "companion-1" {
		t.Errorf("identity %q", link.Identity())
	}
	if link.Elapsed() <= 0 {
		t.Errorf("elapsed %v", link.Elapsed())
	}
	if _, err := link.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if got := <-peerGot; got != "hello" {
		t.Errorf("peer received %q", got)
	}
	reply := make([]byte, 5)
	if _, err := io.ReadFull(link, reply); err != nil || string(reply) != "world" {
		t.Errorf("read %q, %v", reply, err)
	}
	if err := link.Close(); err != nil {
		t.Errorf("close: %v", err)
	}
	if _, err := link.Write([]byte("x")); err == nil {
		t.Error("write after close succeeded")
	}
}

func TestTCPDialFailures(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close()

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	tests := []struct {
		name string
		ctx  context.Context
		addr string
	}{
		{"nothing listening", context.Background(), addr},
		{"context cancelled before dialling", cancelled, "10.255.255.1:9"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			started := time.Now()
			link, err := NewTCP(tt.addr, "x").Dial(tt.ctx)
			if err == nil {
				link.Close()
				t.Fatal("dial succeeded")
			}
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Errorf("took %v", elapsed)
			}
		})
	}
}
