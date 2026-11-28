// Package clocktest is a clock a test moves by hand, for a type that reads the time through a
// now func and waits through an afterFunc func, as the namers do, and a wait on the wall clock for
// what such a type does on goroutines of its own.
package clocktest

import (
	"sync"
	"testing"
	"time"
)

// WaitFor returns once ok does, polling it on the wall clock, and fails t when it has not within
// five seconds.
func WaitFor(t testing.TB, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("never settled")
		}
		time.Sleep(time.Millisecond)
	}
}

// Clock is a clock a test moves: a timer fires when Advance passes its time. It starts an hour
// ahead of the wall clock, to the second, so every save a store stamps during a test reads as long
// past. It is safe for concurrent use.
type Clock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*timer
}

type timer struct {
	at      time.Time
	f       func()
	stopped bool
}

// New is a clock an hour ahead of the wall clock, to the second.
func New() *Clock {
	return &Clock{now: time.Now().Add(time.Hour).Truncate(time.Second)}
}

// Now is the clock's time.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

// AfterFunc calls f once the clock has been advanced by d from now, unless the stop it returns is
// called first; stop reports whether it stopped a timer that had not fired.
func (c *Clock) AfterFunc(d time.Duration, f func()) (stop func() bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &timer{at: c.now.Add(d), f: f}
	c.timers = append(c.timers, t)
	return func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

// Advance moves the clock on by d and fires, in time order, every timer due by then, those the
// fired ones set included.
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
	for {
		c.mu.Lock()
		var due *timer
		for _, t := range c.timers {
			if !t.stopped && !t.at.After(c.now) && (due == nil || t.at.Before(due.at)) {
				due = t
			}
		}
		if due != nil {
			due.stopped = true
		}
		c.mu.Unlock()
		if due == nil {
			return
		}
		due.f()
	}
}
