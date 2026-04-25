// Package logger provides a simple structured logger for Sieve.
// When stderr is a TTY (terminal) logs go there for dev convenience.
// When launched from the Dock or Finder (no TTY) logs go to
// ~/Library/Logs/Sieve/sieve.log so they are inspectable via Console.app.
// The log file is rotated at 5 MB and 3 compressed backups are kept.
package logger

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/term"
	"gopkg.in/lumberjack.v2"
)

var log *slog.Logger
var out io.Writer

func init() {
	var handler slog.Handler

	if term.IsTerminal(int(os.Stderr.Fd())) {
		out = os.Stderr
		handler = slog.NewTextHandler(out, handlerOpts())
	} else {
		logDir := filepath.Join(os.Getenv("HOME"), "Library", "Logs", "Sieve")
		_ = os.MkdirAll(logDir, 0o755)
		rotated := &lumberjack.Logger{
			Filename:   filepath.Join(logDir, "sieve.log"),
			MaxSize:    5,    // MB before rotation
			MaxBackups: 3,    // rotated files to keep
			Compress:   true, // gzip old files
		}
		out = rotated
		handler = slog.NewTextHandler(out, handlerOpts())
	}

	log = slog.New(handler)
}

func handlerOpts() *slog.HandlerOptions {
	return &slog.HandlerOptions{
		Level: slog.LevelDebug,
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.MessageKey {
				a.Value = slog.StringValue("[sieve] " + a.Value.String())
			}
			return a
		},
	}
}

func Debug(msg string, args ...any) { log.Debug(msg, args...) }
func Info(msg string, args ...any)  { log.Info(msg, args...) }
func Warn(msg string, args ...any)  { log.Warn(msg, args...) }
func Error(msg string, args ...any) { log.Error(msg, args...) }
 
// LogPrompt logs a multi-line AI prompt efficiently.
func LogPrompt(prompt string) {
	logBlock("AI PROMPT", prompt)
}

// LogResponse logs a multi-line AI response efficiently.
func LogResponse(response string) {
	logBlock("AI RESPONSE", response)
}

func logBlock(label string, content string) {
	const maxLen = 5000
	display := strings.TrimSpace(content)
	if len(display) > maxLen {
		display = display[:maxLen] + "\n... [TRUNCATED]"
	}
	fmt.Fprintf(out, "\n==================== %s ====================\n%s\n===================================================\n\n", label, display)
}
