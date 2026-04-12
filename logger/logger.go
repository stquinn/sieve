// Package logger provides a simple structured logger for Stash.
// Output goes to stderr so it doesn't interfere with Wails stdout protocol.
// Format: [stash] LEVEL  message  key=value ...
package logger

import (
	"log/slog"
	"os"
)

var log *slog.Logger

func init() {
	log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelDebug,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			// Prefix every log line so it's easy to grep
			if a.Key == slog.MessageKey {
				a.Value = slog.StringValue("[stash] " + a.Value.String())
			}
			return a
		},
	}))
}

func Debug(msg string, args ...any) { log.Debug(msg, args...) }
func Info(msg string, args ...any)  { log.Info(msg, args...) }
func Warn(msg string, args ...any)  { log.Warn(msg, args...) }
func Error(msg string, args ...any) { log.Error(msg, args...) }
