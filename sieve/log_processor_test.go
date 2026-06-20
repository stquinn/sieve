package sieve

import (
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"testing"
)

func TestParseLogLines_SpringBoot(t *testing.T) {
	logSource := `2026-06-12T13:20:01.984+01:00  INFO 1 --- [       Thread-1] i.s.toastie.engine.StateMachine          : State Machine will supply state HeatingState{...}
2026-06-12T13:20:01.989+01:00  ERROR 1 --- [       Thread-1] i.s.toastie.engine.ToastieEngine         : Boom!`

	parsed := parseLogLines(logSource, nil)

	if parsed.Format != "Spring Boot" {
		t.Errorf("Expected format to be Spring Boot, got %s", parsed.Format)
	}

	if len(parsed.Lines) != 2 {
		t.Fatalf("Expected 2 lines, got %d", len(parsed.Lines))
	}

	if parsed.Lines[0].Level != "INFO" {
		t.Errorf("Expected INFO, got %s", parsed.Lines[0].Level)
	}
	if parsed.Lines[0].Severity != "info" {
		t.Errorf("Expected severity info, got %s", parsed.Lines[0].Severity)
	}
	if parsed.Lines[0].Thread != "Thread-1" {
		t.Errorf("Expected thread Thread-1, got %s", parsed.Lines[0].Thread)
	}
	if parsed.Lines[0].Logger != "i.s.toastie.engine.StateMachine" {
		t.Errorf("Expected logger i.s.toastie.engine.StateMachine, got %s", parsed.Lines[0].Logger)
	}

	if parsed.Lines[1].Level != "ERROR" {
		t.Errorf("Expected ERROR, got %s", parsed.Lines[1].Level)
	}
	if parsed.Lines[1].Severity != "error" {
		t.Errorf("Expected severity error, got %s", parsed.Lines[1].Severity)
	}
}

func TestParseLogLines_GoGeneric(t *testing.T) {
	logSource := `time=2026-06-12T13:21:24.207+01:00 level=DEBUG msg="[sieve] request" method=GET path=/api/ai/active-jobs
time=2026-06-12T13:21:24.223+01:00 level=WARN msg="[sieve] filestore: UUID index miss for %s - scanning" !BADKEY=123
time=2026-06-12T13:21:24.227+01:00 level=ERROR msg="[sieve] editor: open" uuid=123 body_bytes=2121`

	parsed := parseLogLines(logSource, nil)

	if parsed.Format != "Smarter Fallback" {
		t.Errorf("Expected format to be Smarter Fallback, got %s", parsed.Format)
	}

	if len(parsed.Lines) != 3 {
		t.Fatalf("Expected 3 lines, got %d", len(parsed.Lines))
	}

	if parsed.Lines[0].Level != "DEBUG" {
		t.Errorf("Expected DEBUG, got %s", parsed.Lines[0].Level)
	}
	if parsed.Lines[0].Severity != "info" {
		t.Errorf("Expected severity info, got %s", parsed.Lines[0].Severity)
	}

	if parsed.Lines[1].Level != "WARN" {
		t.Errorf("Expected WARN, got %s", parsed.Lines[1].Level)
	}
	if parsed.Lines[1].Severity != "warn" {
		t.Errorf("Expected severity warn, got %s", parsed.Lines[1].Severity)
	}

	if parsed.Lines[2].Level != "ERROR" {
		t.Errorf("Expected ERROR, got %s", parsed.Lines[2].Level)
	}
	if parsed.Lines[2].Severity != "error" {
		t.Errorf("Expected severity error, got %s", parsed.Lines[2].Severity)
	}
}

func TestParseLogLines_Radarr(t *testing.T) {
	logSource := `[Info] RssSyncService: RSS Sync Completed. Reports found: 100, Reports grabbed: 0`

	parsed := parseLogLines(logSource, []domain.CustomLogParser{{Name: "Radarr", Pattern: `^\[(?P<level>[A-Za-z]+)\]\s+(?P<logger>.*?):\s+(?P<message>.*)$`}})

	if len(parsed.Lines) != 1 {
		t.Fatalf("Expected 1 line, got %d", len(parsed.Lines))
	}

	if parsed.Lines[0].Level != "INFO" {
		t.Errorf("Expected INFO, got %s", parsed.Lines[0].Level)
	}
	if parsed.Lines[0].Severity != "info" {
		t.Errorf("Expected severity info, got %s", parsed.Lines[0].Severity)
	}
	if parsed.Lines[0].Logger != "RssSyncService" {
		t.Errorf("Expected logger RssSyncService, got %s", parsed.Lines[0].Logger)
	}
}

func TestParseLogLines_JSON(t *testing.T) {
	logSource := `{"time": "2026-06-12T13:20:01", "level": "WARN", "logger": "auth", "msg": "failed to login"}`

	parsed := parseLogLines(logSource, nil)

	if len(parsed.Lines) != 1 {
		t.Fatalf("Expected 1 line, got %d", len(parsed.Lines))
	}
	if parsed.Format != "json" {
		t.Errorf("Expected format json, got %s", parsed.Format)
	}

	if parsed.Lines[0].Level != "WARN" {
		t.Errorf("Expected WARN, got %s", parsed.Lines[0].Level)
	}
	if parsed.Lines[0].Logger != "auth" {
		t.Errorf("Expected logger auth, got %s", parsed.Lines[0].Logger)
	}
	if parsed.Lines[0].Message != "failed to login" {
		t.Errorf("Expected message 'failed to login', got %s", parsed.Lines[0].Message)
	}
}

func TestLogProcessor_IsBlock(t *testing.T) {
	proc := NewLogProcessor(block.BlockServices{})

	// Test generic block text that looks like a log
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "[ERROR] Something went wrong"}}
	if !proc.IsBlock(entries) {
		t.Errorf("Expected IsBlock to be true for '[ERROR]'")
	}

	// Test code block extraction
	codeEntry := []block.ContentEntry{{MIMEType: "sieve/code", Content: "```\n2026-06-12T13:20:01.984+01:00 INFO\n```"}}
	if !proc.IsBlock(codeEntry) {
		t.Errorf("Expected IsBlock to be true for code block with ISO date and INFO")
	}

	// Test negative case
	nonLogEntry := []block.ContentEntry{{MIMEType: "text/plain", Content: "Just a regular sentence without log signatures."}}
	if proc.IsBlock(nonLogEntry) {
		t.Errorf("Expected IsBlock to be false for generic text")
	}
}

func TestLogProcessor_CodeWithExceptionIsNotLog(t *testing.T) {
	proc := NewLogProcessor(block.BlockServices{})
	// Ordinary source code that merely mentions Exception / a date must NOT be
	// misdetected as a log (the old logDetectRe matched the bare word "Exception").
	src := "try {\n  doThing(); // since 2026-01-01\n} catch (Exception e) {\n  throw new RuntimeException(e);\n}"
	if proc.IsBlock([]block.ContentEntry{{MIMEType: "text/plain", Content: src}}) {
		t.Error("code containing 'Exception' should not be detected as a log")
	}
}

func TestLogProcessor_BracketedLevelIsLog(t *testing.T) {
	proc := NewLogProcessor(block.BlockServices{})
	if !proc.IsBlock([]block.ContentEntry{{MIMEType: "text/plain", Content: "[INFO] starting up\n[WARN] disk low"}}) {
		t.Error("bracketed-level lines should be detected as a log")
	}
}
