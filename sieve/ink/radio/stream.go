package radio

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// errSilent is a Read that waited the whole silence limit and received nothing.
var errSilent = errors.New("l2cap read: nothing received")

// pollable is a byte channel whose Read and Write never block. Each returns 0
// and a nil error when the channel has nothing to give or no room to take; Read
// returns io.EOF at the end of the stream. Close is idempotent, and Read and
// Write stay safe to call after it.
type pollable interface {
	Read(p []byte) (int, error)
	Write(p []byte) (int, error)
	Close()
}

// blockingStream gives a pollable channel blocking io.Reader and io.Writer
// semantics. Whoever delivers the channel's events calls notify; it never
// blocks, so it is safe on a callback queue that must not stall.
type blockingStream struct {
	ch pollable
	// silence is the longest one Read waits with nothing received; zero waits for ever.
	silence time.Duration

	// calls serialises every call into ch.
	calls   sync.Mutex
	readers sync.Mutex
	writers sync.Mutex

	readable chan struct{}
	writable chan struct{}

	ended     chan struct{}
	endOnce   sync.Once
	cause     error
	closeOnce sync.Once
}

func newBlockingStream(ch pollable, silence time.Duration) *blockingStream {
	return &blockingStream{
		ch:       ch,
		silence:  silence,
		readable: make(chan struct{}, 1),
		writable: make(chan struct{}, 1),
		ended:    make(chan struct{}),
	}
}

// notify wakes a Read (input) or a Write (!input) waiting on the channel.
func (s *blockingStream) notify(input bool) {
	wake := s.writable
	if input {
		wake = s.readable
	}
	select {
	case wake <- struct{}{}:
	default:
	}
}

// fail ends the stream: every Read and Write from now on, and any one waiting,
// returns cause. The first cause wins.
func (s *blockingStream) fail(cause error) {
	s.endOnce.Do(func() {
		s.cause = cause
		close(s.ended)
	})
}

// Read blocks until it can return at least one byte, the channel ends or
// fails, the stream is closed or failed, or silence passes with nothing
// received.
func (s *blockingStream) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	s.readers.Lock()
	defer s.readers.Unlock()
	var silent <-chan time.Time
	if s.silence > 0 {
		timer := time.NewTimer(s.silence)
		defer timer.Stop()
		silent = timer.C
	}
	for {
		if err := s.endedErr(); err != nil {
			return 0, err
		}
		n, err := s.call(s.ch.Read, p)
		if n > 0 || err != nil {
			return n, err
		}
		select {
		case <-s.readable:
		case <-s.ended:
		case <-silent:
			return 0, fmt.Errorf("%w for %v", errSilent, s.silence)
		}
	}
}

// Write blocks until all of p is written, the channel fails, or the stream is
// closed or failed. It returns how many bytes the channel took.
func (s *blockingStream) Write(p []byte) (int, error) {
	s.writers.Lock()
	defer s.writers.Unlock()
	sent := 0
	for sent < len(p) {
		if err := s.endedErr(); err != nil {
			return sent, err
		}
		n, err := s.call(s.ch.Write, p[sent:])
		sent += n
		if err != nil {
			return sent, err
		}
		if n > 0 {
			continue
		}
		select {
		case <-s.writable:
		case <-s.ended:
		}
	}
	return sent, nil
}

// Close closes the channel and unblocks any Read or Write, which return
// net.ErrClosed unless the stream had already failed. It is idempotent.
func (s *blockingStream) Close() error {
	s.fail(net.ErrClosed)
	s.closeOnce.Do(func() {
		s.calls.Lock()
		defer s.calls.Unlock()
		s.ch.Close()
	})
	return nil
}

func (s *blockingStream) endedErr() error {
	select {
	case <-s.ended:
		return s.cause
	default:
		return nil
	}
}

func (s *blockingStream) call(op func([]byte) (int, error), p []byte) (int, error) {
	s.calls.Lock()
	defer s.calls.Unlock()
	return op(p)
}
