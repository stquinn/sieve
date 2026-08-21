package editor

import (
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

// ExportMarkdown takes the CALLER's BlockFilter (a closure): the exclusion policy
// belongs to the call site (the export handler drops ai-blocks; another caller may
// not), NOT to EditorService — which only resolves the shadow and delegates. A nil
// filter exports everything; an unopened document is an error.
func TestEditorService_ExportMarkdown_CallerOwnsFilter(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("prose stays\n\n```code\nid: co-1\nlanguage: go\nsource: x := 1\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer es.Close(uuid)

	// Caller's closure drops code blocks.
	noCode, err := es.ExportMarkdown(uuid, func(b block.SieveBlock) bool { return b.Kind != "code" })
	if err != nil {
		t.Fatalf("ExportMarkdown(filter): %v", err)
	}
	if strings.Contains(noCode, "x := 1") {
		t.Errorf("filter must drop code blocks, got %q", noCode)
	}
	if !strings.Contains(noCode, "prose stays") {
		t.Errorf("filter must keep prose, got %q", noCode)
	}

	// Nil filter exports everything.
	all, err := es.ExportMarkdown(uuid, nil)
	if err != nil {
		t.Fatalf("ExportMarkdown(nil): %v", err)
	}
	if !strings.Contains(all, "x := 1") || !strings.Contains(all, "prose stays") {
		t.Errorf("nil filter must export every block, got %q", all)
	}

	// Unopened document is an error.
	if _, err := es.ExportMarkdown("no-such-doc", nil); err == nil {
		t.Error("ExportMarkdown must error for a document that is not open")
	}
}
