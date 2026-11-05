package radio

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var errTimedOut = errors.New("no answer")

// result is what a call or a callback answers.
type result[T any] struct {
	value T
	err   error
}

// mailbox holds at most one answer, for a callback that must never block.
// Make it with capacity 1.
type mailbox[T any] chan result[T]

// offer leaves an answer unless one is already waiting.
func (m mailbox[T]) offer(value T, err error) {
	select {
	case m <- result[T]{value, err}:
	default:
	}
}

// bounded waits for an answer that has no deadline of its own and may never come.
type bounded[T any] struct {
	// limit is the longest the caller waits; zero means until ctx ends.
	limit time.Duration
}

// run returns what call returns, or errTimedOut once limit has passed, or
// ctx's error once ctx ends. A call given up on keeps running unwatched.
func (b bounded[T]) run(ctx context.Context, call func() (T, error)) (T, error) {
	done := make(chan result[T], 1)
	go func() {
		value, err := call()
		done <- result[T]{value, err}
	}()
	return b.wait(ctx, done)
}

// wait returns the first answer on answers, or errTimedOut once limit has
// passed, or ctx's error once ctx ends. A sender must not block on answers.
func (b bounded[T]) wait(ctx context.Context, answers <-chan result[T]) (T, error) {
	var expired <-chan time.Time
	if b.limit > 0 {
		timer := time.NewTimer(b.limit)
		defer timer.Stop()
		expired = timer.C
	}
	var zero T
	select {
	case r := <-answers:
		return r.value, r.err
	case <-expired:
		return zero, fmt.Errorf("%w after %v", errTimedOut, b.limit)
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}
