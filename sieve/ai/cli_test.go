package ai

import (
	"strings"
	"testing"

	"sieve/sieve/domain"
)

const libDir = "/vault/library"

// runFor is a run of the CLI dialect under profile, with libDir as its library
// and a prompt of a background, a brief and its data.
func runFor(dialect string, profile domain.ContainmentProfile) Run {
	return Run{
		CLI: CLI{Binary: dialect, Dialect: dialect},
		Prompt: Prompt{
			Background: Layer{Heading: backgroundHeading, Text: "the background"},
			Brief:      Layer{Heading: briefHeading, Text: "the brief"},
			Data:       Layer{Heading: dataHeading, Text: "the data"},
		},
		Profile:    profile,
		LibraryDir: libDir,
	}
}

func argsFor(cli string) []string {
	return runFor(cli, domain.DefaultContainmentProfile()).args()
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
	// Renderer returns before any allowlist/MCP logic — agy has no per-tool flag.
	if hasFlag(args, "--allowedTools") || hasFlag(args, "--allow-tool") {
		t.Errorf("agy has no per-tool allow flag; got %v", args)
	}
}

// Model is threaded through when set.
func TestBuildArgs_Model(t *testing.T) {
	run := runFor("claude", domain.DefaultContainmentProfile())
	run.CLI.Model = "sonnet"
	args := run.args()
	if flagValue(args, "--model") != "sonnet" {
		t.Errorf("claude --model = %q, want sonnet; args=%v", flagValue(args, "--model"), args)
	}
}

// A user grant repeating a job grant renders each rule once, in every dialect.
// agy renders no tool grants, so it has nothing to repeat.
func TestBuildArgs_DeduplicatesRepeatedGrants(t *testing.T) {
	p := domain.DefaultContainmentProfile()
	p.Tools = append(p.Tools,
		domain.ToolGrant{Type: "network", Label: "Fetch", Names: map[string]string{"claude": "WebFetch"}},
		domain.ToolGrant{Type: "file", Label: "Read", Names: map[string]string{"claude": "Read", "copilot": "view"}},
		domain.ToolGrant{Type: "network", Label: "Docs", Constraint: "go.dev", Names: map[string]string{"claude": "WebFetch"}},
		domain.ToolGrant{Type: "network", Label: "Docs again", Constraint: "go.dev, pkg.go.dev", Names: map[string]string{"claude": "WebFetch"}},
	)
	for _, tc := range []struct {
		dialect string
		lists   []string // flags whose comma-list values, across every occurrence, hold no repeat
		singles []string // flags that appear at most once
	}{
		{"claude", []string{"--allowedTools"}, nil},
		{"copilot", []string{"--allow-tool", "--allow-url"}, []string{"--allow-all-urls"}},
	} {
		t.Run(tc.dialect, func(t *testing.T) {
			args := runFor(tc.dialect, p).args()
			seen := make(map[string]int)
			for i, a := range args {
				for _, flag := range tc.singles {
					if a == flag {
						if seen[a]++; seen[a] > 1 {
							t.Errorf("%s appears more than once; args=%v", a, args)
						}
					}
				}
				for _, flag := range tc.lists {
					if a != flag || i+1 >= len(args) {
						continue
					}
					for _, tok := range strings.Split(args[i+1], ",") {
						if seen[flag+" "+tok]++; seen[flag+" "+tok] > 1 {
							t.Errorf("%s repeats %q; args=%v", flag, tok, args)
						}
					}
				}
			}
		})
	}
}

// The AI RESPONSE header says what became of the final message whenever the
// run's note says anything, so a discarded message is not read as the answer.
func TestExecCLIRunner_ResponseLabelCarriesTheNote(t *testing.T) {
	for _, tc := range []struct {
		name string
		note ResponseNote
		want string
	}{
		{"no note", nil, "AI RESPONSE ▸ ask (12ms, 34 bytes)"},
		{"a note that says nothing", func() string { return "" }, "AI RESPONSE ▸ ask (12ms, 34 bytes)"},
		{"a discarded message", func() string { return "discarded: the answer was written with add_to_answer (4 blocks)" },
			"AI RESPONSE ▸ ask (12ms, 34 bytes) ▸ discarded: the answer was written with add_to_answer (4 blocks)"},
	} {
		if got := (execCLIRunner{}).responseLabel("ask", 12, 34, tc.note); got != tc.want {
			t.Errorf("%s: label = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// Each backend sends the prompt's layers its own way: claude the system layers
// as the value of --append-system-prompt and the input layers on STDIN, copilot
// the whole prompt on STDIN, agy the whole prompt as its trailing argument and
// nothing on STDIN. No other argument carries any layer.
func TestRun_EachBackendSendsThePromptItsOwnWay(t *testing.T) {
	for _, tc := range []struct {
		dialect string
		flag    string // the flag whose value is a part of the prompt
		part    func(Prompt) string
		stdin   func(Prompt) string
	}{
		{"claude", "--append-system-prompt", Prompt.System, Prompt.Input},
		{"copilot", "", nil, Prompt.String},
		{"agy", "--print", Prompt.String, func(Prompt) string { return "" }},
		{"an unknown CLI", "", nil, Prompt.String},
	} {
		t.Run(tc.dialect, func(t *testing.T) {
			run := runFor(tc.dialect, domain.DefaultContainmentProfile())
			args := run.args()
			if got, want := run.stdin(), tc.stdin(run.Prompt); got != want {
				t.Errorf("stdin = %q, want %q", got, want)
			}
			if tc.flag != "" && flagValue(args, tc.flag) != tc.part(run.Prompt) {
				t.Errorf("%s = %q, want %q", tc.flag, flagValue(args, tc.flag), tc.part(run.Prompt))
			}
			for i, a := range args {
				if tc.flag != "" && i > 0 && args[i-1] == tc.flag {
					continue
				}
				for _, layer := range []string{"the background", "the brief", "the data"} {
					if strings.Contains(a, layer) {
						t.Errorf("the argument %q carries a layer", a)
					}
				}
			}
		})
	}
}

// A run is logged in three blocks: how the CLI was executed, the layers the
// framework writes, and the layers that are the task's and the run's. Between
// them the two prompt blocks hold every layer once, and the command block holds
// none of the prompt.
func TestRun_IsLoggedAsCommandFrameworkAndTask(t *testing.T) {
	run := runFor("claude", domain.DefaultContainmentProfile())
	command := run.commandLog(run.args())
	for _, want := range []string{"(model: (default))", "cwd       (process cwd)", "command   claude --print", "--append-system-prompt " + systemPromptStandIn} {
		if !strings.Contains(command, want) {
			t.Errorf("the command block lacks %q:\n%s", want, command)
		}
	}
	if strings.Contains(command, "the background") || strings.Contains(command, "the data") {
		t.Errorf("the command block holds prompt text:\n%s", command)
	}
	if got, want := run.Prompt.FrameworkLayers(), "# Sieve\n\nthe background"; got != want {
		t.Errorf("framework block = %q, want %q", got, want)
	}
	if got, want := run.Prompt.TaskLayers(), "# Task\n\nthe brief\n\n# Data\n\nthe data"; got != want {
		t.Errorf("task block = %q, want %q", got, want)
	}
}
