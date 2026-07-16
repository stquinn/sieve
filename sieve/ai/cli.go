package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
)

// CLIRunner executes an AI CLI invocation. It is the seam AIService depends on
// so ops-level tests can stub the subprocess (CI has no CLI binaries installed);
// execCLIRunner is the production implementation that actually spawns the process.
type CLIRunner interface {
	Run(cli, prompt, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error)
}

// execCLIRunner is the real CLIRunner: it renders the containment profile to args
// and spawns the CLI subprocess.
type execCLIRunner struct{}

// Run executes the configured CLI using the provided prompt content via STDIN.
// cwd sets the working directory for the subprocess — pass the note/buffer's
// directory so relative asset paths in markdown resolve correctly. Pass "" to
// inherit the process's working directory.
//
// profile is the containment floor rendered to CLI args (never config files);
// libraryDir resolves the profile's symbolic "library" directory grant to the
// concrete --add-dir path. The note directory is the cwd and needs no grant.
func (execCLIRunner) Run(cli string, prompt string, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	args := buildBaseArgs(cli, model, prompt, profile, libraryDir)

	cmd := exec.CommandContext(ctx, cli, args...)
	cmd.Stdin = bytes.NewBufferString(prompt)
	if cwd != "" {
		cmd.Dir = cwd
	}

	// Inherit the full login shell PATH so the subprocess can find tools
	// installed in /usr/local/bin, /opt/homebrew/bin, etc. when the app is
	// launched from the Dock or Finder with a minimal inherited PATH.
	cmd.Env = append(os.Environ(), "PATH="+domain.LoginPath())

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	logger.Debug("cli exec start", "path", cmd.Path, "args", cmd.Args, "model", model, "cwd", cwd)
	logger.LogPrompt(prompt)

	err := cmd.Run()

	if ctx.Err() == context.DeadlineExceeded {
		logger.Error("cli timeout", "timeout_secs", timeoutSecs)
		return "", fmt.Errorf("cli timeout after %d seconds", timeoutSecs)
	}
	if err != nil {
		logger.Error("cli execution error", "err", err, "stderr", stderr.String())
		return "", fmt.Errorf("cli execution error: %v (stderr: %s)", err, stderr.String())
	}

	out := stdout.String()
	logger.LogResponse(out)
	return out, nil
}

// buildBaseArgs selects the per-backend adapter and renders the containment
// profile to that CLI's arguments. Dropping the former --dangerously-skip-
// permissions / --yolo re-arms each CLI's native path gate, so reads confine to
// cwd + the --add-dir grants.
func buildBaseArgs(cli string, model string, prompt string, profile domain.ContainmentProfile, libraryDir string) []string {
	switch {
	case strings.Contains(cli, "claude"):
		return claudeBackend{}.buildArgs(profile, libraryDir, model, prompt)
	case strings.Contains(cli, "agy"):
		return agyBackend{}.buildArgs(profile, libraryDir, model, prompt)
	case strings.Contains(cli, "copilot"):
		return copilotBackend{}.buildArgs(profile, libraryDir, model, prompt)
	}
	return nil
}

// claudeBackend renders the profile for the claude CLI, which reads the prompt
// from STDIN. --add-dir + --allowedTools express the containment floor; --strict-
// mcp-config is deliberately never passed so the user's inherited approvals load.
type claudeBackend struct{}

func (claudeBackend) buildArgs(profile domain.ContainmentProfile, libraryDir, model, _ string) []string {
	args := []string{"--print", "--no-session-persistence"}
	for _, dir := range profile.AddDirs(libraryDir) {
		args = append(args, "--add-dir", dir)
	}
	inj := newMCPInjection(profile)
	if inj.present() {
		args = append(args, "--mcp-config", inj.configJSON())
	}
	tools := append(profile.ToolNames(), inj.allowEntries()...)
	if len(tools) > 0 {
		args = append(args, "--allowedTools", strings.Join(tools, ","))
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// copilotBackend renders the profile for the copilot CLI. It reads the prompt
// from STDIN (--prompt ""). --allow-tool is a denylist-preserving allow (NOT
// --available-tools, which would whitelist away inherited tools); shell + write
// are hard-blocked because writes are opt-in.
type copilotBackend struct{}

func (copilotBackend) buildArgs(profile domain.ContainmentProfile, libraryDir, model, _ string) []string {
	args := []string{"--prompt", "", "--silent"}
	for _, dir := range profile.AddDirs(libraryDir) {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--disallow-temp-dir")
	inj := newMCPInjection(profile)
	if inj.present() {
		args = append(args, "--additional-mcp-config", inj.configJSON())
	}
	tools := append(profile.ToolNames(), inj.allowEntries()...)
	if len(tools) > 0 {
		args = append(args, "--allow-tool", strings.Join(tools, ","))
	}
	args = append(args, "--deny-tool", "shell,write")
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// agyBackend renders the profile for the agy (Antigravity) CLI. agy exposes no
// per-tool allow/deny flag and no per-call --mcp-config inject flag, so the
// profile degrades to directories-only under coarse read-only (--mode plan): the
// library grant is the raw --add-dir read of note files, with no MCP layer. The
// renderer returns BEFORE any allowlist/MCP logic. agy does NOT read STDIN —
// --print takes the prompt as its trailing argument.
type agyBackend struct{}

func (agyBackend) buildArgs(profile domain.ContainmentProfile, libraryDir, model, prompt string) []string {
	var args []string
	for _, dir := range profile.AddDirs(libraryDir) {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--mode", "plan")
	if model != "" {
		args = append(args, "--model", model)
	}
	return append(args, "--print", prompt)
}

// mcpInjection renders a containment profile's live HTTP MCP servers (those with
// a runtime URL — the builtin Sieve server) to a CLI's inline config flag and its
// per-server allow entries. Servers without a URL (unstarted, or user-added stdio
// servers) are not injectable per-call and are skipped, so when nothing is live
// the backend renders exactly as before (no MCP flags), keeping the no-server
// path — and existing tests — unchanged.
type mcpInjection struct {
	servers []domain.McpGrant
}

// newMCPInjection collects the profile's MCP servers that carry a runtime URL.
func newMCPInjection(profile domain.ContainmentProfile) mcpInjection {
	var live []domain.McpGrant
	for _, m := range profile.McpServers {
		if strings.TrimSpace(m.URL) != "" {
			live = append(live, m)
		}
	}
	return mcpInjection{servers: live}
}

func (mi mcpInjection) present() bool { return len(mi.servers) > 0 }

// mcpHTTPServer is one entry in the inline --mcp-config payload.
type mcpHTTPServer struct {
	Type    string            `json:"type"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers,omitempty"`
}

// configJSON builds the inline JSON for --mcp-config / --additional-mcp-config:
// {"mcpServers":{"<name>":{"type":"http","url":"…","headers":{"Authorization":"Bearer …"}}}}.
func (mi mcpInjection) configJSON() string {
	servers := make(map[string]mcpHTTPServer, len(mi.servers))
	for _, m := range mi.servers {
		var headers map[string]string
		if strings.TrimSpace(m.Token) != "" {
			headers = map[string]string{"Authorization": "Bearer " + m.Token}
		}
		servers[m.Name] = mcpHTTPServer{Type: "http", URL: m.URL, Headers: headers}
	}
	b, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		logger.Error("cli: marshal mcp config", "err", err)
		return ""
	}
	return string(b)
}

// allowEntries returns the per-server wildcard allow tokens (mcp__<name>__*).
// The fully-wildcard mcp__* form is deliberately not used — CLIs reject it.
func (mi mcpInjection) allowEntries() []string {
	entries := make([]string, 0, len(mi.servers))
	for _, m := range mi.servers {
		entries = append(entries, "mcp__"+m.Name+"__*")
	}
	return entries
}
