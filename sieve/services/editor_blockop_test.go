package services

import (
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

// C.2b — EditorService.HandleBlockOp applies a wire op to the open shadow's Doc
// and the change persists on flush.
func TestEditorService_HandleBlockOp_UpdatesAndPersists(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("Intro.\n\n```code\nid: co-1\nsource: x = 1\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid, nil); err != nil {
		t.Fatalf("Open: %v", err)
	}

	err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", BlockID: "co-1", Kind: "code",
		Attrs: map[string]interface{}{"id": "co-1", "source": "y = 2"},
	})
	if err != nil {
		t.Fatalf("HandleBlockOp: %v", err)
	}
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	reloaded, _ := ds.LoadByUUID(uuid)
	body := string(reloaded.Body())
	if !strings.Contains(body, "source: y = 2") || strings.Contains(body, "source: x = 1") {
		t.Fatalf("op not persisted, disk body:\n%s", body)
	}
}

func TestEditorService_HandleBlockOp_NoShadowErrors(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	if err := es.HandleBlockOp("missing", block.BlockOp{Type: "update-block", BlockID: "x"}); err == nil {
		t.Fatal("expected error when no document is open")
	}
}

// C.1 — the disk-direct job-update path (no open shadow) must also go through
// the serialization spine, not InjectBlocks. Characterization test: behavior is
// preserved across the refactor.
func TestApplyJobUpdate_NoShadow_WritesViaSpine(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "ai-block"}})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("```ai-block\nid: ab-1\nresponse: old\nstatus: PENDING\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	// No Open → no shadow → disk-direct branch.
	es.applyJobUpdate(uuid, "ab-1", "ai-block",
		map[string]interface{}{"response": "new", "status": "COMPLETE"}, nil, "test")

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	body := string(reloaded.Body())
	if !strings.Contains(body, "response: new") {
		t.Fatalf("expected updated response on disk, got:\n%s", body)
	}
	if strings.Contains(body, "response: old") {
		t.Fatalf("stale response still on disk:\n%s", body)
	}
}
