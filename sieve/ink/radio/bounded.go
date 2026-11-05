package radio

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var errTimedOut = errors.New("no answer")

// bounded runs a call that takes no deadline of its own and may never return.
type bounded[T any] struct {
	// limit is the longest the caller waits; zero means until ctx ends.
	limit time.Duration
}

// run returns what call returns, or errTimedOut once limit has passed, or
// ctx's error once ctx ends. A call given up on keeps running unwatched.
func (b bounded[T]) run(ctx context.Context, call func() (T, error)) (T, error) {
	type outcome struct {
		value T
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		value, err := call()
		done <- outcome{value, err}
	}()
	var expired <-chan time.Time
	if b.limit > 0 {
		timer := time.NewTimer(b.limit)
		defer timer.Stop()
		expired = timer.C
	}
	var zero T
	select {
	case o := <-done:
		return o.value, o.err
	case <-expired:
		return zero, fmt.Errorf("%w after %v", errTimedOut, b.limit)
	case <-ctx.Done():
		return zero, ctx.Err()
	}
}
