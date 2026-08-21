package editor

import (
	"encoding/json"
	"sieve/sieve/block"
	"strings"
	"testing"
)

// testMarkdownProcessor returns a fixed MarkdownRepresentation so we can
// assert the promote-to-prose transform without depending on any real processor.
type testMarkdownProcessor struct {
	md string
	block.FencedSerializer
	block.FencedDeserializer
}

func (p *testMarkdownProcessor) Kind() string { return p.FencedDeserializer.Kind }
func (p *testMarkdownProcessor) InitAttrs(id string, _ map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (p *testMarkdownProcessor) IsSupportedContent(_ []block.ContentEntry) block.SupportedActions {
	return block.SupportedActions{}
}
func (p *testMarkdownProcessor) Transform(_ []block.ContentEntry, _, _ string, action block.Action) map[string]interface{} {
	return nil
}
func (p *testMarkdownProcessor) DescribeJob(_ block.JobContext) *block.ProcessorJob {
	return nil
}
func (p *testMarkdownProcessor) OnChange(_ *block.SieveBlock) {}
func (p *testMarkdownProcessor) Mode() block.BlockMode        { return block.BlockModeBlock }
func (p *testMarkdownProcessor) BuildContext(_ block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	return block.AIContext{}
}
func (p *testMarkdownProcessor) MarkdownRepresentation(_ block.SieveBlock, _ string) string {
	return p.md
}

// TestEditorService_TransformToProse verifies that transforming a block to prose via the
// affordance path (CreateBlockFromEntries + ActionTransform) is equivalent to the
// retired PromoteBlock bespoke path: the block's MarkdownRepresentation is inserted
// as a PROSE block carrying the block's id (via the canonical <!--s:ID-->…<!--/s:ID-->
// prose markers), so AI ref chains keep resolving.
func TestEditorService_TransformToProse(t *testing.T) {
	block.RegisterProcessor(&testMarkdownProcessor{md: "promoted content", FencedDeserializer: block.FencedDeserializer{Kind: "test-md"}})
	t.Cleanup(func() { block.UnregisterProcessor("test-md") })

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte("Before\n\n```test-md\nid: tm-0001\n```\n\nAfter"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid)
	es.UpdateMarkdown(uuid, "Before\n\n```test-md\nid: tm-0001\n```\n\nAfter")

	// Replicate the retired PromoteBlock body: snapshot the block, build the
	// sieve/<kind> content entry, and ask CreateBlockFromEntries to transform it.
	src, found := es.shadows[uuid].SnapshotBlock("tm-0001")
	if !found {
		t.Fatalf("block tm-0001 not found in shadow")
	}
	attrsJSON, err := json.Marshal(src.Attrs)
	if err != nil {
		t.Fatalf("marshal attrs: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/" + src.Kind, Content: string(attrsJSON)}}
	if _, _, err := es.CreateBlockFromEntries(uuid, "prose", entries, 0, block.ActionTransform, "tm-0001"); err != nil {
		t.Fatalf("transform-to-prose: %v", err)
	}
	_ = es.Flush(uuid)

	saved, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	body := string(saved.Body())

	if strings.Contains(body, "[!block") {
		t.Errorf("retired anchor must not appear in saved markdown, got:\n%s", body)
	}
	// Promoted content is a prose block carrying the original id via prose markers.
	if !strings.Contains(body, `<!--s:tm-0001-->`) || !strings.Contains(body, `<!--/s:tm-0001-->`) {
		t.Errorf("expected prose markers carrying id tm-0001, got:\n%s", body)
	}
	if !strings.Contains(body, "promoted content") {
		t.Errorf("expected promoted content in saved markdown, got:\n%s", body)
	}
	if strings.Contains(body, "```test-md") {
		t.Errorf("expected original fence to be gone, got:\n%s", body)
	}
	if !strings.Contains(body, "Before") || !strings.Contains(body, "After") {
		t.Errorf("expected surrounding prose to be preserved, got:\n%s", body)
	}

	// End-to-end: reopening parses the promoted region back as an id-bearing prose
	// block, so AI ref chains pointing at tm-0001 still resolve.
	blocks, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(body)
	if err != nil {
		t.Fatalf("Deserialize saved body: %v", err)
	}
	var found2 bool
	for _, b := range blocks {
		if b.ID == "tm-0001" {
			found2 = true
			if b.Kind != block.KindProse {
				t.Errorf("promoted block kind = %q, want prose", b.Kind)
			}
			if !strings.Contains(b.Content(), "promoted content") {
				t.Errorf("promoted prose content = %q, want to contain 'promoted content'", b.Content())
			}
		}
	}
	if !found2 {
		t.Errorf("no block with preserved id tm-0001 after reopen:\n%#v", blocks)
	}
}
