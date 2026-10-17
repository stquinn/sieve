package ai

import (
	"os"
	"path/filepath"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// timeoutFor reads only settings.PromptTimeouts and settings.CLITimeoutLong, so a
// zero-value AIService is sufficient to exercise the fallback logic.
func TestAIService_timeoutFor(t *testing.T) {
	s := &AIService{}

	settings := domain.Settings{
		CLITimeoutLong: 60,
		PromptTimeouts: map[string]int{
			"file": 120,
			"zero": 0, // explicit zero ⇒ treated as no override
		},
	}

	cases := []struct {
		name   string
		prompt string
		want   int
	}{
		{"override wins", "file", 120},
		{"absent falls back to global", "explain", 60},
		{"zero override falls back to global", "zero", 60},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := s.timeoutFor(settings, c.prompt); got != c.want {
				t.Errorf("timeoutFor(%q) = %d, want %d", c.prompt, got, c.want)
			}
		})
	}

	// Nil map must not panic and always falls back.
	if got := s.timeoutFor(domain.Settings{CLITimeoutLong: 42}, "file"); got != 42 {
		t.Errorf("timeoutFor with nil map = %d, want 42", got)
	}
}

func TestAIService_DescribeImage_resolvesSieveURIForeignAsset(t *testing.T) {
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
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}

	doc1, err := ds.New()
	if err != nil {
		t.Fatalf("doc1: %v", err)
	}
	if doc1, err = ds.Save(doc1); err != nil {
		t.Fatalf("save doc1: %v", err)
	}

	doc2, err := ds.New()
	if err != nil {
		t.Fatalf("doc2: %v", err)
	}
	if doc2, err = ds.Save(doc2); err != nil {
		t.Fatalf("save doc2: %v", err)
	}

	// Write an asset in doc2's directory on disk
	doc2Dir := filepath.Join(root, doc2.Storable().ExternalRef())
	foreignAsset := "0194820a-81c2-7d34.png"
	if err := os.WriteFile(filepath.Join(doc2Dir, foreignAsset), []byte("fake-image-bytes"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	stub := filepath.Join(t.TempDir(), "stub-ai-cli")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write stub CLI: %v", err)
	}
	settings := domain.DefaultSettings()
	settings.CLI = "claude"
	settings.CLIPath = stub
	if err := state.SaveSettings(settings); err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}

	cap := &captureRunner{ret: `{"alt":"Foreign Diagram","summary":"A cross-container test flow"}`}
	svc := &AIService{
		state:     state,
		prompts:   prompts,
		storePath: root,
		documents: ds,
		runner:    cap,
	}

	foreignRef := "sieve://" + doc2.UUID() + "/" + foreignAsset
	desc, err := svc.DescribeImage(doc1.UUID(), foreignRef, "blk-1")
	if err != nil {
		t.Fatalf("DescribeImage failed on foreign sieve URI: %v", err)
	}

	if desc.Alt != "Foreign Diagram" || desc.Summary != "A cross-container test flow" {
		t.Errorf("unexpected desc: %+v", desc)
	}
	if cap.cwd != doc2Dir {
		t.Errorf("runner cwd: got %q, want %q (foreign doc directory)", cap.cwd, doc2Dir)
	}
}
