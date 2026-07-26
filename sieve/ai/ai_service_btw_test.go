package ai

import (
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
	settings.CLI = "claude"
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	return &AIService{state: state, prompts: prompts, storePath: root, runner: cap}
}

func TestRunBtw_PromptAssemblyAndOp(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)
	out, err := svc.RunBtw("what is KISS", "the selected words", "My Doc", "a summary", "uuid-1")
	if err != nil || out != "answer" {
		t.Fatalf("unexpected: %v %q", err, out)
	}
	if cap.op != "btw" {
		t.Fatalf("op = %q, want btw", cap.op)
	}
	for _, want := range []string{"what is KISS", "the selected words", "My Doc", "a summary", "uuid-1"} {
		if !strings.Contains(cap.prompt, want) {
			t.Fatalf("prompt missing %q in %q", want, cap.prompt)
		}
	}
	if strings.Contains(cap.prompt, "{question}") || strings.Contains(cap.prompt, "{selection}") {
		t.Fatal("unreplaced placeholders in prompt")
	}
}

func TestRunBtw_TierDumbFails(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)
	settings := domain.DefaultSettings()
	settings.CLI = "" // dumb mode
	if err := svc.state.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	_, err := svc.RunBtw("question", "", "", "", "")
	if err == nil || !strings.Contains(err.Error(), "dumb mode") {
		t.Fatalf("expected dumb mode error, got %v", err)
	}
}

func TestRunBtw_NoDocUsesStorePathCwd(t *testing.T) {
	cap := &captureRunner{ret: "answer"}
	svc := newSmartTestService(t, cap)
	_, err := svc.RunBtw("question", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if cap.cwd != svc.storePath {
		t.Fatalf("cwd = %q, want storePath %q", cap.cwd, svc.storePath)
	}
}
