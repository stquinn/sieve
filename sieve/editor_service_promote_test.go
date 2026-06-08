package sieve

import (
	"strings"
	"testing"
)

// testMarkdownProcessor returns a fixed MarkdownRepresentation so we can
// assert the block anchor wrapper without depending on any real processor.
type testMarkdownProcessor struct{ md string }

func (p *testMarkdownProcessor) InitAttrs(id string, _ map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (p *testMarkdownProcessor) PasteMatch(_ []PasteEntry, _, _ string) (bool, map[string]interface{}) {
	return false, nil
}
func (p *testMarkdownProcessor) RunJob(_ JobContext) error         { return nil }
func (p *testMarkdownProcessor) JobLabel(_ *SieveBlock) string     { return "" }
func (p *testMarkdownProcessor) OnChange(_ *SieveBlock)            {}
func (p *testMarkdownProcessor) Mode() BlockMode                   { return BlockModeBlock }
func (p *testMarkdownProcessor) BuildContext(_ SieveBlock, _ ShadowDocument, _ map[string]bool) string {
	return ""
}
func (p *testMarkdownProcessor) MarkdownRepresentation(_ SieveBlock) string { return p.md }

func TestEditorService_PromoteBlock_wrapsInBlockAnchor(t *testing.T) {
	RegisterProcessor("test-md", &testMarkdownProcessor{md: "promoted content"})
	t.Cleanup(func() { UnregisterProcessor("test-md") })

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
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
	if strings.Contains(body, "```test-md") {
		t.Errorf("expected original fence to be gone, got:\n%s", body)
	}
	if !strings.Contains(body, "Before") || !strings.Contains(body, "After") {
		t.Errorf("expected surrounding prose to be preserved, got:\n%s", body)
	}
}
