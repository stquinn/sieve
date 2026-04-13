// Package logger provides a simple structured logger for Stash.
// When stderr is a TTY (terminal) logs go there for dev convenience.
// When launched from the Dock or Finder (no TTY) logs go to
// ~/Library/Logs/Stash/stash.log so they are inspectable via Console.app.
// The log file is rotated at 5 MB and 3 compressed backups are kept.
package logger

import (
	"log/slog"
	"os"
	"path/filepath"

	"golang.org/x/term"
	"gopkg.in/lumberjack.v2"
)

var log *slog.Logger

func init() {
	var handler slog.Handler

	if term.IsTerminal(int(os.Stderr.Fd())) {
		handler = slog.NewTextHandler(os.Stderr, handlerOpts())
	} else {
		logDir := filepath.Join(os.Getenv("HOME"), "Library", "Logs", "Stash")
		_ = os.MkdirAll(logDir, 0o755)
		rotated := &lumberjack.Logger{
			Filename:   filepath.Join(logDir, "stash.log"),
			MaxSize:    5,    // MB before rotation
			MaxBackups: 3,    // rotated files to keep
			Compress:   true, // gzip old files
		}
		handler = slog.NewTextHandler(rotated, handlerOpts())
	}

	log = slog.New(handler)
}

func handlerOpts() *slog.HandlerOptions {
	return &slog.HandlerOptions{
		Level: slog.LevelDebug,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.MessageKey {
				a.Value = slog.StringValue("[stash] " + a.Value.String())
			}
			return a
		},
	}
}

func Debug(msg string, args ...any) { log.Debug(msg, args...) }
func Info(msg string, args ...any)  { log.Info(msg, args...) }
func Warn(msg string, args ...any)  { log.Warn(msg, args...) }
func Error(msg string, args ...any) { log.Error(msg, args...) }
