package logger

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

// SetDebug gates whether Debug-level records are emitted. Before this the handler
// was hardcoded to LevelDebug, so the settings.json "debug" flag controlled
// nothing. The shared level var (referenced by handlerOpts) must flip real
// filtering: off => Debug suppressed, on => Debug emitted. Restore afterwards so
// the test leaves no global side effect.
func TestSetDebug_GatesDebugLevel(t *testing.T) {
	t.Cleanup(func() { SetDebug(false) })

	var buf bytes.Buffer
	l := slog.New(slog.NewTextHandler(&buf, handlerOpts()))

	SetDebug(false)
	l.Debug("hidden-line")
	l.Info("info-always")
	if strings.Contains(buf.String(), "hidden-line") {
		t.Errorf("Debug emitted while debug is OFF: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "info-always") {
		t.Errorf("Info suppressed while debug is OFF (only Debug should be gated): %q", buf.String())
	}

	buf.Reset()
	SetDebug(true)
	l.Debug("shown-line")
	if !strings.Contains(buf.String(), "shown-line") {
		t.Errorf("Debug suppressed while debug is ON: %q", buf.String())
	}
}
