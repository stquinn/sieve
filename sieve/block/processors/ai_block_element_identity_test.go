package processors

import (
	"encoding/json"
	"testing"

	"sieve/sieve/block"
)

// A JOB SNAPSHOT SHARES ITS ELEMENT PAYLOADS WITH THE LIVE TREE. SnapshotForJob
// copies a block's attrs bag one level deep, so the question list inside it is
// the same slice of the same maps the open document holds — and the fold that
// assembles the prompt runs after the shadow's lock is released. A fold that
// minted an id as it read would be writing into the live document from a
// background goroutine.
//
// It writes nothing, because the create path identified every element before the
// block entered the tree. This pins BOTH halves: the ids are there after create,
// and the whole prompt assembly leaves the stored payload byte-identical.
func TestSnapshotForJob_foldingAFreshAskWritesNothingIntoTheLiveTree(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(NewReferenceProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	c, ok := composerCases(t)["asks about the whole document with an attachment"]
	if !ok {
		t.Fatal("the shared composer fixture names no whole-document case")
	}
	attrs := (&AIBlockProcessor{}).InitAttrs("ai-1", c.Attrs)

	// Read the STORED entries, never through Elements — that read would mint the
	// very ids this is asserting are already there.
	stored, _ := attrs[block.QuestionAttr].([]interface{})
	if len(stored) != 3 {
		t.Fatalf("stored question = %+v, want the composer's three elements", attrs[block.QuestionAttr])
	}
	for i, entry := range stored {
		entryAttrs, _ := entry.(map[string]interface{})["attrs"].(map[string]interface{})
		if id, _ := entryAttrs["id"].(string); id == "" {
			t.Fatalf("element %d entered the tree unidentified: %+v", i, entry)
		}
	}
	before := questionJSON(t, attrs)

	shadow := block.NewShadow(foldDocUUID, "", block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)
	if err := shadow.ApplyOp(block.BlockOp{
		Type: "create-block", BlockID: "ai-1", Kind: "ai-block", Attrs: attrs, Index: 0,
	}); err != nil {
		t.Fatalf("create-block: %v", err)
	}

	snap, doc, found := shadow.SnapshotForJob("ai-1")
	if !found {
		t.Fatal("expected SnapshotForJob to find the ai-block")
	}
	// Exactly what EditorService.RunJob hands the processor, off the lock.
	(&AIBlockProcessor{}).buildPrompt(&block.SieveBlock{ID: snap.ID, Kind: snap.Kind, Attrs: snap.Attrs}, doc)

	if after := questionJSON(t, attrs); after != before {
		t.Errorf("the fold wrote into the live question payload:\nbefore %s\nafter  %s", before, after)
	}
}

// questionJSON renders the stored question payload as sorted-key JSON — a form
// that changes if any element gains, loses or alters an attr.
func questionJSON(t *testing.T, attrs map[string]interface{}) string {
	t.Helper()
	body, err := json.Marshal(attrs[block.QuestionAttr])
	if err != nil {
		t.Fatalf("marshalling the stored question: %v", err)
	}
	return string(body)
}
