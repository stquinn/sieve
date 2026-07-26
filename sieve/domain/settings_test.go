package domain

import (
	"encoding/json"
	"testing"
)

// ResolveCLI splits the CLI setting into the executable to spawn (binary) and the
// argument dialect to render. The provider dropdown drives the dialect; CLIPath,
// when set, overrides only the binary.
func TestResolveCLI(t *testing.T) {
	cases := []struct {
		name        string
		cli         string
		cliPath     string
		wantBinary  string
		wantDialect string
	}{
		{"enum claude passthrough", "claude", "", "claude", "claude"},
		{"enum agy passthrough", "agy", "", "agy", "agy"},
		{"enum copilot passthrough", "copilot", "", "copilot", "copilot"},
		{"legacy path infers claude dialect + is the binary", "~/x/claude-query.sh", "", "~/x/claude-query.sh", "claude"},
		{"legacy path infers copilot dialect", "/opt/bin/copilot-wrap", "", "/opt/bin/copilot-wrap", "copilot"},
		{"CLIPath overrides binary, enum keeps claude dialect", "claude", "/x/claude-query.sh", "/x/claude-query.sh", "claude"},
		{"CLIPath overrides binary, copilot dialect", "copilot", "/x/wrap.sh", "/x/wrap.sh", "copilot"},
		{"CLIPath overrides binary, agy dialect", "agy", "/x/wrap.sh", "/x/wrap.sh", "agy"},
		{"CLIPath is trimmed before overriding", "claude", "  /x/wrap.sh  ", "/x/wrap.sh", "claude"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s := Settings{CLI: c.cli, CLIPath: c.cliPath}
			gotBinary, gotDialect := s.ResolveCLI()
			if gotBinary != c.wantBinary {
				t.Errorf("binary = %q, want %q", gotBinary, c.wantBinary)
			}
			if gotDialect != c.wantDialect {
				t.Errorf("dialect = %q, want %q", gotDialect, c.wantDialect)
			}
		})
	}
}

// ParseSettings overlays a loaded cli_path onto the defaults (which carry none).
func TestParseSettings_CLIPathOverlay(t *testing.T) {
	loaded := ParseSettings([]byte(`{"cli":"claude","cli_path":"/x/claude-query.sh"}`))
	if loaded.CLIPath != "/x/claude-query.sh" {
		t.Errorf("CLIPath = %q, want /x/claude-query.sh", loaded.CLIPath)
	}
	// Absent cli_path keeps the default (empty).
	if got := ParseSettings([]byte(`{"cli":"claude"}`)).CLIPath; got != "" {
		t.Errorf("CLIPath = %q, want empty when absent", got)
	}
}

func TestParseSettings_WorkerPoolsOverlay(t *testing.T) {
	base := DefaultSettings()
	if base.WorkerPools == nil {
		t.Fatalf("DefaultSettings().WorkerPools should be non-nil (empty map)")
	}

	loaded := ParseSettings([]byte(`{"worker_pools":{"ai":5,"exec":8}}`))
	if loaded.WorkerPools["ai"] != 5 {
		t.Errorf("WorkerPools[\"ai\"] = %d, want 5", loaded.WorkerPools["ai"])
	}
	if loaded.WorkerPools["exec"] != 8 {
		t.Errorf("WorkerPools[\"exec\"] = %d, want 8", loaded.WorkerPools["exec"])
	}
}

func TestParseSettings_PromptTimeoutsOverlay(t *testing.T) {
	loaded := ParseSettings([]byte(`{"prompt_timeouts":{"file":120,"image":45}}`))
	if loaded.PromptTimeouts["file"] != 120 {
		t.Errorf("PromptTimeouts[\"file\"] = %d, want 120", loaded.PromptTimeouts["file"])
	}
	if loaded.PromptTimeouts["image"] != 45 {
		t.Errorf("PromptTimeouts[\"image\"] = %d, want 45", loaded.PromptTimeouts["image"])
	}
}

// The dead cli_timeout key was removed; ParseSettings must silently ignore it
// (unknown JSON keys are dropped) while still honouring cli_timeout_long.
func TestParseSettings_IgnoresRemovedCLITimeout(t *testing.T) {
	loaded := ParseSettings([]byte(`{"cli_timeout":5,"cli_timeout_long":90}`))
	if loaded.CLITimeoutLong != 90 {
		t.Errorf("CLITimeoutLong = %d, want 90", loaded.CLITimeoutLong)
	}
}

func TestDefaultSettings_CLITimeoutLong(t *testing.T) {
	if got := DefaultSettings().CLITimeoutLong; got != 60 {
		t.Errorf("DefaultSettings().CLITimeoutLong = %d, want 60", got)
	}
}

// DefaultSettings carries the full default containment profile in memory.
func TestDefaultSettings_ContainmentIsFullDefaultProfile(t *testing.T) {
	got := DefaultSettings().AI.Containment
	want := DefaultContainmentProfile()

	if !equalStrings(got.ToolNames(), want.ToolNames()) {
		t.Fatalf("DefaultSettings().AI.Containment.ToolNames() = %v, want %v", got.ToolNames(), want.ToolNames())
	}
	if len(got.Directories) != len(want.Directories) {
		t.Fatalf("DefaultSettings().AI.Containment.Directories = %+v, want %+v", got.Directories, want.Directories)
	}
	if len(got.McpServers) != len(want.McpServers) {
		t.Fatalf("DefaultSettings().AI.Containment.McpServers = %+v, want %+v", got.McpServers, want.McpServers)
	}
}

// Marshalling the default settings must NOT write any baseline containment
// entries — settings.json holds only user additions, defaults live in code.
func TestSettings_Marshal_DropsBaselineContainment(t *testing.T) {
	data, err := DefaultSettings().Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	var raw struct {
		AI struct {
			Containment struct {
				Tools       []ToolGrant `json:"tools"`
				Directories []DirGrant  `json:"directories"`
				McpServers  []McpGrant  `json:"mcpServers"`
			} `json:"containment"`
		} `json:"ai"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("re-unmarshal error: %v\ndata: %s", err, data)
	}

	if len(raw.AI.Containment.Tools) != 0 {
		t.Errorf("marshalled ai.containment.tools = %+v, want none (all baseline)", raw.AI.Containment.Tools)
	}
	if len(raw.AI.Containment.Directories) != 0 {
		t.Errorf("marshalled ai.containment.directories = %+v, want none (all baseline)", raw.AI.Containment.Directories)
	}
	if len(raw.AI.Containment.McpServers) != 0 {
		t.Errorf("marshalled ai.containment.mcpServers = %+v, want none (all baseline)", raw.AI.Containment.McpServers)
	}
}

// Round-trip: default -> Marshal -> ParseSettings == DefaultContainmentProfile().
func TestParseSettings_ContainmentRoundTrip_Default(t *testing.T) {
	data, err := DefaultSettings().Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	got := ParseSettings(data).AI.Containment
	want := DefaultContainmentProfile()

	if !equalStrings(got.ToolNames(), want.ToolNames()) {
		t.Fatalf("round-trip ToolNames = %v, want %v", got.ToolNames(), want.ToolNames())
	}
	if len(got.Directories) != len(want.Directories) {
		t.Fatalf("round-trip Directories = %+v, want %+v", got.Directories, want.Directories)
	}
	if len(got.McpServers) != len(want.McpServers) {
		t.Fatalf("round-trip McpServers = %+v, want %+v", got.McpServers, want.McpServers)
	}
}

// DefaultSettings carries the out-of-the-box diagram defaults: the public
// PlantUML server and mermaid as the engine new diagram blocks are born with.
func TestDefaultSettings_Diagram(t *testing.T) {
	got := DefaultSettings().Diagram
	if got.PlantumlServer != "https://www.plantuml.com/plantuml" {
		t.Errorf("Diagram.PlantumlServer = %q, want https://www.plantuml.com/plantuml", got.PlantumlServer)
	}
	if got.DefaultType != "mermaid" {
		t.Errorf("Diagram.DefaultType = %q, want mermaid", got.DefaultType)
	}
}

// ParseSettings overlays loaded diagram values onto the defaults, keeping
// defaults for absent/empty fields.
func TestParseSettings_DiagramOverlay(t *testing.T) {
	loaded := ParseSettings([]byte(`{"diagram":{"plantuml_server":"https://plantuml.example.com","default_type":"plantuml"}}`))
	if loaded.Diagram.PlantumlServer != "https://plantuml.example.com" {
		t.Errorf("Diagram.PlantumlServer = %q, want https://plantuml.example.com", loaded.Diagram.PlantumlServer)
	}
	if loaded.Diagram.DefaultType != "plantuml" {
		t.Errorf("Diagram.DefaultType = %q, want plantuml", loaded.Diagram.DefaultType)
	}
}

// An absent/empty diagram object keeps both defaults.
func TestParseSettings_DiagramOverlay_AbsentKeepsDefaults(t *testing.T) {
	loaded := ParseSettings([]byte(`{}`))
	want := DefaultSettings().Diagram
	if loaded.Diagram != want {
		t.Errorf("Diagram = %+v, want defaults %+v", loaded.Diagram, want)
	}
}

// Partial overlay: only one field supplied, the other keeps its default.
func TestParseSettings_DiagramOverlay_PartialKeepsOtherDefault(t *testing.T) {
	loaded := ParseSettings([]byte(`{"diagram":{"default_type":"plantuml"}}`))
	if loaded.Diagram.PlantumlServer != "https://www.plantuml.com/plantuml" {
		t.Errorf("Diagram.PlantumlServer = %q, want default preserved", loaded.Diagram.PlantumlServer)
	}
	if loaded.Diagram.DefaultType != "plantuml" {
		t.Errorf("Diagram.DefaultType = %q, want plantuml", loaded.Diagram.DefaultType)
	}
}

// Corrupt JSON falls back to defaults entirely, including the diagram family.
func TestParseSettings_DiagramOverlay_CorruptJSONUsesDefaults(t *testing.T) {
	loaded := ParseSettings([]byte(`{not valid json`))
	want := DefaultSettings().Diagram
	if loaded.Diagram != want {
		t.Errorf("Diagram = %+v, want defaults %+v", loaded.Diagram, want)
	}
}

// Round-trip: Marshal -> ParseSettings preserves a customised diagram family.
func TestParseSettings_DiagramRoundTrip(t *testing.T) {
	s := DefaultSettings()
	s.Diagram.PlantumlServer = "https://plantuml.example.com"
	s.Diagram.DefaultType = "plantuml"

	data, err := s.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error: %v", err)
	}

	got := ParseSettings(data).Diagram
	if got.PlantumlServer != "https://plantuml.example.com" {
		t.Errorf("round-trip PlantumlServer = %q, want https://plantuml.example.com", got.PlantumlServer)
	}
	if got.DefaultType != "plantuml" {
		t.Errorf("round-trip DefaultType = %q, want plantuml", got.DefaultType)
	}
}

// ParseSettings overlays user-added directory + mcp entries from JSON onto the
// default profile: the additions are present alongside the untouched defaults.
func TestParseSettings_ContainmentOverlay_UserAdditions(t *testing.T) {
	payload := `{
		"ai": {
			"containment": {
				"directories": [{"path": "/x"}],
				"mcpServers": [{"name": "forgejo", "command": "forgejo-mcp", "args": ["serve"]}]
			}
		}
	}`

	got := ParseSettings([]byte(payload)).AI.Containment

	if !equalStrings(got.ToolNames(), []string{"Read", "Text search", "File search", "Fetch"}) {
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
		}
	}
	if !foundLibrary || !foundNote || !foundX {
		t.Fatalf("Directories = %+v, want library+note+/x", got.Directories)
	}

	foundSieve, foundForgejo := false, false
	for _, m := range got.McpServers {
		if m.Name == "sieve" {
			foundSieve = true
		}
		if m.Name == "forgejo" {
			foundForgejo = true
		}
	}
	if !foundSieve || !foundForgejo {
		t.Fatalf("McpServers = %+v, want sieve+forgejo", got.McpServers)
	}
}
