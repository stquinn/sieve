package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

// DefaultContainmentProfile seeds the baseline capability floor as CLI-neutral
// capability verbs: Read (file), Search ×2 (claude Grep + Glob), Fetch (network),
// plus the library+note dirs and the sieve MCP placeholder. Each grant carries a
// Type (drives scoping) and a per-CLI Names table (drives the emitted string). #41.
func TestDefaultContainmentProfile_Baseline(t *testing.T) {
	p := DefaultContainmentProfile()

	// Generic capability labels are CLI-neutral; the CLI-specific strings live in
	// the per-CLI Names table, never in the label.
	wantLabels := []string{"Read", "Search", "Search", "Fetch"}
	var gotLabels []string
	for _, tg := range p.Tools {
		gotLabels = append(gotLabels, tg.Label)
	}
	if !equalStrings(gotLabels, wantLabels) {
		t.Fatalf("baseline tool labels = %v, want %v", gotLabels, wantLabels)
	}

	// Types drive scoping: file for read/search, network for fetch.
	wantTypes := []string{"file", "file", "file", "network"}
	var gotTypes []string
	for _, tg := range p.Tools {
		gotTypes = append(gotTypes, tg.Type)
	}
	if !equalStrings(gotTypes, wantTypes) {
		t.Fatalf("baseline tool types = %v, want %v", gotTypes, wantTypes)
	}

	// The per-CLI name table maps each capability to that CLI's actual tool name.
	// Two distinct Search grants (Grep + Glob), single-valued each — never a list.
	claudeNames := map[string]int{}
	copilotNames := map[string]int{}
	for _, tg := range p.Tools {
		if !tg.Baseline {
			t.Errorf("tool %q should be baseline", tg.Label)
		}
		claudeNames[tg.Names["claude"]]++
		copilotNames[tg.Names["copilot"]]++
	}
	for _, want := range []string{"Read", "Grep", "Glob", "WebFetch"} {
		if claudeNames[want] == 0 {
			t.Errorf("baseline missing a grant with claude name %q; got %v", want, claudeNames)
		}
	}
	for _, want := range []string{"view", "grep", "glob"} {
		if copilotNames[want] == 0 {
			t.Errorf("baseline missing a grant with copilot name %q; got %v", want, copilotNames)
		}
	}

	// Neither Write nor Edit is granted by default — writes are opt-in.
	for _, tg := range p.Tools {
		if tg.Label == "Write" || tg.Names["claude"] == "Edit" || tg.Names["claude"] == "Write" {
			t.Errorf("write tool %q must not be a baseline grant", tg.Label)
		}
	}

	// Directories: symbolic library + note, both baseline.
	kinds := map[string]bool{}
	for _, d := range p.Directories {
		kinds[d.Kind] = true
		if !d.Baseline {
			t.Errorf("directory %q should be baseline", d.Kind)
		}
	}
	if !kinds["library"] || !kinds["note"] {
		t.Fatalf("directories = %+v, want library+note kinds", p.Directories)
	}

	// Sieve MCP placeholder present as a builtin baseline server.
	if len(p.McpServers) != 1 || p.McpServers[0].Name != "sieve" || !p.McpServers[0].Builtin {
		t.Fatalf("mcpServers = %+v, want single builtin sieve server", p.McpServers)
	}
}

// AddDirs resolves the symbolic library grant to a filesystem path; the note
// directory is the process cwd and is therefore omitted.
func TestContainmentProfile_AddDirs(t *testing.T) {
	p := DefaultContainmentProfile()
	got := p.AddDirs("/vault/library")

	if len(got) != 1 || got[0] != "/vault/library" {
		t.Fatalf("AddDirs = %v, want [/vault/library] (note dir omitted, it is cwd)", got)
	}
}

// AddDirs also emits literal user-added directory paths.
func TestContainmentProfile_AddDirs_UserPath(t *testing.T) {
	p := DefaultContainmentProfile()
	p.Directories = append(p.Directories, DirGrant{Path: "/extra/spec"})

	got := p.AddDirs("/vault/library")
	if !contains(got, "/vault/library") || !contains(got, "/extra/spec") {
		t.Fatalf("AddDirs = %v, want library + /extra/spec", got)
	}
}

// Summary is the one-line log digest: the plain granted facts (tools/dirs/mcp),
// with no derived writes/exec verdict (that would be an unreliable guess; the
// authoritative allow-list is in the command line).
func TestContainmentProfile_Summary(t *testing.T) {
	s := DefaultContainmentProfile().Summary()
	for _, want := range []string{"tools=[Read Search Search Fetch]", "sieve"} {
		if !strings.Contains(s, want) {
			t.Errorf("Summary() = %q, want it to contain %q", s, want)
		}
	}
	// No guessed capability verdict.
	if strings.Contains(s, "writes=") || strings.Contains(s, "exec=") {
		t.Errorf("Summary() = %q, must not include a derived writes=/exec= verdict", s)
	}

	// A live MCP server is tagged (live).
	p := DefaultContainmentProfile()
	for i := range p.McpServers {
		if p.McpServers[i].Name == "sieve" {
			p.McpServers[i].URL = "http://127.0.0.1:9/mcp"
		}
	}
	if !strings.Contains(p.Summary(), "sieve(live)") {
		t.Errorf("Summary() = %q, want sieve(live)", p.Summary())
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if strings.TrimSpace(x) == want {
			return true
		}
	}
	return false
}

// WithoutBaseline is the serialisation form: baseline entries (Sieve-owned
// defaults) are dropped so settings.json holds only user additions.
func TestContainmentProfile_WithoutBaseline_DropsBaselineEntries(t *testing.T) {
	p := DefaultContainmentProfile()
	got := p.WithoutBaseline()

	if len(got.Tools) != 0 {
		t.Errorf("WithoutBaseline().Tools = %+v, want none (all baseline)", got.Tools)
	}
	if len(got.Directories) != 0 {
		t.Errorf("WithoutBaseline().Directories = %+v, want none (all baseline)", got.Directories)
	}
	if len(got.McpServers) != 0 {
		t.Errorf("WithoutBaseline().McpServers = %+v, want none (all baseline)", got.McpServers)
	}
}

// WithoutBaseline keeps user (non-baseline) additions.
func TestContainmentProfile_WithoutBaseline_KeepsUserAdditions(t *testing.T) {
	p := DefaultContainmentProfile()
	p.Directories = append(p.Directories, DirGrant{Path: "/x"})
	p.McpServers = append(p.McpServers, McpGrant{Name: "forgejo", Command: "forgejo-mcp"})

	got := p.WithoutBaseline()

	if len(got.Tools) != 0 {
		t.Errorf("WithoutBaseline().Tools = %+v, want none", got.Tools)
	}
	if len(got.Directories) != 1 || got.Directories[0].Path != "/x" {
		t.Fatalf("WithoutBaseline().Directories = %+v, want just [{Path: /x}]", got.Directories)
	}
	if len(got.McpServers) != 1 || got.McpServers[0].Name != "forgejo" {
		t.Fatalf("WithoutBaseline().McpServers = %+v, want just [{Name: forgejo}]", got.McpServers)
	}
}

// LoadContainmentProfile overlays overrides onto the default: with an empty
// override profile the result is exactly the default.
func TestLoadContainmentProfile_EmptyOverrides_YieldsDefault(t *testing.T) {
	got := LoadContainmentProfile(ContainmentProfile{})
	want := DefaultContainmentProfile()

	if !equalStrings(got.ToolNames(), want.ToolNames()) {
		t.Fatalf("ToolNames = %v, want %v", got.ToolNames(), want.ToolNames())
	}
	if len(got.Directories) != len(want.Directories) {
		t.Fatalf("Directories = %+v, want %+v", got.Directories, want.Directories)
	}
	if len(got.McpServers) != len(want.McpServers) {
		t.Fatalf("McpServers = %+v, want %+v", got.McpServers, want.McpServers)
	}
}

// LoadContainmentProfile appends user additions on top of the default set.
func TestLoadContainmentProfile_AppendsUserAdditions(t *testing.T) {
	overrides := ContainmentProfile{
		Directories: []DirGrant{{Path: "/x"}},
		McpServers:  []McpGrant{{Name: "forgejo", Command: "forgejo-mcp", Args: []string{"serve"}}},
	}
	got := LoadContainmentProfile(overrides)

	// Baseline tools/dirs/mcp are still present.
	if !equalStrings(got.ToolNames(), []string{"Read", "Search", "Search", "Fetch"}) {
		t.Fatalf("ToolNames = %v, want baseline tools preserved", got.ToolNames())
	}
	foundLibrary, foundNote, foundX := false, false, false
	for _, d := range got.Directories {
		switch {
		case d.Kind == "library":
			foundLibrary = true
		case d.Kind == "note":
			foundNote = true
		case d.Path == "/x":
			foundX = true
			if d.Baseline {
				t.Errorf("user directory /x should not be baseline")
			}
		}
	}
	if !foundLibrary || !foundNote || !foundX {
		t.Fatalf("Directories = %+v, want library+note+/x", got.Directories)
	}

	foundSieve, foundForgejo := false, false
	for _, m := range got.McpServers {
		switch m.Name {
		case "sieve":
			foundSieve = true
		case "forgejo":
			foundForgejo = true
			if m.Baseline {
				t.Errorf("user mcp server forgejo should not be baseline")
			}
			if m.Command != "forgejo-mcp" {
				t.Errorf("forgejo Command = %q, want forgejo-mcp", m.Command)
			}
		}
	}
	if !foundSieve || !foundForgejo {
		t.Fatalf("McpServers = %+v, want sieve+forgejo", got.McpServers)
	}
}

// LoadContainmentProfile dedups tools by (label + per-CLI name) identity: an
// override matching an existing baseline grant does not duplicate it, and
// baseline wins (never downgraded to a user entry). The two Search grants stay
// distinct because their claude names (Grep vs Glob) differ. #41.
func TestLoadContainmentProfile_DedupBaselineWins(t *testing.T) {
	overrides := ContainmentProfile{
		// A persisted override that re-states the read capability verbatim (same
		// label + per-CLI name table) — e.g. a hand-edited settings.json — must not
		// duplicate the baseline.
		Tools: []ToolGrant{{Type: "file", Label: "Read", Names: map[string]string{"claude": "Read", "copilot": "view"}}},
	}
	got := LoadContainmentProfile(overrides)

	count := 0
	var readGrant ToolGrant
	for _, tg := range got.Tools {
		if tg.Names["claude"] == "Read" {
			count++
			readGrant = tg
		}
	}
	if count != 1 {
		t.Fatalf("Read tool count = %d, want 1 (deduped)", count)
	}
	if !readGrant.Baseline {
		t.Errorf("Read grant Baseline = false, want true (baseline wins over user override)")
	}

	// Both Search grants survive — distinct names must not collapse into one.
	searchCount := 0
	for _, tg := range got.Tools {
		if tg.Label == "Search" {
			searchCount++
		}
	}
	if searchCount != 2 {
		t.Fatalf("Search grant count = %d, want 2 (Grep + Glob stay distinct)", searchCount)
	}
}

// Round-trip: default -> WithoutBaseline -> LoadContainmentProfile == default.
func TestContainmentProfile_RoundTrip_Default(t *testing.T) {
	def := DefaultContainmentProfile()
	overrides := def.WithoutBaseline()
	got := LoadContainmentProfile(overrides)

	if !equalStrings(got.ToolNames(), def.ToolNames()) {
		t.Fatalf("round-trip ToolNames = %v, want %v", got.ToolNames(), def.ToolNames())
	}
	if len(got.Directories) != len(def.Directories) {
		t.Fatalf("round-trip Directories = %+v, want %+v", got.Directories, def.Directories)
	}
	if len(got.McpServers) != len(def.McpServers) {
		t.Fatalf("round-trip McpServers = %+v, want %+v", got.McpServers, def.McpServers)
	}
}

// EffectiveTransport resolves an explicit Transport first, then falls back to
// "http" when a URL is present, then defaults to "stdio".
func TestMcpGrant_EffectiveTransport(t *testing.T) {
	cases := []struct {
		name string
		m    McpGrant
		want string
	}{
		{"explicit sse wins even with url", McpGrant{Transport: "sse", URL: "http://x"}, "sse"},
		{"explicit stdio wins even with url", McpGrant{Transport: "stdio", URL: "http://x"}, "stdio"},
		{"url implies http when transport unset", McpGrant{URL: "http://x"}, "http"},
		{"defaults to stdio with neither", McpGrant{Command: "forgejo-mcp"}, "stdio"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.m.EffectiveTransport(); got != c.want {
				t.Errorf("EffectiveTransport() = %q, want %q", got, c.want)
			}
		})
	}
}

// IsConfigured: http/sse need a URL, stdio needs a Command. An unstarted
// builtin (no runtime URL yet) is therefore not configured.
func TestMcpGrant_IsConfigured(t *testing.T) {
	cases := []struct {
		name string
		m    McpGrant
		want bool
	}{
		{"stdio with command", McpGrant{Command: "forgejo-mcp"}, true},
		{"stdio without command", McpGrant{}, false},
		{"http with url", McpGrant{Transport: "http", URL: "http://x"}, true},
		{"http without url", McpGrant{Transport: "http"}, false},
		{"sse with url", McpGrant{Transport: "sse", URL: "http://x"}, true},
		{"sse without url", McpGrant{Transport: "sse"}, false},
		{"unstarted builtin has no url", McpGrant{Name: "sieve", Transport: "http", Builtin: true, Baseline: true}, false},
		{"live builtin has a runtime url", McpGrant{Name: "sieve", Transport: "http", Builtin: true, Baseline: true, URL: "http://127.0.0.1:9/mcp"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.m.IsConfigured(); got != c.want {
				t.Errorf("IsConfigured() = %v, want %v", got, c.want)
			}
		})
	}
}

// A user-added remote (http) server's URL + Headers survive the persistence
// round-trip (WithoutBaseline -> LoadContainmentProfile); the builtin's runtime
// URL is never present in the marshalled (WithoutBaseline) form because it is
// always Baseline:true.
func TestContainmentProfile_RoundTrip_UserHTTPServer(t *testing.T) {
	p := DefaultContainmentProfile()
	// Simulate the builtin acquiring a live runtime URL, as the AI service does
	// at render time (never at save time, but prove it's stripped regardless).
	for i := range p.McpServers {
		if p.McpServers[i].Builtin {
			p.McpServers[i].URL = "http://127.0.0.1:34115/mcp"
		}
	}
	p.McpServers = append(p.McpServers, McpGrant{
		Name:      "forgejo",
		Transport: "http",
		URL:       "https://git.example.com/mcp",
		Headers:   map[string]string{"X-Api-Key": "abc123"},
	})

	persisted := p.WithoutBaseline()

	b, err := json.Marshal(persisted)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if strings.Contains(string(b), "127.0.0.1:34115") {
		t.Fatalf("builtin runtime URL leaked into persisted JSON: %s", b)
	}
	if !strings.Contains(string(b), "git.example.com") {
		t.Fatalf("user server URL missing from persisted JSON: %s", b)
	}

	got := LoadContainmentProfile(persisted)
	var forgejo McpGrant
	found := false
	for _, m := range got.McpServers {
		if m.Name == "forgejo" {
			forgejo = m
			found = true
		}
	}
	if !found {
		t.Fatalf("McpServers = %+v, want forgejo present after reload", got.McpServers)
	}
	if forgejo.URL != "https://git.example.com/mcp" {
		t.Errorf("forgejo.URL = %q, want https://git.example.com/mcp", forgejo.URL)
	}
	if forgejo.Headers["X-Api-Key"] != "abc123" {
		t.Errorf("forgejo.Headers = %+v, want X-Api-Key=abc123", forgejo.Headers)
	}
	if forgejo.EffectiveTransport() != "http" {
		t.Errorf("forgejo.EffectiveTransport() = %q, want http", forgejo.EffectiveTransport())
	}
}
