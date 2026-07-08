package domain

import (
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
