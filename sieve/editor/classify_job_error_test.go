package editor

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"sieve/sieve/block"
)

// classifyJobError is the framework's single error-to-status mapper. A
// deadline/timeout (wrapped context.DeadlineExceeded or a "timeout" string the
// CLI produces without wrapping it) settles as TIMEOUT; everything else is ERROR.
func TestClassifyJobError(t *testing.T) {
	es := &EditorService{}
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"wrapped DeadlineExceeded", fmt.Errorf("run failed: %w", context.DeadlineExceeded), block.BlockStatusTimeout},
		{"bare DeadlineExceeded", context.DeadlineExceeded, block.BlockStatusTimeout},
		{"cli timeout string (unwrapped)", errors.New("cli timeout after 20 seconds"), block.BlockStatusTimeout},
		{"generic error", errors.New("boom"), block.BlockStatusError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := es.classifyJobError(tc.err); got != tc.want {
				t.Fatalf("classifyJobError(%v) = %q, want %q", tc.err, got, tc.want)
			}
		})
	}
}
