package ai

import (
	"encoding/json"
	"strings"
	"testing"

	"sieve/sieve/domain"
)

// profileWithMCP returns the default containment profile with the builtin sieve
// grant's runtime URL + token populated, as the AI service does at render time.
func profileWithMCP() domain.ContainmentProfile {
	p := domain.DefaultContainmentProfile()
	for i := range p.McpServers {
		if p.McpServers[i].Builtin {
			p.McpServers[i].URL = "http://127.0.0.1:34115/mcp"
			p.McpServers[i].Token = "secret-token-abc"
		}
	}
	return p
}

// The logged command line must never expose the per-run MCP bearer token.
func TestRedactedCommand_RedactsBearerToken(t *testing.T) {
	args := buildBaseArgs("claude", "", "p", profileWithMCP(), libDir)
	cmd := redactedCommand("claude", args)

	if strings.Contains(cmd, "secret-token-abc") {
		t.Fatalf("bearer token leaked into logged command line: %s", cmd)
	}
	if !strings.Contains(cmd, "Bearer ***") {
		t.Fatalf("expected redacted 'Bearer ***' in logged command, got: %s", cmd)
	}
	// The rest of the command line is preserved (url still visible, just not the token).
	if !strings.Contains(cmd, "--add-dir "+libDir) || !strings.Contains(cmd, "http://127.0.0.1:34115/mcp") {
		t.Errorf("redaction over-stripped the command line: %s", cmd)
	}
}

// The multi-line command block must still never expose the per-run MCP bearer
// token, and must split the command into one flag-group per continuation line.
func TestFormatCommandBlock_RedactsAndSplitsPerFlag(t *testing.T) {
	args := buildBaseArgs("claude", "", "p", profileWithMCP(), libDir)
	block := formatCommandBlock("claude", args)

	if strings.Contains(block, "secret-token-abc") {
		t.Fatalf("bearer token leaked into command block: %s", block)
	}
	if !strings.Contains(block, "Bearer ***") {
		t.Fatalf("expected redacted 'Bearer ***' in command block, got: %s", block)
	}

	lines := strings.Split(block, "\n")
	if len(lines) < 4 {
		t.Fatalf("expected multi-line command block (binary + bare flags, then one line per --flag group), got %d lines: %q", len(lines), block)
	}

	// First line carries the binary plus the leading bare boolean flags.
	if !strings.HasPrefix(lines[0], "claude --print --no-session-persistence") {
		t.Errorf("first line should be binary + bare boolean flags, got: %q", lines[0])
	}

	// Every subsequent line is its own indented --flag group.
	wantPrefixes := []string{"--add-dir " + libDir, "--mcp-config ", "--allowedTools "}
	for idx, want := range wantPrefixes {
		line := strings.TrimSpace(lines[idx+1])
		if !strings.HasPrefix(line, want) {
			t.Errorf("line %d: expected prefix %q, got %q", idx+1, want, line)
		}
		if lines[idx+1] == line {
			t.Errorf("line %d: expected indentation, got none: %q", idx+1, lines[idx+1])
		}
	}
}

func TestBuildArgs_Claude_InjectsMCPWhenLive(t *testing.T) {
	args := buildBaseArgs("claude", "", "p", profileWithMCP(), libDir)

	cfg := flagValue(args, "--mcp-config")
	if cfg == "" {
		t.Fatalf("claude missing --mcp-config; args=%v", args)
	}
	if !strings.Contains(cfg, "http://127.0.0.1:34115/mcp") {
		t.Errorf("--mcp-config missing url: %s", cfg)
	}
	if !strings.Contains(cfg, "Bearer secret-token-abc") {
		t.Errorf("--mcp-config missing bearer header: %s", cfg)
	}
	// The inline config is valid JSON of the expected shape.
	var parsed struct {
		McpServers map[string]struct {
			Type    string            `json:"type"`
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal([]byte(cfg), &parsed); err != nil {
		t.Fatalf("--mcp-config is not valid JSON: %v\n%s", err, cfg)
	}
	sieve, ok := parsed.McpServers["sieve"]
	if !ok || sieve.Type != "http" || sieve.URL != "http://127.0.0.1:34115/mcp" {
		t.Errorf("sieve server entry wrong: %+v", parsed.McpServers)
	}

	tools := flagValue(args, "--allowedTools")
	if !strings.Contains(tools, "mcp__sieve__*") {
		t.Errorf("--allowedTools missing mcp__sieve__*: %q", tools)
	}
	// Baseline read tools remain present alongside the MCP allow entry.
	if !strings.HasPrefix(tools, "Read,Grep,Glob,WebFetch") {
		t.Errorf("--allowedTools baseline tools missing: %q", tools)
	}
	// Never the rejected fully-wildcard form, never strict-mcp-config.
	if strings.Contains(tools, "mcp__*,") || tools == "mcp__*" {
		t.Errorf("must not use fully-wildcard mcp__*: %q", tools)
	}
	if hasFlag(args, "--strict-mcp-config") {
		t.Errorf("must never pass --strict-mcp-config: %v", args)
	}
}

func TestBuildArgs_Copilot_InjectsMCPWhenLive(t *testing.T) {
	args := buildBaseArgs("copilot", "", "p", profileWithMCP(), libDir)

	cfg := flagValue(args, "--additional-mcp-config")
	if cfg == "" {
		t.Fatalf("copilot missing --additional-mcp-config; args=%v", args)
	}
	if !strings.Contains(cfg, "http://127.0.0.1:34115/mcp") || !strings.Contains(cfg, "Bearer secret-token-abc") {
		t.Errorf("--additional-mcp-config missing url/bearer: %s", cfg)
	}
	if tools := flagValue(args, "--allow-tool"); !strings.Contains(tools, "mcp__sieve__*") {
		t.Errorf("--allow-tool missing mcp__sieve__*: %q", tools)
	}
}

// When the builtin grant has no runtime URL (no server running), no MCP flags are
// rendered — the pre-MCP behaviour, so existing arg tests still hold.
func TestBuildArgs_NoMCPFlagsWhenURLEmpty(t *testing.T) {
	for _, cli := range []string{"claude", "copilot"} {
		args := buildBaseArgs(cli, "", "p", domain.DefaultContainmentProfile(), libDir)
		for _, f := range []string{"--mcp-config", "--additional-mcp-config"} {
			if hasFlag(args, f) {
				t.Errorf("%s: rendered %s with no live server; args=%v", cli, f, args)
			}
		}
		allow := flagValue(args, "--allowedTools") + flagValue(args, "--allow-tool")
		if strings.Contains(allow, "mcp__sieve__*") {
			t.Errorf("%s: allow entry has mcp__sieve__* with no live server: %q", cli, allow)
		}
	}
}

// agy must remain directory-only: no MCP inject flag even when the profile has a
// live builtin server (agy has no per-call --mcp-config flag).
func TestBuildArgs_Agy_NeverInjectsMCP(t *testing.T) {
	args := buildBaseArgs("agy", "", "the prompt", profileWithMCP(), libDir)
	for _, f := range []string{"--mcp-config", "--additional-mcp-config", "--allowedTools", "--allow-tool"} {
		if hasFlag(args, f) {
			t.Errorf("agy must not render %s; args=%v", f, args)
		}
	}
	if strings.Contains(strings.Join(args, ","), "mcp__sieve__*") {
		t.Errorf("agy must not carry an mcp allow entry; args=%v", args)
	}
}
