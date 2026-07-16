package ai

import (
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// captureRunner is a stub CLIRunner: it records the invocation and returns a
// canned response instead of spawning a real CLI (CI has none installed).
type captureRunner struct {
	cli, prompt, model, cwd, libraryDir string
	profile                             domain.ContainmentProfile
	ret                                 string
	err                                 error
}

func (c *captureRunner) Run(cli, prompt, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error) {
	c.cli, c.prompt, c.model, c.cwd, c.libraryDir, c.profile = cli, prompt, model, cwd, libraryDir, profile
	return c.ret, c.err
}

// RefineLanguage (a representative AI op) must hand the runner the default
// containment profile and the library directory (= storePath) — proving the
// containment floor threads through every AI call without a live CLI.
func TestRefineLanguage_ThreadsProfileAndLibraryDir(t *testing.T) {
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	state, err := services.NewStateService(fs)
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
	if _, err := fs.CreateText(domain.Prompts, "refine.txt", []byte("Language of: {content}")); err != nil {
		t.Fatalf("write refine prompt: %v", err)
	}

	cap := &captureRunner{ret: "go"}
	svc := &AIService{state: state, prompts: prompts, storePath: "/vault/library", runner: cap}

	lang, err := svc.RefineLanguage("func main() {}", "", "")
	if err != nil {
		t.Fatalf("RefineLanguage: %v", err)
	}
	if lang != "go" {
		t.Errorf("lang = %q, want go", lang)
	}

	// The library grant resolves to storePath.
	if cap.libraryDir != "/vault/library" {
		t.Errorf("libraryDir = %q, want /vault/library", cap.libraryDir)
	}
	// The runner receives the default containment floor: read-only tools + WebFetch,
	// no write tools.
	names := cap.profile.ToolNames()
	if len(names) != 4 || names[3] != "WebFetch" {
		t.Errorf("profile tools = %v, want [Read Grep Glob WebFetch]", names)
	}
	for _, n := range names {
		if n == "Write" || n == "Edit" {
			t.Errorf("default profile must not grant write tool %q", n)
		}
	}
	if cap.cli != "claude" {
		t.Errorf("cli = %q, want claude", cap.cli)
	}
}
