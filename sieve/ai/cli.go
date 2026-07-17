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

// floorCwd enforces "cwd is never unset": an empty cwd is a caller bug (an AI
// op always has a note/buffer, or the library). Rather than inherit the process
// cwd — which on a Finder/Dock-launched macOS app is / — it floors to the
// library root. When even the library is unknown it returns "" (nothing to floor
// to); the callers' own fallbacks make that unreachable in practice. #41.
func floorCwd(cwd, libraryDir string) string {
	if strings.TrimSpace(cwd) != "" {
		return cwd
	}
	return libraryDir
}

// Run executes the configured CLI using the provided prompt content via STDIN.
// cwd sets the working directory for the subprocess — pass the note/buffer's
// directory so relative asset paths in markdown resolve correctly. An empty cwd
// is floored to the library (floorCwd); it is never left to the process cwd.
//
// profile is the containment floor rendered to CLI args (never config files);
// libraryDir resolves the profile's symbolic "library" directory grant to the
// concrete --add-dir path. The note directory is the cwd and needs no grant.
func (execCLIRunner) Run(op, cli, prompt, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	// cwd is never unset: an AI op always operates on a note/buffer, or failing
	// that the library. floorCwd is defence-in-depth — even if a caller forgets
	// its fallback, the subprocess never inherits the process cwd (which on a
	// Finder/Dock-launched macOS app is /). #41.
	cwd = floorCwd(cwd, libraryDir)

	args := buildBaseArgs(cli, model, prompt, profile, cwd, libraryDir)

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
// line. Allow-list flags (--allowedTools etc.), whose single value is now a long
// comma-joined list of scoped rules, are wrapped ONE RULE PER LINE so the grants
// stay scannable instead of collapsing into a 300-char wall. The MCP bearer token
// is redacted (bearerTokenRe) so the per-run secret never lands in the log.
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
		flag := args[i]
		group := flag
		i++
		var values []string
		for i < len(args) && !strings.HasPrefix(args[i], "--") {
			values = append(values, args[i])
			group += " " + args[i]
			i++
		}
		if len(values) == 1 && isAllowListFlag(flag) {
			group = wrapAllowList(flag, values[0], continuationIndent)
		}
		lines = append(lines, group)
	}

	joined := strings.Join(lines, continuationIndent)
	return bearerTokenRe.ReplaceAllString(joined, "Bearer ***")
}

// isAllowListFlag reports whether a flag's value is a comma-joined allow/deny
// list (of scoped tool rules) worth wrapping one-per-line in the log. The MCP
// config flags are deliberately excluded — their value is JSON whose internal
// commas must NOT be split.
func isAllowListFlag(flag string) bool {
	switch flag {
	case "--allowedTools", "--allow-tool", "--deny-tool", "--disallowedTools":
		return true
	default:
		return false
	}
}

// wrapAllowList renders "--flag a,b,c" with the first rule on the flag line and
// each subsequent rule on its own line, indented two spaces past the flag column
// so the list reads as a sub-block of the flag. The trailing comma is kept on
// each wrapped line so the value stays an honest picture of the CSV passed.
func wrapAllowList(flag, csv, continuationIndent string) string {
	parts := strings.Split(csv, ",")
	if len(parts) <= 1 {
		return flag + " " + csv
	}
	ruleIndent := continuationIndent + "  "
	var b strings.Builder
	b.WriteString(flag + " " + parts[0])
	for _, p := range parts[1:] {
		b.WriteString("," + ruleIndent + p)
	}
	return b.String()
}

// buildBaseArgs selects the per-backend adapter and renders the containment
// profile to that CLI's arguments. Dropping the former --dangerously-skip-
// permissions / --yolo re-arms each CLI's native path gate; the typed tool
// grants are then rendered per-backend (claude scopes file grants in the allow
// rule, copilot on the --add-dir path axis), so reads confine to cwd + the
// --add-dir grants and no bare filesystem-wide allow entry leaks. #41.
func buildBaseArgs(cli string, model string, prompt string, profile domain.ContainmentProfile, cwd, libraryDir string) []string {
	switch {
	case strings.Contains(cli, "claude"):
		return claudeBackend{}.buildArgs(profile, cwd, libraryDir, model, prompt)
	case strings.Contains(cli, "agy"):
		return agyBackend{}.buildArgs(profile, cwd, libraryDir, model, prompt)
	case strings.Contains(cli, "copilot"):
		return copilotBackend{}.buildArgs(profile, cwd, libraryDir, model, prompt)
	}
	return nil
}

// fileScopeDirs is the set of directories a file-type tool grant is scoped to:
// the subprocess cwd (the current note/buffer, resolved per-invocation) plus the
// profile's --add-dir grants (library + user dirs). cwd is included explicitly
// because AddDirs omits the note dir (it is the cwd, not an --add-dir).
func fileScopeDirs(profile domain.ContainmentProfile, cwd, libraryDir string) []string {
	var dirs []string
	if strings.TrimSpace(cwd) != "" {
		dirs = append(dirs, cwd)
	}
	return append(dirs, profile.AddDirs(libraryDir)...)
}

// claudeScopedFileRule renders one file-type grant scoped to one directory:
// verb(//<abs>/**). Claude has no separate path gate, so a bare verb would grant
// the whole filesystem — the scoping is what confines it. The leading extra '/'
// (dir already begins with '/') is claude's absolute-path rule sigil, verified
// live against claude 2.1.207.
func claudeScopedFileRule(verb, dir string) string {
	return verb + "(/" + dir + "/**)"
}

// claudeToolRules renders the profile's tool grants to claude --allowedTools
// entries by TYPE (never by inferring from the name):
//   - file    → verb(//dir/**) for each scope dir (redundant-but-harmless for
//     reads, load-bearing for writes);
//   - network → verb(domain:…) per constraint domain, or bare verb when empty;
//   - other   → the constraint verbatim, or bare verb when empty.
//
// A grant with no claude name is omitted (fail closed).
func claudeToolRules(profile domain.ContainmentProfile, cwd, libraryDir string) []string {
	scopeDirs := fileScopeDirs(profile, cwd, libraryDir)
	var rules []string
	for _, t := range profile.Tools {
		verb := t.NameFor("claude")
		if verb == "" {
			continue // fail closed: claude can't express this capability
		}
		switch t.Type {
		case "network":
			rules = append(rules, networkRules(verb, t.Constraint, func(d string) string {
				return verb + "(domain:" + d + ")"
			})...)
		case "other":
			if c := strings.TrimSpace(t.Constraint); c != "" {
				rules = append(rules, c)
			} else {
				rules = append(rules, verb)
			}
		default: // file
			for _, dir := range scopeDirs {
				rules = append(rules, claudeScopedFileRule(verb, dir))
			}
		}
	}
	return rules
}

// networkRules splits a comma/space-separated domain constraint and renders one
// scoped rule per domain via mk; an empty constraint yields a single bare grant.
func networkRules(bare, constraint string, mk func(domain string) string) []string {
	domains := splitConstraint(constraint)
	if len(domains) == 0 {
		return []string{bare}
	}
	rules := make([]string, 0, len(domains))
	for _, d := range domains {
		rules = append(rules, mk(d))
	}
	return rules
}

// splitConstraint parses a user constraint line ("a.com, b.com") into trimmed,
// non-empty entries. Both commas and whitespace separate.
func splitConstraint(s string) []string {
	fields := strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' })
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if f = strings.TrimSpace(f); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// claudeBackend renders the profile for the claude CLI, which reads the prompt
// from STDIN. --add-dir + --allowedTools express the containment floor; --strict-
// mcp-config is deliberately never passed so the user's inherited approvals load.
type claudeBackend struct{}

func (claudeBackend) buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model, _ string) []string {
	args := []string{"--print", "--no-session-persistence"}
	for _, dir := range profile.AddDirs(libraryDir) {
		args = append(args, "--add-dir", dir)
	}
	inj := newMCPInjection(profile)
	if inj.present() {
		args = append(args, "--mcp-config", inj.configJSON())
	}
	tools := append(claudeToolRules(profile, cwd, libraryDir), inj.allowEntries()...)
	if len(tools) > 0 {
		args = append(args, "--allowedTools", strings.Join(tools, ","))
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// copilotBackend renders the profile for the copilot CLI. It reads the prompt
// from STDIN (--prompt ""). Copilot has THREE orthogonal containment axes: file
// access is gated by --add-dir (path verification is on by default), web access
// by --allow-url / --allow-all-urls (its OWN axis), and tool permission by
// --allow-tool. So file-type grants render as PLAIN tool names (the path axis
// confines where), network grants route to the URL axis (never --allow-tool),
// and --deny-tool shell,write hard-blocks writes (opt-in).
type copilotBackend struct{}

func (copilotBackend) buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model, _ string) []string {
	args := []string{"--prompt", "", "--silent"}
	for _, dir := range profile.AddDirs(libraryDir) {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--disallow-temp-dir")
	inj := newMCPInjection(profile)
	if inj.present() {
		args = append(args, "--additional-mcp-config", inj.configJSON())
	}

	toolNames, urlArgs := copilotToolAxes(profile)
	tools := append(toolNames, inj.allowEntries()...)
	if len(tools) > 0 {
		args = append(args, "--allow-tool", strings.Join(tools, ","))
	}
	args = append(args, urlArgs...)
	args = append(args, "--deny-tool", "shell,write")
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// copilotToolAxes splits the profile's tool grants across copilot's two relevant
// axes: file/other grants become plain --allow-tool names (path-gated by
// --add-dir), and network grants become URL-axis args (--allow-url <domains> or
// --allow-all-urls when unrestricted). A grant with no copilot name is omitted
// from the tool axis (fail closed) — e.g. baseline Fetch, whose copilot column is
// intentionally empty because it belongs on the URL axis.
func copilotToolAxes(profile domain.ContainmentProfile) (toolNames, urlArgs []string) {
	for _, t := range profile.Tools {
		if t.Type == "network" {
			if domains := splitConstraint(t.Constraint); len(domains) > 0 {
				urlArgs = append(urlArgs, "--allow-url", strings.Join(domains, ","))
			} else {
				urlArgs = append(urlArgs, "--allow-all-urls")
			}
			continue
		}
		// file + other: a plain tool name, path-gated by --add-dir.
		if name := t.NameFor("copilot"); name != "" {
			toolNames = append(toolNames, name)
		}
	}
	return toolNames, urlArgs
}

// agyBackend renders the profile for the agy (Antigravity) CLI. agy exposes no
// per-tool allow/deny flag and no per-call --mcp-config inject flag, so under the
// uniform fail-closed rule its column is empty for every tool grant: it emits no
// tool names and relies on --add-dir + --mode plan. The renderer returns BEFORE
// any allowlist/MCP logic. agy does NOT read STDIN — --print takes the prompt as
// its trailing argument.
type agyBackend struct{}

func (agyBackend) buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model, prompt string) []string {
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
			servers[m.NamespaceID()] = mcpServerEntry{Type: m.EffectiveTransport(), URL: m.URL, Headers: headers}
		default: // stdio
			servers[m.NamespaceID()] = mcpServerEntry{Command: m.Command, Args: m.Args, Env: m.Env}
		}
	}
	b, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		logger.Error("cli: marshal mcp config", "err", err)
		return ""
	}
	return string(b)
}

// allowEntries returns the per-server wildcard allow tokens
// (mcp__<NamespaceID>__*), using the SAME sanitized id as configJSON's config
// key so the allow rule matches the CLI's tool namespace. The fully-wildcard
// mcp__* form is deliberately not used — CLIs reject it.
func (mi mcpInjection) allowEntries() []string {
	entries := make([]string, 0, len(mi.servers))
	for _, m := range mi.servers {
		entries = append(entries, "mcp__"+m.NamespaceID()+"__*")
	}
	return entries
}
