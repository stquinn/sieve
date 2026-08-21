package editor

import (
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

func TestHandlePaste_stampsSmartPaste_onDetectionOnly(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte(""))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { waitJobs(t, es, uuid) })

	// Pass-2 detection: fenced code text (no sieve view) → tagged.
	res := es.HandlePaste(uuid, []block.ContentEntry{
		{MIMEType: "text/plain", Content: "```python\nx = 1\ny = 2\n```"},
	}, -1)
	if !res.IsBlock() {
		t.Fatalf("expected detection paste to create a block, got %q", res.Outcome)
	}
	blk, found := es.shadows[uuid].SnapshotBlock(res.ID)
	if !found {
		t.Fatal("block not found in shadow")
	}
	if blk.Attrs["smartPaste"] != true {
		t.Errorf("detected paste must be tagged smartPaste; attrs=%v", blk.Attrs)
	}

	// Pass-1 round-trip: a copied code block's own sieve view → NOT tagged.
	res2 := es.HandlePaste(uuid, []block.ContentEntry{
		{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2","language":"python"}`},
	}, -1)
	if !res2.IsBlock() {
		t.Fatalf("expected round-trip paste to create a block, got %q", res2.Outcome)
	}
	blk2, found2 := es.shadows[uuid].SnapshotBlock(res2.ID)
	if !found2 {
		t.Fatal("block2 not found in shadow")
	}
	if blk2.Attrs["smartPaste"] == true {
		t.Errorf("round-trip paste must NOT be tagged smartPaste; attrs=%v", blk2.Attrs)
	}
}

// newTestEditorServiceWithProseBlock creates an EditorService with an open document
// containing a single prose block with id "pr-1" holding a native code fence.
// Modelled on editor_service_promote_test.go's setup.
func newTestEditorServiceWithProseBlock(t *testing.T) (*EditorService, string) {
	t.Helper()
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	// A prose block wrapping a native code fence — the classic TRANSFORM source.
	body := "<!--s:pr-1-->\n```go\nx := 0\n```\n<!--/s:pr-1-->"
	doc, _ := ds.New()
	doc.SetBody([]byte(body))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Sync the shadow markdown so the tree reflects the body.
	es.UpdateMarkdown(uuid, body)
	// Drain any background jobs before TempDir cleanup.
	t.Cleanup(func() { waitJobs(t, es, uuid) })
	return es, uuid
}

func TestCreateBlockFromEntries_transform_replacesInPlace(t *testing.T) {
	es, uuid := newTestEditorServiceWithProseBlock(t)
	// TRANSFORM the prose block "pr-1" into a code block.
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	id, _, err := es.CreateBlockFromEntries(uuid, "code", entries, 0, block.ActionTransform, "pr-1")
	if err != nil {
		t.Fatalf("transform failed: %v", err)
	}
	blk, found := es.shadows[uuid].SnapshotBlock(id)
	if !found || blk.Kind != "code" {
		t.Fatalf("expected code block in place, found=%v blk=%+v", found, blk)
	}
	if _, stillThere := es.shadows[uuid].SnapshotBlock("pr-1"); stillThere && id != "pr-1" {
		t.Fatalf("source pr-1 should have been replaced, not survive alongside")
	}
}

func TestCreateBlockFromEntries_extract_isAdditive(t *testing.T) {
	es, uuid := newTestEditorServiceWithProseBlock(t)
	before := len(es.shadows[uuid].SnapshotBlocks())
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	_, _, err := es.CreateBlockFromEntries(uuid, "code", entries, -1, block.ActionExtract, "")
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if got := len(es.shadows[uuid].SnapshotBlocks()); got != before+1 {
		t.Fatalf("extract should add one block: before=%d after=%d", before, got)
	}
}
