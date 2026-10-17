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

type stubNodeResolver struct {
	resolveFunc func(addr domain.Address) (domain.NodeDescriptor, error)
}

func (s *stubNodeResolver) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	if s.resolveFunc != nil {
		return s.resolveFunc(addr)
	}
	return domain.NodeDescriptor{}, domain.ErrNodeNotFound
}

func TestAIService_DescribeImage_resolvesViaNodeResolver(t *testing.T) {
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

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("doc: %v", err)
	}
	if doc, err = ds.Save(doc); err != nil {
		t.Fatalf("save doc: %v", err)
	}

	docDir := filepath.Join(root, doc.Storable().ExternalRef())
	assetName := "resolver-test.png"
	if err := os.WriteFile(filepath.Join(docDir, assetName), []byte("image-data"), 0o644); err != nil {
		t.Fatalf("write asset: %v", err)
	}

	settings := domain.DefaultSettings()
	settings.CLI = "claude"
	settings.CLIPath = filepath.Join(t.TempDir(), "stub")
	_ = os.WriteFile(settings.CLIPath, []byte("#!/bin/sh\nexit 0\n"), 0o755)
	_ = state.SaveSettings(settings)

	cap := &captureRunner{ret: `{"alt":"Resolved Alt","summary":"Via NodeResolver"}`}
	svc := &AIService{
		state:     state,
		prompts:   prompts,
		storePath: root,
		documents: ds,
		runner:    cap,
	}

	calledResolver := false
	resolver := &stubNodeResolver{
		resolveFunc: func(addr domain.Address) (domain.NodeDescriptor, error) {
			calledResolver = true
			return domain.NodeDescriptor{
				Kind: "asset",
				Path: filepath.Join(doc.Storable().ExternalRef(), assetName),
			}, nil
		},
	}
	svc.SetNodes(resolver)

	desc, err := svc.DescribeImage(doc.UUID(), "/"+assetName, "blk-1")
	if err != nil {
		t.Fatalf("DescribeImage: %v", err)
	}
	if !calledResolver {
		t.Error("expected NodeResolver to be called during DescribeImage")
	}
	if desc.Alt != "Resolved Alt" {
		t.Errorf("got alt %q, want %q", desc.Alt, "Resolved Alt")
	}
	if cap.cwd != docDir {
		t.Errorf("got cwd %q, want %q", cap.cwd, docDir)
	}
}

