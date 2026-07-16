package ai

import (
	"path/filepath"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// noteDir must resolve to the note's OWN folder (which holds its markdown +
// assets), not the note's parent directory — the CLI cwd and the "note"
// containment grant scope to this note. Regression: an earlier filepath.Dir
// over-scoped cwd to the buffers/category root.
func TestNoteDir_ResolvesNoteOwnFolder(t *testing.T) {
	root := t.TempDir()
	fs, err := filestore.NewFileStore(root, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	doc.SetBody([]byte("# note"))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	svc := &AIService{documents: ds, storePath: root}
	got := svc.noteDir(doc.UUID())

	want := filepath.Join(root, doc.Storable().ExternalRef())
	if got != want {
		t.Fatalf("noteDir = %q, want the note's own folder %q", got, want)
	}
	if got == filepath.Dir(want) {
		t.Errorf("noteDir over-scoped to the parent directory %q", got)
	}
}

// captureRunner is a stub CLIRunner: it records the invocation and returns a
// canned response instead of spawning a real CLI (CI has none installed).
type captureRunner struct {
	op, cli, prompt, model, cwd, libraryDir string
	profile                                 domain.ContainmentProfile
	ret                                     string
	err                                     error
}

func (c *captureRunner) Run(op, cli, prompt, model string, timeoutSecs int, cwd string, profile domain.ContainmentProfile, libraryDir string) (string, error) {
	c.op, c.cli, c.prompt, c.model, c.cwd, c.libraryDir, c.profile = op, cli, prompt, model, cwd, libraryDir, profile
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
