package ai

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

func newSmartTestService(t *testing.T, cap *captureRunner) *AIService {
	t.Helper()
	root := t.TempDir()
	fs, err := filestore.NewFileStore(root, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	settings := domain.DefaultSettings()
	settings.CLI = "claude" // dialect only — arg rendering is unaffected by CLIPath
	// Tier() probes the RESOLVED binary with exec.LookPath, so a bare "claude"
	// makes the tier depend on the machine having an AI CLI installed: smart
	// locally, dumb in CI, and every test below fails there with "not available
	// in dumb mode". Point the probe at a stub inside the test's temp dir. The
	// path is absolute, so LookPath never consults PATH — which matters because
	// Tier() overwrites PATH with the login shell's. The runner is stubbed, so
	// this file is never executed; it only has to exist and be executable.
	stub := filepath.Join(t.TempDir(), "stub-ai-cli")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write stub CLI: %v", err)
	}
	settings.CLIPath = stub
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	return &AIService{state: state, prompts: prompts, storePath: root, runner: cap}
}

// assertRan fails t unless the captured run was the task named name, as ps
// declares it, sent the prompt ps builds for it with data on container (empty
// when the run has none), speaking of the Sieve tools exactly when the run
// carries them.
func (c *captureRunner) assertRan(t *testing.T, ps *PromptService, name, container string, data TaskData) {
	t.Helper()
	task, err := ps.Task(name)
	if err != nil {
		t.Fatal(err)
	}
	if c.run.Task != task {
		t.Errorf("ran task %+v, want %+v", c.run.Task, task)
	}
	if want := ps.Prompt(task, data, container, c.run.carriesSieveTools()); c.run.Prompt != want {
		t.Errorf("prompt =\n%s\nwant\n%s", c.run.Prompt, want)
	}
}

func TestRunBtw_PromptAssemblyAndOp(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)
	out, err := svc.RunBtw("what is KISS", "the selected words", "My Doc", "a summary", domain.Exchange{Container: "uuid-1"})
	if err != nil || out.Text != "answer" {
		t.Fatalf("unexpected: %v %q", err, out.Text)
	}
	cap.assertRan(t, svc.prompts, "btw", "uuid-1", BtwData{Question: "what is KISS", Selection: "the selected words", DocTitle: "My Doc", DocSummary: "a summary"})
}

func TestRunBtw_TierDumbFails(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)
	settings := domain.DefaultSettings()
	settings.CLI = "" // dumb mode
	if err := svc.state.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	_, err := svc.RunBtw("question", "", "", "", domain.Exchange{})
	if err == nil || !strings.Contains(err.Error(), "dumb mode") {
		t.Fatalf("expected dumb mode error, got %v", err)
	}
}

func TestRunBtw_NoDocUsesStorePathCwd(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)
	_, err := svc.RunBtw("question", "", "", "", domain.Exchange{})
	if err != nil {
		t.Fatal(err)
	}
	if cap.run.Cwd != svc.storePath {
		t.Fatalf("cwd = %q, want storePath %q", cap.run.Cwd, svc.storePath)
	}
}
