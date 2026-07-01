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
