package sieve

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

// testMarkdownProcessor returns a fixed MarkdownRepresentation so we can
// assert the block anchor wrapper without depending on any real processor.
type testMarkdownProcessor struct {
	md string
	block.FencedSerializer
	block.FencedDeserializer
}

func (p *testMarkdownProcessor) InitAttrs(id string, _ map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (p *testMarkdownProcessor) IsBlock(_ []block.ContentEntry) bool { return false }
func (p *testMarkdownProcessor) Transform(_ []block.ContentEntry, _, _ string) map[string]interface{} {
	return nil
}
func (p *testMarkdownProcessor) RunJob(_ block.JobContext) error     { return nil }
func (p *testMarkdownProcessor) JobLabel(_ *block.SieveBlock) string { return "" }
func (p *testMarkdownProcessor) OnChange(_ *block.SieveBlock)        {}
func (p *testMarkdownProcessor) Mode() block.BlockMode               { return block.BlockModeBlock }
func (p *testMarkdownProcessor) BuildContext(_ block.SieveBlock, _ block.DocView, _ map[string]bool) string {
	return ""
}
func (p *testMarkdownProcessor) MarkdownRepresentation(_ block.SieveBlock) string { return p.md }

func TestEditorService_PromoteBlock_wrapsInBlockAnchor(t *testing.T) {
	block.RegisterProcessor("test-md", &testMarkdownProcessor{md: "promoted content", FencedDeserializer: block.FencedDeserializer{Kind: "test-md"}})
	t.Cleanup(func() { block.UnregisterProcessor("test-md") })

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte("Before\n\n```test-md\nid: tm-0001\n```\n\nAfter"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)
	es.UpdateMarkdown(uuid, "Before\n\n```test-md\nid: tm-0001\n```\n\nAfter")

	if err := es.PromoteBlock(uuid, "tm-0001"); err != nil {
		t.Fatalf("PromoteBlock: %v", err)
	}

	saved, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	body := string(saved.Body())

	if !strings.Contains(body, `[!block] id="tm-0001"`) {
		t.Errorf("expected block anchor header in saved markdown, got:\n%s", body)
	}
	if !strings.Contains(body, "promoted content") {
		t.Errorf("expected promoted content in saved markdown, got:\n%s", body)
	}
	if !strings.Contains(body, "[!block-end]") {
		t.Errorf("expected [!block-end] in saved markdown, got:\n%s", body)
	}
	// Blank lines around the content are required so markdownit renders [!block] and
	// [!block-end] as isolated <p> elements, which the blockRef updateDOM step can find.
	if !strings.Contains(body, "[!block] id=\"tm-0001\"\n\npromoted content\n\n[!block-end]") {
		t.Errorf("expected blank lines separating block anchor sentinels from content, got:\n%s", body)
	}
	if strings.Contains(body, "```test-md") {
		t.Errorf("expected original fence to be gone, got:\n%s", body)
	}
	if !strings.Contains(body, "Before") || !strings.Contains(body, "After") {
		t.Errorf("expected surrounding prose to be preserved, got:\n%s", body)
	}
}
