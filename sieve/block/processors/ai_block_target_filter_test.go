package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// Accept (block.BlockFilter) rejects ONLY the ai-block kind; every other kind is
// kept. This is the policy that keeps prior AI answers out of the TARGET slot.
func TestAIBlockProcessor_Accept(t *testing.T) {
	p := NewAIBlockProcessor(block.BlockServices{})
	if p.Accept(block.SieveBlock{Kind: "ai-block"}) {
		t.Error("Accept must reject the ai-block kind")
	}
	for _, k := range []string{"prose", "code", "diagram", "web-clip", "smart-image"} {
		if !p.Accept(block.SieveBlock{Kind: k}) {
			t.Errorf("Accept must keep kind %q", k)
		}
	}
}

// Integration-style: a doc-targeted follow-up ai-block. TARGET (whole-doc content)
// must EXCLUDE the prior completed ai-block's response, while THREAD (the resolved
// conversation chain) must STILL carry it. This is the TARGET-leak fix end to end:
// buildTargets applies the processor as the filter; the thread loop does not.
// The DocView is built via the real markdown -> shadow -> snapshot path (no
// cross-package construction seam).
func TestAIBlock_DocTarget_ExcludesPriorAnswerButThreadKeepsIt(t *testing.T) {
	resetRegistry() // registers ProseProcessor
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(block.BlockServices{})

	const proseText = "the grass is green"
	const priorAnswer = "PRIOR-ANSWER-the-sky-is-blue"

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	seedBlocks := []block.SieveBlock{
		block.NewSieveBlock(block.KindProse, "pr-1", map[string]interface{}{"content": proseText}),
		// Completed prior ask, asked about the whole doc.
		block.NewSieveBlock("ai-block", "ab-1", map[string]interface{}{
			"id": "ab-1", "ref": "doc", "type": "ASK", "status": block.BlockStatusComplete,
			"question": "what colour is the sky?", "response": priorAnswer,
		}),
		// The follow-up (ACTION) block: threads off ab-1.
		block.NewSieveBlock("ai-block", "ab-2", map[string]interface{}{
			"id": "ab-2", "ref": "ab-1", "type": "ASK", "status": block.BlockStatusPending,
			"question": "expand on that",
		}),
	}
	body, err := codec.Serialize(seedBlocks)
	if err != nil {
		t.Fatalf("seed serialize: %v", err)
	}
	shadow := block.NewShadow("u", body, codec, 0, nil)
	_, doc, ok := shadow.SnapshotForJob("ab-2")
	if !ok {
		t.Fatalf("SnapshotForJob(ab-2) not found; body was:\n%s", body)
	}

	targets, threadIDs := p.resolveChain("ab-2", "ab-1", doc)
	if len(targets) != 1 || targets[0] != "doc" {
		t.Fatalf("expected targets=[doc], got %v", targets)
	}
	if len(threadIDs) != 1 || threadIDs[0] != "ab-1" {
		t.Fatalf("expected thread=[ab-1], got %v", threadIDs)
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
	seen := map[string]bool{"ab-2": true}
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
