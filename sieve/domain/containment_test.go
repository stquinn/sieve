package domain

import (
	"strings"
	"testing"
)

// DefaultContainmentProfile seeds the baseline capability floor: read-only tools
// (incl. WebFetch), the library + note directories, and the sieve MCP placeholder.
func TestDefaultContainmentProfile_Baseline(t *testing.T) {
	p := DefaultContainmentProfile()

	wantTools := []string{"Read", "Grep", "Glob", "WebFetch"}
	if got := p.ToolNames(); !equalStrings(got, wantTools) {
		t.Fatalf("baseline tools = %v, want %v", got, wantTools)
	}
	for _, tg := range p.Tools {
		if !tg.Baseline {
			t.Errorf("tool %q should be baseline", tg.Name)
		}
	}

	// Neither Write nor Edit is granted by default — writes are opt-in.
	for _, tg := range p.Tools {
		if tg.Name == "Write" || tg.Name == "Edit" {
			t.Errorf("write tool %q must not be a baseline grant", tg.Name)
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

// Summary is the one-line log digest: tools, dirs, mcp, and the writes flag.
func TestContainmentProfile_Summary(t *testing.T) {
	s := DefaultContainmentProfile().Summary()
	for _, want := range []string{"tools=[Read Grep Glob WebFetch]", "writes=off", "sieve"} {
		if !strings.Contains(s, want) {
			t.Errorf("Summary() = %q, want it to contain %q", s, want)
		}
	}

	// A live MCP server is tagged (live); adding a write tool flips writes=on.
	p := DefaultContainmentProfile()
	for i := range p.McpServers {
		if p.McpServers[i].Name == "sieve" {
			p.McpServers[i].URL = "http://127.0.0.1:9/mcp"
		}
	}
	p.Tools = append(p.Tools, ToolGrant{Name: "Write"})
	s = p.Summary()
	if !strings.Contains(s, "sieve(live)") {
		t.Errorf("Summary() = %q, want sieve(live)", s)
	}
	if !strings.Contains(s, "writes=on") {
		t.Errorf("Summary() = %q, want writes=on after adding Write", s)
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
	if !equalStrings(got.ToolNames(), []string{"Read", "Grep", "Glob", "WebFetch"}) {
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

// LoadContainmentProfile dedups by name/kind+path: an override naming an
// existing baseline entry does not duplicate it, and baseline wins (the
// baseline entry is never downgraded to a user entry of the same name).
func TestLoadContainmentProfile_DedupBaselineWins(t *testing.T) {
	overrides := ContainmentProfile{
		Tools: []ToolGrant{{Name: "Read"}}, // user re-adds an existing baseline tool
	}
	got := LoadContainmentProfile(overrides)

	count := 0
	var readGrant ToolGrant
	for _, tg := range got.Tools {
		if tg.Name == "Read" {
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
