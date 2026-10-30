package processors

import (
	"context"
	"testing"

	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

type stubWebClipRunner struct {
	ret string
	err error
}

func (s stubWebClipRunner) Run(_, _, _, _, _ string, _ int, _ string, _ domain.ContainmentProfile, _ string) (string, error) {
	return s.ret, s.err
}

func TestWebClipProcessor_RunJob_stampsPageAttr(t *testing.T) {
	root := t.TempDir()
	fs, err := filestore.NewFileStore(root, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	prompts, err := ai.NewPromptService(fs)
	if err != nil {
		t.Fatalf("NewPromptService: %v", err)
	}
	aiSvc := ai.NewAIService(state, prompts, ds, nil, root)

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New doc: %v", err)
	}
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save doc: %v", err)
	}
	uuid := doc.UUID()
	sourceURL := "https://example.com/suzuka"

	p := NewWebClipBlockProcessor(block.BlockServices{AI: aiSvc, Documents: ds, State: state})
	runJob := func(t *testing.T, id, source string) (*block.SieveBlock, error) {
		t.Helper()
		attrs := p.InitAttrs(id, map[string]interface{}{"source": source, "mode": "summarise"})
		if attrs["page"] != "" {
			t.Errorf("InitAttrs page = %v, want empty string", attrs["page"])
		}
		blk := &block.SieveBlock{ID: id, Kind: "web-clip", Attrs: attrs}
		job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: uuid, Block: blk})
		res, werr := job.Work()
		if werr != nil {
			return blk, werr
		}
		job.Apply(res, blk)
		return blk, nil
	}
	aiSvc.SetRunner(stubWebClipRunner{ret: "# Suzuka Schedule\n\nGates open at 08:00."})

	t.Run("leaves page empty when no page asset exists", func(t *testing.T) {
		blk, err := runJob(t, "wc-0", sourceURL)
		if err != nil {
			t.Fatalf("Work error: %v", err)
		}
		if blk.Attrs["page"] != "" {
			t.Errorf("page = %v, want empty", blk.Attrs["page"])
		}
	})

	t.Run("stamps page attr when page asset exists", func(t *testing.T) {
		key := ds.PageAssetKey(sourceURL)
		if _, err := ds.SaveAsset(doc, key, []byte("<!doctype html><html><head><title>Suzuka Schedule</title></head><body><p>Gates open at 08:00.</p></body></html>")); err != nil {
			t.Fatalf("SaveAsset: %v", err)
		}
		blk, err := runJob(t, "wc-1", sourceURL)
		if err != nil {
			t.Fatalf("Work error: %v", err)
		}
		if blk.Attrs["status"] != block.BlockStatusComplete {
			t.Errorf("status = %v, want COMPLETE", blk.Attrs["status"])
		}
		wantPage := "sieve://" + uuid + "/" + key
		if blk.Attrs["page"] != wantPage {
			t.Errorf("page = %v, want %q", blk.Attrs["page"], wantPage)
		}
		if blk.Attrs["title"] != "Suzuka Schedule" {
			t.Errorf("title = %v, want Suzuka Schedule", blk.Attrs["title"])
		}
	})
}
