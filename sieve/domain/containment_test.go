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
