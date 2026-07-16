package domain

import (
	"fmt"
	"strings"
)

// ContainmentProfile is the self-describing capability floor Sieve grants to an
// AI CLI. It is rendered to CLI *arguments* by sieve/ai (never to config files),
// so it is the single, stable maintenance point for what an AI call may touch.
//
// Every grant carries a Baseline flag: the constructor seeds baseline entries
// (Sieve owns them; the UI locks them), user additions are Baseline:false. The
// arg renderer treats every entry uniformly and ignores Baseline (a UI concern).
type ContainmentProfile struct {
	Tools       []ToolGrant `json:"tools"`
	Directories []DirGrant  `json:"directories"`
	McpServers  []McpGrant  `json:"mcpServers"`
}

// ToolGrant permits a named tool (e.g. Read, WebFetch, or an MCP verb).
type ToolGrant struct {
	Name     string `json:"name"`
	Baseline bool   `json:"baseline,omitempty"`
}

// DirGrant permits filesystem access to a directory. Baseline grants are
// symbolic (Kind resolves to a path per-invocation); user grants carry a literal
// Path. Kind "note" is the process cwd and is never rendered as an --add-dir.
type DirGrant struct {
	Kind     string `json:"kind,omitempty"`  // "library" | "note" (symbolic); empty for a literal Path
	Label    string `json:"label,omitempty"` // human-facing name for the settings panel
	Path     string `json:"path,omitempty"`  // literal path for user-added directories
	Baseline bool   `json:"baseline,omitempty"`
}

// McpGrant permits an MCP server, over one of three transports: stdio (a
// spawned command), http, or sse (both remote, addressed by URL). Builtin marks
// the internal Sieve server, whose runtime URL + bearer token are generated
// per-call — URL is persisted for user-added remote servers, but the builtin
// grant is always Baseline:true, so WithoutBaseline (used by Settings.Marshal)
// strips it before it ever reaches settings.json. Token is always runtime-only
// (the builtin's per-run bearer) and is never persisted regardless of Baseline.
type McpGrant struct {
	Name      string            `json:"name"`
	Transport string            `json:"transport,omitempty"` // "stdio" | "http" | "sse"
	Builtin   bool              `json:"builtin,omitempty"`
	Command   string            `json:"command,omitempty"` // stdio
	Args      []string          `json:"args,omitempty"`    // stdio
	Env       map[string]string `json:"env,omitempty"`     // stdio
	URL       string            `json:"url,omitempty"`     // http/sse (builtin's is ephemeral but Baseline, so never persisted)
	Headers   map[string]string `json:"headers,omitempty"` // http/sse static headers
	Token     string            `json:"-"`                 // runtime-only per-run bearer (builtin); NEVER persisted
	Baseline  bool              `json:"baseline,omitempty"`
}

// EffectiveTransport resolves the grant's transport: the explicit Transport if
// set, else "http" when a URL is present (a remote server configured without an
// explicit transport is assumed HTTP), else "stdio" (the historical default).
func (m McpGrant) EffectiveTransport() string {
	if t := strings.TrimSpace(m.Transport); t != "" {
		return t
	}
	if strings.TrimSpace(m.URL) != "" {
		return "http"
	}
	return "stdio"
}

// IsConfigured reports whether the grant carries enough to actually connect:
// http/sse need a URL, stdio needs a Command. An unstarted builtin server (no
// runtime URL yet) is therefore not configured, preserving the "no live server
// ⇒ no MCP injection" behaviour for the default profile.
func (m McpGrant) IsConfigured() bool {
	switch m.EffectiveTransport() {
	case "http", "sse":
		return strings.TrimSpace(m.URL) != ""
	default:
		return strings.TrimSpace(m.Command) != ""
	}
}

// DefaultContainmentProfile seeds the baseline capability floor: read-only tools
// (plus WebFetch, which web-clip depends on — visible, not a hidden grant), the
// library + note directories, and the internal Sieve MCP placeholder. Writes are
// deliberately absent: they are opt-in, added only by the user.
func DefaultContainmentProfile() ContainmentProfile {
	return ContainmentProfile{
		Tools: []ToolGrant{
			{Name: "Read", Baseline: true},
			{Name: "Grep", Baseline: true},
			{Name: "Glob", Baseline: true},
			{Name: "WebFetch", Baseline: true},
		},
		Directories: []DirGrant{
			{Kind: "library", Label: "Library", Baseline: true},
			{Kind: "note", Label: "Current note", Baseline: true},
		},
		McpServers: []McpGrant{
			{Name: "sieve", Transport: "http", Builtin: true, Baseline: true},
		},
	}
}

// ToolNames returns the granted tool names in profile order — the payload for a
// backend's allow-list flag (claude --allowedTools, copilot --allow-tool).
func (p ContainmentProfile) ToolNames() []string {
	names := make([]string, 0, len(p.Tools))
	for _, t := range p.Tools {
		if n := strings.TrimSpace(t.Name); n != "" {
			names = append(names, n)
		}
	}
	return names
}

// WithoutBaseline returns a copy of the profile with all Baseline:true entries
// removed. This is the persisted (settings.json) form: defaults live in code
// via DefaultContainmentProfile, so only user additions are ever written.
func (p ContainmentProfile) WithoutBaseline() ContainmentProfile {
	var out ContainmentProfile
	for _, t := range p.Tools {
		if !t.Baseline {
			out.Tools = append(out.Tools, t)
		}
	}
	for _, d := range p.Directories {
		if !d.Baseline {
			out.Directories = append(out.Directories, d)
		}
	}
	for _, m := range p.McpServers {
		if !m.Baseline {
			out.McpServers = append(out.McpServers, m)
		}
	}
	return out
}

// LoadContainmentProfile overlays persisted overrides onto the baseline
// capability floor: it starts from DefaultContainmentProfile() and appends
// each override entry, deduped by identity (tool/mcp Name; directory Kind, or
// Path when Kind is empty). On a collision the baseline entry wins — a user
// override naming an already-baseline capability never duplicates or
// downgrades it. This is the inverse of WithoutBaseline and is how settings.json
// overrides are reconstituted into the full in-memory profile.
func LoadContainmentProfile(overrides ContainmentProfile) ContainmentProfile {
	p := DefaultContainmentProfile()

	toolIdx := make(map[string]int, len(p.Tools))
	for i, t := range p.Tools {
		toolIdx[t.Name] = i
	}
	for _, t := range overrides.Tools {
		if i, ok := toolIdx[t.Name]; ok {
			if p.Tools[i].Baseline {
				continue // baseline wins
			}
			p.Tools[i] = t
			continue
		}
		toolIdx[t.Name] = len(p.Tools)
		p.Tools = append(p.Tools, t)
	}

	dirKey := func(d DirGrant) string {
		if d.Kind != "" {
			return "kind:" + d.Kind
		}
		return "path:" + d.Path
	}
	dirIdx := make(map[string]int, len(p.Directories))
	for i, d := range p.Directories {
		dirIdx[dirKey(d)] = i
	}
	for _, d := range overrides.Directories {
		k := dirKey(d)
		if i, ok := dirIdx[k]; ok {
			if p.Directories[i].Baseline {
				continue // baseline wins
			}
			p.Directories[i] = d
			continue
		}
		dirIdx[k] = len(p.Directories)
		p.Directories = append(p.Directories, d)
	}

	mcpIdx := make(map[string]int, len(p.McpServers))
	for i, m := range p.McpServers {
		mcpIdx[m.Name] = i
	}
	for _, m := range overrides.McpServers {
		if i, ok := mcpIdx[m.Name]; ok {
			if p.McpServers[i].Baseline {
				continue // baseline wins
			}
			p.McpServers[i] = m
			continue
		}
		mcpIdx[m.Name] = len(p.McpServers)
		p.McpServers = append(p.McpServers, m)
	}

	return p
}

// Summary is a one-line, human-readable digest of the profile for logs: the
// granted tools, the directory grants (kind or literal path), the MCP servers
// (tagged (live) when a runtime URL is present), and whether writes are enabled.
// It carries no secrets — the MCP bearer token lives only on the rendered args.
func (p ContainmentProfile) Summary() string {
	writes := "off"
	for _, t := range p.Tools {
		if t.Name == "Write" || t.Name == "Edit" {
			writes = "on"
		}
	}
	dirs := make([]string, 0, len(p.Directories))
	for _, d := range p.Directories {
		switch {
		case d.Kind != "":
			dirs = append(dirs, d.Kind)
		case d.Path != "":
			dirs = append(dirs, d.Path)
		}
	}
	mcp := make([]string, 0, len(p.McpServers))
	for _, m := range p.McpServers {
		tag := m.Name
		if strings.TrimSpace(m.URL) != "" {
			tag += "(live)"
		}
		mcp = append(mcp, tag)
	}
	return fmt.Sprintf("tools=[%s] dirs=[%s] mcp=[%s] writes=%s",
		strings.Join(p.ToolNames(), " "),
		strings.Join(dirs, " "),
		strings.Join(mcp, " "),
		writes)
}

// AddDirs resolves directory grants to filesystem paths that must be granted via
// each backend's --add-dir flag. The "note" directory is the process cwd and is
// therefore omitted. libraryDir resolves the symbolic "library" grant.
func (p ContainmentProfile) AddDirs(libraryDir string) []string {
	var dirs []string
	for _, d := range p.Directories {
		switch {
		case d.Kind == "note":
			// The note directory is the subprocess cwd; no --add-dir needed.
			continue
		case d.Kind == "library":
			if libraryDir != "" {
				dirs = append(dirs, libraryDir)
			}
		case d.Path != "":
			dirs = append(dirs, d.Path)
		}
	}
	return dirs
}
