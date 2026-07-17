package ai

import (
	"strings"
	"testing"

	"sieve/sieve/domain"
)

const libDir = "/vault/library"

func argsFor(cli string) []string {
	return buildBaseArgs(cli, "", "the prompt", domain.DefaultContainmentProfile(), "", libDir)
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
	// Bare read-tool names are path-UNSCOPED allow rules in claude's grammar: a
	// bare "Read" auto-approves reads at ANY path, defeating the workspace gate
	// (#41). File-type grants must therefore render SCOPED to the granted dirs —
	// verb(//dir/**), redundant-but-harmless for reads — never as bare names.
	got := flagValue(args, "--allowedTools")
	for _, bare := range []string{"Read", "Grep", "Glob"} {
		for _, tok := range strings.Split(got, ",") {
			if tok == bare {
				t.Errorf("claude --allowedTools contains bare %s (filesystem-wide grant): %q", bare, got)
			}
		}
	}
	// Scoped to the library grant (cwd unset in this helper ⇒ AddDirs = [libDir]).
	for _, want := range []string{
		"Read(//vault/library/**)", "Grep(//vault/library/**)", "Glob(//vault/library/**)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("claude --allowedTools missing scoped file rule %q: %q", want, got)
		}
	}
	// WebFetch (network) is bare when no domains are configured.
	if !strings.Contains(got, "WebFetch") {
		t.Errorf("claude --allowedTools missing WebFetch: %q", got)
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
	// Copilot uses its OWN tool vocabulary (view/grep/glob), never claude's names,
	// and file reads are path-gated by --add-dir so read tools are allow-listed
	// with plain names. Web fetch is the URL axis (--allow-url/--allow-all-urls),
	// NOT an --allow-tool entry (#41).
	got := flagValue(args, "--allow-tool")
	for _, claudeName := range []string{"Read", "Grep", "Glob", "WebFetch"} {
		for _, tok := range strings.Split(got, ",") {
			if tok == claudeName {
				t.Errorf("copilot --allow-tool must not use claude's name %s: %q", claudeName, got)
			}
		}
	}
	if got != "view,grep,glob" {
		t.Errorf("copilot --allow-tool = %q, want view,grep,glob (its own read/search names)", got)
	}
	// Fetch is granted on the URL axis, unrestricted by default (bare Fetch).
	if !hasFlag(args, "--allow-all-urls") {
		t.Errorf("copilot must grant fetch via the URL axis (--allow-all-urls); args=%v", args)
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
	args := buildBaseArgs("claude", "sonnet", "p", domain.DefaultContainmentProfile(), "", libDir)
	if flagValue(args, "--model") != "sonnet" {
		t.Errorf("claude --model = %q, want sonnet; args=%v", flagValue(args, "--model"), args)
	}
}
