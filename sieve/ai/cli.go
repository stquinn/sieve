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

// CLIRunner executes one AI CLI invocation. It is the seam AIService depends on
// so ops-level tests can stub the subprocess (CI has no CLI binaries installed);
// execCLIRunner is the production implementation that actually spawns the process.
//
// note, when non-nil, is asked once the CLI has exited with a response, and what
// it says is logged on that response's header.
type CLIRunner interface {
	Run(run Run, note ResponseNote) (string, error)
}

// CLI is the configured CLI a run spawns. Binary is the executable; Dialect
// selects the per-backend argument renderer (backendFor). They are usually equal
// (a bare provider name), but a user-configured CLIPath wrapper makes Binary a
// script path while Dialect keeps following the provider dropdown — see
// Settings.ResolveCLI. An empty Model is the CLI's default.
type CLI struct {
	Binary      string
	Dialect     string
	Model       string
	TimeoutSecs int
}

// Run is one call to the CLI: the task it runs (its Name correlates the log
// lines), the prompt sent, the CLI spawned, the containment floor rendered to
// its arguments, and its working directory. LibraryDir resolves the profile's
// symbolic "library" directory grant to a concrete path; an empty Cwd is
// floored to it.
type Run struct {
	Task       Task
	Prompt     Prompt
	CLI        CLI
	Profile    domain.ContainmentProfile
	Cwd        string
	LibraryDir string
}

// ResponseNote says what became of a run's final message, when that is not
// simply that it is the run's result (for one, that it was discarded); "" says
// nothing.
type ResponseNote func() string

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

// Run executes run's CLI with what its backend sends on STDIN (Run.stdin). The
// run's Cwd is the subprocess's working directory — the note/buffer's
// directory, so relative asset paths in markdown resolve correctly. An empty Cwd is floored to the
// library (floorCwd); it is never left to the process cwd.
//
// The profile is the containment floor rendered to CLI args (never config
// files). The note directory is the cwd and needs no grant.
func (r execCLIRunner) Run(run Run, note ResponseNote) (string, error) {
	op, timeoutSecs := run.Task.Name, run.CLI.TimeoutSecs
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSecs)*time.Second)
	defer cancel()

	// cwd is never unset: an AI op always operates on a note/buffer, or failing
	// that the library. floorCwd is defence-in-depth — even if a caller forgets
	// its fallback, the subprocess never inherits the process cwd (which on a
	// Finder/Dock-launched macOS app is /). #41.
	run.Cwd = floorCwd(run.Cwd, run.LibraryDir)

	args := run.args()

	cmd := exec.CommandContext(ctx, run.CLI.Binary, args...)
	cmd.Stdin = bytes.NewBufferString(run.stdin())
	if run.Cwd != "" {
		cmd.Dir = run.Cwd
	}

	// Inherit the full login shell PATH so the subprocess can find tools
	// installed in /usr/local/bin, /opt/homebrew/bin, etc. when the app is
	// launched from the Dock or Finder with a minimal inherited PATH.
	cmd.Env = append(os.Environ(), "PATH="+domain.LoginPath())

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	logger.LogBlock(fmt.Sprintf("AI REQUEST ▸ %s ▸ command", op), run.commandLog(args))
	logger.LogBlock(fmt.Sprintf("AI REQUEST ▸ %s ▸ framework", op), run.Prompt.FrameworkLayers())
	logger.LogBlock(fmt.Sprintf("AI REQUEST ▸ %s ▸ task", op), run.Prompt.TaskLayers())

	started := time.Now()
	err := cmd.Run()
	elapsedMs := time.Since(started).Milliseconds()

	if ctx.Err() == context.DeadlineExceeded {
		logger.Error("ai cli FAILED ▸ "+op, "cli", run.CLI.Binary, "timeout_s", timeoutSecs, "elapsed_ms", elapsedMs)
		return "", fmt.Errorf("cli timeout after %d seconds", timeoutSecs)
	}
	if err != nil {
		logger.Error("ai cli FAILED ▸ "+op, "cli", run.CLI.Binary, "elapsed_ms", elapsedMs, "err", err, "stderr", strings.TrimSpace(stderr.String()))
		return "", fmt.Errorf("cli execution error: %v (stderr: %s)", err, stderr.String())
	}

	out := stdout.String()
	logger.LogBlock(r.responseLabel(op, elapsedMs, len(out), note), out)
	return out, nil
}

// responseLabel is the header of the AI RESPONSE log block: the op, how long the
// CLI took, how many bytes it answered, and what note says of them.
func (execCLIRunner) responseLabel(op string, elapsedMs int64, size int, note ResponseNote) string {
	label := fmt.Sprintf("AI RESPONSE ▸ %s (%dms, %d bytes)", op, elapsedMs, size)
	if note != nil {
		if said := note(); said != "" {
			label += " ▸ " + said
		}
	}
	return label
}

// redactedCommand renders the exact command line that was executed, with the MCP
// bearer token replaced by *** so it never lands in the logs.
func redactedCommand(cli string, args []string) string {
	joined := cli + " " + strings.Join(args, " ")
	return bearerTokenRe.ReplaceAllString(joined, "Bearer ***")
}

// commandLog is the first of a run's three AI REQUEST log blocks, how the CLI
// was executed with args: the resolved cli/model/timeout/cwd, the containment
// policy summary and the exact command line broken one flag-group per line (see
// formatCommandBlock). The prompt follows in two blocks of its own, the
// framework's layers and the task's, each under its heading whether it
// travelled in an argument or on STDIN.
func (r Run) commandLog(args []string) string {
	cwd := r.Cwd
	if cwd == "" {
		cwd = "(process cwd)"
	}
	model := r.CLI.Model
	if model == "" {
		model = "(default)"
	}
	// Labels are flush-left (not indented): logBlock trims the block's leading
	// whitespace, which would otherwise strip only the first line's indent and
	// leave the fields misaligned.
	return fmt.Sprintf(
		"cli       %s   (model: %s)\ntimeout   %ds\ncwd       %s\npolicy    %s\ncommand   %s",
		r.CLI.Binary, model, r.CLI.TimeoutSecs, cwd, r.Profile.Summary(), formatCommandBlock(r.CLI.Binary, args))
}

// formatCommandBlock renders the executed command line as a multi-line,
// indented block for scannable logging: the binary plus any leading bare
// boolean flags (e.g. --print, --no-session-persistence) share the first line;
// every subsequent --flag and its value(s) get their own indented continuation
// line. Allow-list flags (--allowedTools etc.), whose single value is now a long
// comma-joined list of scoped rules, are wrapped ONE RULE PER LINE so the grants
// stay scannable instead of collapsing into a 300-char wall. The value of
// --append-system-prompt is shown by systemPromptStandIn, as the log prints the
// prompt's layers after the command. The MCP bearer token is redacted
// (bearerTokenRe) so the per-run secret never lands in the log.
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
		switch {
		case len(values) == 1 && isAllowListFlag(flag):
			group = wrapAllowList(flag, values[0], continuationIndent)
		case len(values) == 1 && flag == systemPromptFlag:
			group = flag + " " + systemPromptStandIn
		}
		lines = append(lines, group)
	}

	joined := strings.Join(lines, continuationIndent)
	return bearerTokenRe.ReplaceAllString(joined, "Bearer ***")
}

// systemPromptFlag is claude's flag for the system layers of a prompt
// (Prompt.System); systemPromptStandIn is what the logged command line shows
// for its value.
const (
	systemPromptFlag    = "--append-system-prompt"
	systemPromptStandIn = "<the system layers, logged in the blocks below>"
)

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

// cliBackend is one CLI's adapter: everything that differs between dialects
// lives behind it, and nothing outside it needs to know which dialect is
// configured. buildArgs renders a run's arguments, stdin what the run sends on
// STDIN, and carriesSieveTools whether a run under profile is given the Sieve
// tools: the backend injects MCP and the builtin Sieve grant is configured.
type cliBackend interface {
	buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model string, prompt Prompt) []string
	stdin(prompt Prompt) string
	carriesSieveTools(profile domain.ContainmentProfile) bool
}

// backendFor selects the adapter for a dialect. A dialect with no adapter is
// nil: unknown CLIs render no args, exactly as before.
func backendFor(dialect string) cliBackend {
	switch {
	case strings.Contains(dialect, "claude"):
		return claudeBackend{}
	case strings.Contains(dialect, "agy"):
		return agyBackend{}
	case strings.Contains(dialect, "copilot"):
		return copilotBackend{}
	}
	return nil
}

// args renders the run to its CLI's arguments through the dialect's backend:
// its containment profile, model and whatever of its prompt the backend sends
// as an argument. No backend passes a permission-bypass flag, so each CLI's
// native path gate stays armed and reads confine to cwd and the --add-dir
// grants. A dialect with no backend renders none.
func (r Run) args() []string {
	b := backendFor(r.CLI.Dialect)
	if b == nil {
		return nil
	}
	return b.buildArgs(r.Profile, r.Cwd, r.LibraryDir, r.CLI.Model, r.Prompt)
}

// stdin is what the run sends its CLI on STDIN, as its dialect's backend
// chooses; a dialect with no backend is sent the whole prompt.
func (r Run) stdin() string {
	b := backendFor(r.CLI.Dialect)
	if b == nil {
		return r.Prompt.String()
	}
	return b.stdin(r.Prompt)
}

// carriesSieveTools reports whether the run is given the Sieve tools, as its
// dialect's backend says; a dialect with no backend is not.
func (r Run) carriesSieveTools() bool {
	b := backendFor(r.CLI.Dialect)
	return b != nil && b.carriesSieveTools(r.Profile)
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
	seen := make(map[string]bool)
	addRule := func(r string) {
		if r == "" || seen[r] {
			return
		}
		seen[r] = true
		rules = append(rules, r)
	}
	for _, t := range profile.Tools {
		verb := t.NameFor("claude")
		if verb == "" {
			continue // fail closed: claude can't express this capability
		}
		switch t.Type {
		case "network":
			for _, r := range networkRules(verb, t.Constraint, func(d string) string {
				return verb + "(domain:" + d + ")"
			}) {
				addRule(r)
			}
		case "other":
			if c := strings.TrimSpace(t.Constraint); c != "" {
				addRule(c)
			} else {
				addRule(verb)
			}
		default: // file
			for _, dir := range scopeDirs {
				addRule(claudeScopedFileRule(verb, dir))
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

// claudeBackend renders the profile for the claude CLI. The prompt's system
// layers (Prompt.System) are the value of --append-system-prompt and its input
// layers (Prompt.Input) are sent on STDIN. --add-dir + --allowedTools express
// the containment floor; --strict-mcp-config is deliberately never passed so
// the user's inherited approvals load.
type claudeBackend struct{}

func (claudeBackend) buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model string, prompt Prompt) []string {
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
	if system := prompt.System(); system != "" {
		args = append(args, systemPromptFlag, system)
	}
	return args
}

func (claudeBackend) stdin(prompt Prompt) string { return prompt.Input() }

func (claudeBackend) carriesSieveTools(profile domain.ContainmentProfile) bool {
	return newMCPInjection(profile).carriesSieve()
}

// copilotBackend renders the profile for the copilot CLI. It reads the whole
// prompt from STDIN (--prompt ""). Copilot has THREE orthogonal containment axes: file
// access is gated by --add-dir (path verification is on by default), web access
// by --allow-url / --allow-all-urls (its OWN axis), and tool permission by
// --allow-tool. So file-type grants render as PLAIN tool names (the path axis
// confines where), network grants route to the URL axis (never --allow-tool),
// and --deny-tool shell,write hard-blocks writes (opt-in).
type copilotBackend struct{}

func (copilotBackend) buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model string, _ Prompt) []string {
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

func (copilotBackend) stdin(prompt Prompt) string { return prompt.String() }

func (copilotBackend) carriesSieveTools(profile domain.ContainmentProfile) bool {
	return newMCPInjection(profile).carriesSieve()
}

// copilotToolAxes splits the profile's tool grants across copilot's two relevant
// axes: file/other grants become plain --allow-tool names (path-gated by
// --add-dir), and network grants become URL-axis args (--allow-url <domains> or
// --allow-all-urls when unrestricted). A grant with no copilot name is omitted
// from the tool axis (fail closed) — e.g. baseline Fetch, whose copilot column is
// intentionally empty because it belongs on the URL axis. A name, domain or
// --allow-all-urls already rendered by an earlier grant is not repeated.
func copilotToolAxes(profile domain.ContainmentProfile) (toolNames, urlArgs []string) {
	seen := make(map[string]bool)
	first := func(key string) bool {
		if seen[key] {
			return false
		}
		seen[key] = true
		return true
	}
	for _, t := range profile.Tools {
		if t.Type == "network" {
			domains := splitConstraint(t.Constraint)
			if len(domains) == 0 {
				if first("--allow-all-urls") {
					urlArgs = append(urlArgs, "--allow-all-urls")
				}
				continue
			}
			var fresh []string
			for _, d := range domains {
				if first("url:" + d) {
					fresh = append(fresh, d)
				}
			}
			if len(fresh) > 0 {
				urlArgs = append(urlArgs, "--allow-url", strings.Join(fresh, ","))
			}
			continue
		}
		// file + other: a plain tool name, path-gated by --add-dir.
		if name := t.NameFor("copilot"); name != "" && first("tool:"+name) {
			toolNames = append(toolNames, name)
		}
	}
	return toolNames, urlArgs
}

// agyBackend renders the profile for the agy (Antigravity) CLI. agy exposes no
// per-tool allow/deny flag and no per-call --mcp-config inject flag, so under the
// uniform fail-closed rule its column is empty for every tool grant: it emits no
// tool names and relies on --add-dir + --mode plan. The renderer returns BEFORE
// any allowlist/MCP logic, so a run on agy never carries the Sieve tools. agy
// does NOT read STDIN — --print takes the whole prompt as its trailing
// argument.
type agyBackend struct{}

func (agyBackend) buildArgs(profile domain.ContainmentProfile, cwd, libraryDir, model string, prompt Prompt) []string {
	var args []string
	for _, dir := range profile.AddDirs(libraryDir) {
		args = append(args, "--add-dir", dir)
	}
	args = append(args, "--mode", "plan")
	if model != "" {
		args = append(args, "--model", model)
	}
	return append(args, "--print", prompt.String())
}

func (agyBackend) stdin(Prompt) string { return "" }

func (agyBackend) carriesSieveTools(domain.ContainmentProfile) bool { return false }

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

// carriesSieve reports whether the builtin Sieve server is among the injected
// servers.
func (mi mcpInjection) carriesSieve() bool {
	for _, m := range mi.servers {
		if m.Builtin {
			return true
		}
	}
	return false
}

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

// allowEntries returns the per-server allow tokens, using the SAME sanitized id
// as configJSON's config key so the allow rule matches the CLI's tool
// namespace: one mcp__<NamespaceID>__<verb> per verb the builtin Sieve grant
// carries for this run (none when it carries none), and the wildcard
// mcp__<NamespaceID>__* for every other server. The fully-wildcard mcp__* form
// is deliberately not used — CLIs reject it.
func (mi mcpInjection) allowEntries() []string {
	var entries []string
	for _, m := range mi.servers {
		prefix := "mcp__" + m.NamespaceID() + "__"
		if !m.Builtin {
			entries = append(entries, prefix+"*")
			continue
		}
		for _, verb := range m.Verbs {
			entries = append(entries, prefix+verb)
		}
	}
	return entries
}
