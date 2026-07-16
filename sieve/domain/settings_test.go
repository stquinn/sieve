package domain

import (
	"encoding/json"
	"testing"
)

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
