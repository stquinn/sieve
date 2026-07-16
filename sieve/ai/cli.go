package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve/domain"
)

// CLIRunner executes an AI CLI invocation. It is the seam AIService depends on
// so ops-level tests can stub the subprocess (CI has no CLI binaries installed);
// execCLIRunner is the production implementation that actually spawns the process.
//
// op names the AI operation (e.g. "explain", "file", "web-clip-fetch") — it is
// used only for log correlation so calls are distinguishable at a glance.
type CLIRunner interface {
	Run(op, cli, prompt, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error)
}

// execCLIRunner is the real CLIRunner: it renders the containment profile to args
// and spawns the CLI subprocess.
type execCLIRunner struct{}

// bearerTokenRe matches the MCP bearer token inside the inline --mcp-config JSON
// so it can be redacted from the logged command line (the token is a per-run
// secret; the rest of the command line is safe to log verbatim).
var bearerTokenRe = regexp.MustCompile(`Bearer [^"\s]+`)

// Run executes the configured CLI using the provided prompt content via STDIN.
// cwd sets the working directory for the subprocess — pass the note/buffer's
// directory so relative asset paths in markdown resolve correctly. Pass "" to
// inherit the process's working directory.
//
// profile is the containment floor rendered to CLI args (never config files);
// libraryDir resolves the profile's symbolic "library" directory grant to the
// concrete --add-dir path. The note directory is the cwd and needs no grant.
func (execCLIRunner) Run(op, cli, prompt, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error) {
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

	// Concise, scannable breakdown of the call: what op, which CLI/model, the
	// containment policy, the timeout, the exact command line (bearer token
	// redacted), and the full prompt — all as ONE block so the whole invocation
	// reads as a single unit when scanning the log.
	logCwd := cwd
	if logCwd == "" {
		logCwd = "(process cwd)"
	}
	logModel := model
	if logModel == "" {
		logModel = "(default)"
	}
	logger.LogBlock(
		fmt.Sprintf("AI REQUEST ▸ %s", op),
		requestLogBody(cli, logModel, timeoutSecs, logCwd, profile, args, prompt))

	started := time.Now()
	err := cmd.Run()
	elapsedMs := time.Since(started).Milliseconds()

	if ctx.Err() == context.DeadlineExceeded {
		logger.Error("ai cli FAILED ▸ "+op, "cli", cli, "timeout_s", timeoutSecs, "elapsed_ms", elapsedMs)
		return "", fmt.Errorf("cli timeout after %d seconds", timeoutSecs)
	}
	if err != nil {
		logger.Error("ai cli FAILED ▸ "+op, "cli", cli, "elapsed_ms", elapsedMs, "err", err, "stderr", strings.TrimSpace(stderr.String()))
		return "", fmt.Errorf("cli execution error: %v (stderr: %s)", err, stderr.String())
	}

	out := stdout.String()
	logger.LogBlock(
		fmt.Sprintf("AI RESPONSE ▸ %s (%dms, %d bytes)", op, elapsedMs, len(out)),
		out)
	return out, nil
}

// redactedCommand renders the exact command line that was executed, with the MCP
// bearer token replaced by *** so it never lands in the logs.
func redactedCommand(cli string, args []string) string {
	joined := cli + " " + strings.Join(args, " ")
	return bearerTokenRe.ReplaceAllString(joined, "Bearer ***")
}

// requestLogBody composes the full body of the AI REQUEST log block: the
// resolved cli/model/timeout/cwd, the containment policy summary, the exact
// command line broken one flag-group per line (see formatCommandBlock), and —
// after a blank-line gap — the full prompt text, so the whole invocation reads
// as a single scannable unit.
func requestLogBody(cli, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, args []string, prompt string) string {
	// Labels are flush-left (not indented): logBlock trims the block's leading
	// whitespace, which would otherwise strip only the first line's indent and
	// leave the fields misaligned.
	return fmt.Sprintf(
		"cli       %s   (model: %s)\ntimeout   %ds\ncwd       %s\npolicy    %s\ncommand   %s\n\n%s",
		cli, model, timeoutSecs, cwd, profile.Summary(), formatCommandBlock(cli, args), prompt)
}

// formatCommandBlock renders the executed command line as a multi-line,
// indented block for scannable logging: the binary plus any leading bare
// boolean flags (e.g. --print, --no-session-persistence) share the first line;
// every subsequent --flag and its value(s) get their own indented continuation
// line. The MCP bearer token is redacted (bearerTokenRe) so the per-run secret
// never lands in the log.
func formatCommandBlock(cli string, args []string) string {
	i := 0
	first := cli
	for i < len(args) && strings.HasPrefix(args[i], "--") &&
		(i+1 >= len(args) || strings.HasPrefix(args[i+1], "--")) {
		first += " " + args[i]
		i++
	}

	const continuationIndent = "\n              "
	lines := []string{first}
	for i < len(args) {
		group := args[i]
		i++
		for i < len(args) && !strings.HasPrefix(args[i], "--") {
			group += " " + args[i]
			i++
		}
		lines = append(lines, group)
	}

	joined := strings.Join(lines, continuationIndent)
	return bearerTokenRe.ReplaceAllString(joined, "Bearer ***")
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

// mcpInjection renders a containment profile's *configured* MCP servers — stdio
// servers with a Command, remote (http/sse) servers with a URL, including the
// builtin Sieve server once its runtime URL is live — to a CLI's inline config
// flag and its per-server allow entries. Servers that are not configured (e.g.
// an unstarted builtin with no runtime URL yet) are skipped, so when nothing is
// configured the backend renders exactly as before (no MCP flags), keeping the
// no-server path — and existing tests — unchanged.
type mcpInjection struct {
	servers []domain.McpGrant
}

// newMCPInjection collects the profile's MCP servers that are configured
// (IsConfigured) — this includes user-added stdio servers, user-added
// http/sse servers, and the builtin once it has a runtime URL.
func newMCPInjection(profile domain.ContainmentProfile) mcpInjection {
	var configured []domain.McpGrant
	for _, m := range profile.McpServers {
		if m.IsConfigured() {
			configured = append(configured, m)
		}
	}
	return mcpInjection{servers: configured}
}

func (mi mcpInjection) present() bool { return len(mi.servers) > 0 }

// mcpServerEntry is one entry in the inline --mcp-config payload. Type is
// omitted for stdio (the CLIs infer stdio from the presence of "command"); it is
// set explicitly to "http"/"sse" for remote servers.
type mcpServerEntry struct {
	Type    string            `json:"type,omitempty"`
	Command string            `json:"command,omitempty"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	URL     string            `json:"url,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// configJSON builds the inline JSON for --mcp-config / --additional-mcp-config,
// rendering each server per its EffectiveTransport:
//   - stdio: {"command": "...", "args": [...], "env": {...}}
//   - http:  {"type":"http", "url":"...", "headers": {...}}
//   - sse:   {"type":"sse",  "url":"...", "headers": {...}}
//
// For http/sse, the grant's static Headers are merged with the runtime bearer:
// if Token is set (the builtin), an "Authorization: Bearer <Token>" header is
// added on top of any user-configured static headers.
func (mi mcpInjection) configJSON() string {
	servers := make(map[string]mcpServerEntry, len(mi.servers))
	for _, m := range mi.servers {
		switch m.EffectiveTransport() {
		case "http", "sse":
			headers := make(map[string]string, len(m.Headers)+1)
			for k, v := range m.Headers {
				headers[k] = v
			}
			if strings.TrimSpace(m.Token) != "" {
				headers["Authorization"] = "Bearer " + m.Token
			}
			if len(headers) == 0 {
				headers = nil
			}
			servers[m.Name] = mcpServerEntry{Type: m.EffectiveTransport(), URL: m.URL, Headers: headers}
		default: // stdio
			servers[m.Name] = mcpServerEntry{Command: m.Command, Args: m.Args, Env: m.Env}
		}
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
