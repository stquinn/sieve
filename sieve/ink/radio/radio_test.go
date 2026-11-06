package radio

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
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

// fakeChannel is a pollable whose bytes, room and end the test sets.
type fakeChannel struct {
	mu       sync.Mutex
	in       []byte
	readErr  error // returned once in is drained
	room     int
	out      []byte
	writeErr error
	closes   int
}

func (f *fakeChannel) Read(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.in) > 0 {
		n := copy(p, f.in)
		f.in = f.in[n:]
		return n, nil
	}
	return 0, f.readErr
}

func (f *fakeChannel) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.writeErr != nil {
		return 0, f.writeErr
	}
	n := min(f.room, len(p))
	f.out = append(f.out, p[:n]...)
	f.room -= n
	return n, nil
}

func (f *fakeChannel) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closes++
}

// streamRig is a blockingStream over a fakeChannel, and the means to change
// the channel the way its event queue would.
type streamRig struct {
	t      *testing.T
	fake   *fakeChannel
	stream *blockingStream
}

func (r streamRig) arrive(b string) {
	r.fake.mu.Lock()
	r.fake.in = append(r.fake.in, b...)
	r.fake.mu.Unlock()
	r.stream.notify(true)
}

func (r streamRig) endInput(err error) {
	r.fake.mu.Lock()
	r.fake.readErr = err
	r.fake.mu.Unlock()
	r.stream.notify(true)
}

func (r streamRig) makeRoom(n int) {
	r.fake.mu.Lock()
	r.fake.room += n
	r.fake.mu.Unlock()
	r.stream.notify(false)
}

func (r streamRig) failWrites(err error) {
	r.fake.mu.Lock()
	r.fake.writeErr = err
	r.fake.mu.Unlock()
	r.stream.notify(false)
}

// background runs op and returns its outcome, failing the test if op returns
// before blockFor has passed.
func (r streamRig) background(blockFor time.Duration, op func() (int, error)) <-chan result[int] {
	r.t.Helper()
	done := make(chan result[int], 1)
	go func() {
		n, err := op()
		done <- result[int]{n, err}
	}()
	select {
	case got := <-done:
		r.t.Fatalf("returned %d, %v without blocking", got.value, got.err)
	case <-time.After(blockFor):
	}
	return done
}

// outcome waits for a background op.
func (r streamRig) outcome(done <-chan result[int]) result[int] {
	r.t.Helper()
	select {
	case got := <-done:
		return got
	case <-time.After(2 * time.Second):
		r.t.Fatal("still blocked")
		return result[int]{}
	}
}

func TestBlockingStream(t *testing.T) {
	const blocked = 30 * time.Millisecond
	failed := errors.New("stream failed")
	gone := errors.New("companion disconnected")
	tests := []struct {
		name    string
		silence time.Duration
		run     func(r streamRig)
	}{
		{"reads bytes in order across partial reads", 0, func(r streamRig) {
			r.arrive("hello ")
			go func() { time.Sleep(blocked); r.arrive("world") }()
			got := make([]byte, 11)
			buf := make([]byte, 4)
			for read := 0; read < len(got); {
				n, err := r.stream.Read(buf)
				if err != nil {
					r.t.Fatal(err)
				}
				read += copy(got[read:], buf[:n])
			}
			if string(got) != "hello world" {
				r.t.Errorf("read %q", got)
			}
		}},
		{"a read blocks until bytes arrive", 0, func(r streamRig) {
			buf := make([]byte, 8)
			done := r.background(blocked, func() (int, error) { return r.stream.Read(buf) })
			r.arrive("ink")
			if got := r.outcome(done); got.err != nil || string(buf[:got.value]) != "ink" {
				r.t.Errorf("read %q, %v", buf[:got.value], got.err)
			}
		}},
		{"a write waits for room and writes all of p", 0, func(r streamRig) {
			r.makeRoom(3)
			done := r.background(blocked, func() (int, error) { return r.stream.Write([]byte("hello")) })
			r.makeRoom(10)
			if got := r.outcome(done); got.value != 5 || got.err != nil {
				r.t.Errorf("wrote %d, %v", got.value, got.err)
			}
			if string(r.fake.out) != "hello" {
				r.t.Errorf("channel got %q", r.fake.out)
			}
		}},
		{"silence ends a read", blocked, func(r streamRig) {
			started := time.Now()
			_, err := r.stream.Read(make([]byte, 8))
			if !errors.Is(err, errSilent) {
				r.t.Errorf("err %v", err)
			}
			if elapsed := time.Since(started); elapsed < blocked {
				r.t.Errorf("gave up after %v", elapsed)
			}
		}},
		{"end of stream is EOF after the bytes before it", 0, func(r streamRig) {
			r.arrive("x")
			r.endInput(io.EOF)
			buf := make([]byte, 8)
			if n, err := r.stream.Read(buf); n != 1 || err != nil {
				r.t.Errorf("first read %d, %v", n, err)
			}
			if _, err := r.stream.Read(buf); err != io.EOF {
				r.t.Errorf("err %v", err)
			}
		}},
		{"a failed input stream fails a waiting read", 0, func(r streamRig) {
			done := r.background(blocked, func() (int, error) { return r.stream.Read(make([]byte, 8)) })
			r.endInput(failed)
			if got := r.outcome(done); !errors.Is(got.err, failed) {
				r.t.Errorf("err %v", got.err)
			}
		}},
		{"a failed output stream fails a waiting write", 0, func(r streamRig) {
			done := r.background(blocked, func() (int, error) { return r.stream.Write([]byte("x")) })
			r.failWrites(failed)
			if got := r.outcome(done); !errors.Is(got.err, failed) {
				r.t.Errorf("err %v", got.err)
			}
		}},
		{"close unblocks a read", 0, func(r streamRig) {
			done := r.background(blocked, func() (int, error) { return r.stream.Read(make([]byte, 8)) })
			_ = r.stream.Close()
			if got := r.outcome(done); !errors.Is(got.err, net.ErrClosed) {
				r.t.Errorf("err %v", got.err)
			}
		}},
		{"close unblocks a write and reports what was taken", 0, func(r streamRig) {
			r.makeRoom(2)
			done := r.background(blocked, func() (int, error) { return r.stream.Write([]byte("hello")) })
			_ = r.stream.Close()
			if got := r.outcome(done); got.value != 2 || !errors.Is(got.err, net.ErrClosed) {
				r.t.Errorf("wrote %d, %v", got.value, got.err)
			}
		}},
		{"close is idempotent and closes the channel once", 0, func(r streamRig) {
			if r.stream.Close() != nil || r.stream.Close() != nil {
				r.t.Error("close failed")
			}
			if r.fake.closes != 1 {
				r.t.Errorf("channel closed %d times", r.fake.closes)
			}
			if _, err := r.stream.Read(make([]byte, 1)); !errors.Is(err, net.ErrClosed) {
				r.t.Errorf("read after close: %v", err)
			}
			if _, err := r.stream.Write([]byte("x")); !errors.Is(err, net.ErrClosed) {
				r.t.Errorf("write after close: %v", err)
			}
		}},
		{"a failure ends a read and a write, and outlives close", 0, func(r streamRig) {
			reading := r.background(blocked, func() (int, error) { return r.stream.Read(make([]byte, 8)) })
			writing := r.background(0, func() (int, error) { return r.stream.Write([]byte("x")) })
			r.stream.fail(gone)
			if got := r.outcome(reading); !errors.Is(got.err, gone) {
				r.t.Errorf("read err %v", got.err)
			}
			if got := r.outcome(writing); !errors.Is(got.err, gone) {
				r.t.Errorf("write err %v", got.err)
			}
			_ = r.stream.Close()
			if _, err := r.stream.Read(make([]byte, 1)); !errors.Is(err, gone) {
				r.t.Errorf("read after close: %v", err)
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeChannel{}
			rig := streamRig{t: t, fake: fake, stream: newBlockingStream(fake, tt.silence)}
			defer rig.stream.Close()
			tt.run(rig)
		})
	}
}
