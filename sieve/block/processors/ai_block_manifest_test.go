package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// Three library documents, named by address. NOTHING resolves them: a manifest
// is rendered from what the attachment already carries, so these titles are the
// ones the block persisted and these uuids are read straight out of the uris.
const (
	authURI  = "sieve://aaaaaaaa-1a2b-4c5d-8e9f-a1b2c3d4e5f6"
	retryURI = "sieve://bbbbbbbb-1a2b-4c5d-8e9f-a1b2c3d4e5f6"
	rateURI  = "sieve://cccccccc-1a2b-4c5d-8e9f-a1b2c3d4e5f6"
)

// aiBlockWithAttachments builds one chain turn.
func aiBlockWithAttachments(id, ref, question, response string, atts ...domain.Attachment) block.SieveBlock {
	blk := block.NewSieveBlock("ai-block", id, map[string]interface{}{
		"id": id, "ref": ref, "type": "ASK",
		"status": block.BlockStatusComplete, "question": question, "response": response,
	})
	blk.SetAttachments(atts)
	return blk
}

// Each ai-block in the chain carries its OWN attachments, so each thread entry
// emits its own section: a three-turn chain where each turn attached different
// documents renders three different manifests.
func TestAIBlock_ThreeTurnChain_EachTurnRendersItsOwnManifest(t *testing.T) {
	resetRegistry()
	svc := block.BlockServices{}
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(svc)
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	seed := []block.SieveBlock{
		block.NewSieveBlock(block.KindProse, "pr-1", map[string]interface{}{"content": "the grass is green"}),
		aiBlockWithAttachments("ab-1", "doc", "turn one?", "answer one", domain.Attachment{URI: authURI, Title: "Auth Design"}),
		aiBlockWithAttachments("ab-2", "ab-1", "turn two?", "answer two", domain.Attachment{URI: retryURI, Title: "Retry RFC"}),
		aiBlockWithAttachments("ab-3", "ab-2", "turn three?", "", domain.Attachment{URI: rateURI, Title: "Rate Limits"}),
	}
	body, err := codec.Serialize(seed)
	if err != nil {
		t.Fatalf("seed serialize: %v", err)
	}
	// NewShadow upgrades the fixture's readable handles to UUIDs on load, and
	// rewrites the chain's refs to match, so the action turn is asked for by
	// position rather than by the name it was seeded with.
	shadow := block.NewShadow("u", body, codec, 0, nil)
	loaded := shadow.SnapshotBlocks()
	actionID := loaded[len(loaded)-1].ID
	action, doc, ok := shadow.SnapshotForJob(actionID)
	if !ok {
		t.Fatalf("SnapshotForJob(%s) not found; body was:\n%s", actionID, body)
	}

	content, history, question := p.buildPrompt(&action, doc)

	// THREAD: two entries, oldest-first, each with its own section.
	if n := strings.Count(history, "ATTACHED DOCUMENTS"); n != 2 {
		t.Fatalf("THREAD rendered %d sections, want one per turn:\n%s", n, history)
	}
	authAt, retryAt := strings.Index(history, "Auth Design"), strings.Index(history, "Retry RFC")
	if authAt < 0 || retryAt < 0 || authAt > retryAt {
		t.Fatalf("THREAD sections are missing or out of order (auth=%d retry=%d):\n%s", authAt, retryAt, history)
	}
	if strings.Contains(history, "Rate Limits") {
		t.Errorf("the ACTION turn's attachment leaked into the THREAD:\n%s", history)
	}

	// ACTION: this turn's attachment only.
	if n := strings.Count(question, "ATTACHED DOCUMENTS"); n != 1 {
		t.Fatalf("ACTION rendered %d sections, want 1:\n%s", n, question)
	}
	if !strings.Contains(question, "Rate Limits") {
		t.Errorf("the ACTION turn lost its own attachment:\n%s", question)
	}
	if strings.Contains(question, "Auth Design") || strings.Contains(question, "Retry RFC") {
		t.Errorf("prior turns' attachments leaked into the ACTION:\n%s", question)
	}

	// TARGET is the document's own content — no attachment ever renders there.
	if strings.Contains(content, "ATTACHED DOCUMENTS") {
		t.Errorf("TARGET carried an attachments section:\n%s", content)
	}

	// The section sits between the question and the answer, per turn.
	if qAt, aAt := strings.Index(history, "ATTACHED DOCUMENTS"), strings.Index(history, "**ANSWER:**"); qAt < 0 || aAt < 0 || qAt > aAt {
		t.Errorf("the section must precede the turn's answer (att=%d ans=%d):\n%s", qAt, aAt, history)
	}
}

// An attachment whose address no verb can dereference renders the entry as
// unavailable rather than failing the job — the ask still runs, and the model is
// told which document it cannot see.
func TestAIBlock_UndereferenceableAttachment_RendersUnavailableAndStillAsks(t *testing.T) {
	resetRegistry()
	svc := block.BlockServices{}
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(svc)
	blk := aiBlockWithAttachments("ab-1", "doc", "still answerable?", "",
		domain.Attachment{URI: "sieve://not-a-uuid", Title: "Some Block"})
	_, _, question := p.buildPrompt(&blk, block.DocView{})

	if !strings.Contains(question, "still answerable?") {
		t.Fatalf("the question survived nothing:\n%s", question)
	}
	if !strings.Contains(question, "\"unavailable\": true") {
		t.Fatalf("undereferenceable attachment not marked unavailable:\n%s", question)
	}
	if !strings.Contains(question, "Some Block") {
		t.Errorf("the persisted title is what labels the entry:\n%s", question)
	}
}

// A turn with no attachments is byte-identical to what it was before the attr
// existed — the whole feature is invisible until someone uses it.
func TestAIBlock_NoAttachments_PromptUnchanged(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(block.BlockServices{})
	blk := block.NewSieveBlock("ai-block", "ab-1", map[string]interface{}{
		"id": "ab-1", "ref": "doc", "type": "ASK", "question": "plain question?",
	})
	_, _, question := p.buildPrompt(&blk, block.DocView{})

	if strings.Contains(question, "ATTACHED") {
		t.Fatalf("an attachment-less turn grew a section:\n%s", question)
	}
	if question != (block.AIContext{NodeIDs: []string{"ab-1"}, Content: "QUESTION ABOUT: doc\nplain question?"}).String() {
		t.Fatalf("the attachment-less prompt changed shape:\n%q", question)
	}
}
