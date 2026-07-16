package domain

import "strings"

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

// McpGrant permits an MCP server. Builtin marks the internal Sieve server, whose
// runtime URL + bearer token are generated per-call and never persisted.
type McpGrant struct {
	Name     string   `json:"name"`
	Builtin  bool     `json:"builtin,omitempty"`
	Command  string   `json:"command,omitempty"`
	Args     []string `json:"args,omitempty"`
	Baseline bool     `json:"baseline,omitempty"`
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
			{Name: "sieve", Builtin: true, Baseline: true},
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
