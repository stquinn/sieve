package ai

import (
	"testing"

	"sieve/sieve/domain"
)

const libDir = "/vault/library"

func argsFor(cli string) []string {
	return buildBaseArgs(cli, "", "the prompt", domain.DefaultContainmentProfile(), libDir)
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// flagValue returns the argument immediately following flag, or "".
func flagValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// The single most important change: no backend may pass a permission-bypass flag.
func TestBuildArgs_NoDangerousFlags(t *testing.T) {
	for _, cli := range []string{"claude", "agy", "copilot"} {
		args := argsFor(cli)
		for _, bad := range []string{"--dangerously-skip-permissions", "--yolo"} {
			if hasFlag(args, bad) {
				t.Errorf("%s: must not pass %s; got %v", cli, bad, args)
			}
		}
	}
}

func TestBuildArgs_Claude(t *testing.T) {
	args := argsFor("claude")

	if !hasFlag(args, "--print") || !hasFlag(args, "--no-session-persistence") {
		t.Errorf("claude missing print/no-session flags: %v", args)
	}
	if flagValue(args, "--add-dir") != libDir {
		t.Errorf("claude --add-dir = %q, want %q; args=%v", flagValue(args, "--add-dir"), libDir, args)
	}
	if got := flagValue(args, "--allowedTools"); got != "Read,Grep,Glob,WebFetch" {
		t.Errorf("claude --allowedTools = %q, want Read,Grep,Glob,WebFetch", got)
	}
	// Inheritance is always on — never lock the config surface.
	if hasFlag(args, "--strict-mcp-config") {
		t.Errorf("claude must not pass --strict-mcp-config: %v", args)
	}
}

func TestBuildArgs_Copilot(t *testing.T) {
	args := argsFor("copilot")

	if !hasFlag(args, "--silent") || !hasFlag(args, "--disallow-temp-dir") {
		t.Errorf("copilot missing silent/disallow-temp-dir: %v", args)
	}
	if flagValue(args, "--add-dir") != libDir {
		t.Errorf("copilot --add-dir = %q, want %q", flagValue(args, "--add-dir"), libDir)
	}
	if got := flagValue(args, "--allow-tool"); got != "Read,Grep,Glob,WebFetch" {
		t.Errorf("copilot --allow-tool = %q, want Read,Grep,Glob,WebFetch", got)
	}
	if got := flagValue(args, "--deny-tool"); got != "shell,write" {
		t.Errorf("copilot --deny-tool = %q, want shell,write", got)
	}
	// Denylist, not whitelist — a whitelist would hide inherited tools.
	if hasFlag(args, "--available-tools") {
		t.Errorf("copilot must not use --available-tools: %v", args)
	}
}

func TestBuildArgs_Agy(t *testing.T) {
	args := argsFor("agy")

	if flagValue(args, "--add-dir") != libDir {
		t.Errorf("agy --add-dir = %q, want %q", flagValue(args, "--add-dir"), libDir)
	}
	if flagValue(args, "--mode") != "plan" {
		t.Errorf("agy --mode = %q, want plan", flagValue(args, "--mode"))
	}
	// agy takes the prompt as a trailing arg (does not read stdin).
	if len(args) < 2 || args[len(args)-2] != "--print" || args[len(args)-1] != "the prompt" {
		t.Errorf("agy must end with --print <prompt>; got %v", args)
	}
	// Renderer returns before any allowlist/MCP logic — agy has no per-tool flag.
	if hasFlag(args, "--allowedTools") || hasFlag(args, "--allow-tool") {
		t.Errorf("agy has no per-tool allow flag; got %v", args)
	}
}

// Model is threaded through when set.
func TestBuildArgs_Model(t *testing.T) {
	args := buildBaseArgs("claude", "sonnet", "p", domain.DefaultContainmentProfile(), libDir)
	if flagValue(args, "--model") != "sonnet" {
		t.Errorf("claude --model = %q, want sonnet; args=%v", flagValue(args, "--model"), args)
	}
}
