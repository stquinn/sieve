package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// Integration-style: a doc-targeted follow-up ai-block. TARGET (whole-doc content)
// must EXCLUDE the prior completed ai-block's response, while THREAD (the resolved
// conversation chain) must STILL carry it. This is the TARGET-leak fix end to end:
// buildTargets passes its exclude-own-kind closure as the filter; the thread loop
// does not.
// The DocView is built via the real markdown -> shadow -> snapshot path (no
// cross-package construction seam).
func TestAIBlock_DocTarget_ExcludesPriorAnswerButThreadKeepsIt(t *testing.T) {
	resetRegistry() // registers ProseProcessor
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(block.BlockServices{})

	const proseText = "the grass is green"
	const priorAnswer = "PRIOR-ANSWER-the-sky-is-blue"

	// Ids are UUIDs since #75, and NewShadow migrates any that are not — so the
	// fixture seeds real uuids rather than readable handles, keeping the ids stable
	// across the markdown -> shadow -> snapshot round trip this test relies on.
	const (
		proseID  = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01"
		priorID  = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02"
		followID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03"
	)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	seedBlocks := []block.SieveBlock{
		block.NewSieveBlock(block.KindProse, proseID, map[string]interface{}{"content": proseText}),
		// Completed prior ask, asked about the whole doc.
		block.NewSieveBlock("ai-block", priorID, map[string]interface{}{
			"id": priorID, "ref": "doc", "type": "ASK", "status": block.BlockStatusComplete,
			"question": "what colour is the sky?", "response": priorAnswer,
		}),
		// The follow-up (ACTION) block: threads off the prior ask.
		block.NewSieveBlock("ai-block", followID, map[string]interface{}{
			"id": followID, "ref": priorID, "type": "ASK", "status": block.BlockStatusPending,
			"question": "expand on that",
		}),
	}
	body, err := codec.Serialize(seedBlocks)
	if err != nil {
		t.Fatalf("seed serialize: %v", err)
	}
	shadow := block.NewShadow("u", body, codec, 0, nil)
	_, doc, ok := shadow.SnapshotForJob(followID)
	if !ok {
		t.Fatalf("SnapshotForJob(%s) not found; body was:\n%s", followID, body)
	}

	targets, threadIDs := p.resolveChain(followID, priorID, doc)
	if len(targets) != 1 || targets[0] != "doc" {
		t.Fatalf("expected targets=[doc], got %v", targets)
	}
	if len(threadIDs) != 1 || threadIDs[0] != priorID {
		t.Fatalf("expected thread=[%s], got %v", priorID, threadIDs)
	}

	// TARGET: filtered whole-doc content.
	targetContent := p.buildTargets(targets, doc)
	if !strings.Contains(targetContent, proseText) {
		t.Errorf("TARGET lost prose content; got %q", targetContent)
	}
	if strings.Contains(targetContent, priorAnswer) {
		t.Errorf("TARGET leaked the prior ai-block response; got %q", targetContent)
	}
	if strings.Contains(targetContent, "ai-block") {
		t.Errorf("TARGET leaked an ai-block fence; got %q", targetContent)
	}

	// THREAD: the prior answer must survive so follow-ups can build on it.
	var history []string
	seen := map[string]bool{followID: true}
	for _, id := range threadIDs {
		if c := block.BuildContextForID(id, doc, seen, nil); !c.IsEmpty() {
			history = append(history, c.String())
		}
	}
	joined := strings.Join(history, "\n")
	if !strings.Contains(joined, priorAnswer) {
		t.Errorf("THREAD dropped the prior answer (follow-ups need it); got %q", joined)
	}
}
