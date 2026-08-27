package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

// The envelope a new ai-block is born with: the id it was given, PENDING, a
// creation stamp, and the answer fields the turn will fill.
func TestAIBlockInitAttrs(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-ab12", map[string]interface{}{"id": "not-this-one", "type": "EXPLAIN"})
	if attrs["id"] != "ai-ab12" {
		t.Errorf("expected id=ai-ab12, got %v", attrs["id"])
	}
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
	if attrs["type"] != "EXPLAIN" {
		t.Errorf("expected the override to win, got type=%v", attrs["type"])
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("expected createdAt to be set")
	}
}

// The composer composes the question; creation seeds NONE of it. Neither the
// legacy target token nor an empty question text is invented, so a block minted
// with no question is the detached class rather than a question about nothing in
// particular.
func TestAIBlockInitAttrs_SeedsNoQuestion(t *testing.T) {
	attrs := (&AIBlockProcessor{}).InitAttrs("ai-ab12", nil)
	for _, key := range []string{"ref", block.QuestionAttr, block.AttachmentsAttr} {
		if v, seeded := attrs[key]; seeded {
			t.Errorf("creation seeded %q = %v", key, v)
		}
	}
}

// The question the composer minted rides through creation as it was composed:
// the list is the payload, and nothing here re-reads or rewrites it.
func TestAIBlockInitAttrs_CarriesTheComposedQuestion(t *testing.T) {
	minted := block.Elements{foldTarget(foldLeafID), foldProse("why?")}
	attrs := (&AIBlockProcessor{}).InitAttrs("ai-ab12", map[string]interface{}{block.QuestionAttr: minted})

	els := block.SieveBlock{Attrs: attrs}.Elements(block.QuestionAttr)
	if len(els) != 2 || els[0].Kind != block.KindReference || els[1].Kind != block.KindProse {
		t.Fatalf("question = %+v, want the minted list", els)
	}
	if els[0].StringAttr("rel") != block.RelTarget || els[0].StringAttr("uri") != foldSelfLeaf {
		t.Errorf("target element = %+v", els[0].Attrs)
	}
	if els[1].StringAttr("content") != "why?" {
		t.Errorf("prose element = %+v", els[1].Attrs)
	}
}

func TestAIBlockMode(t *testing.T) {
	if (&AIBlockProcessor{}).Mode() != block.BlockModeBlock {
		t.Error("expected BlockModeBlock")
	}
}

func TestAIBlockJobLabel(t *testing.T) {
	p := &AIBlockProcessor{}
	ask := p.DescribeJob(block.JobContext{Block: &block.SieveBlock{ID: "ai-ask", Attrs: map[string]interface{}{"type": "ASK"}}})
	if ask.Label == "" {
		t.Error("expected non-empty label for ASK")
	}
	if ask.Category != block.CategoryAI {
		t.Errorf("expected CategoryAI, got %q", ask.Category)
	}
	explain := p.DescribeJob(block.JobContext{Block: &block.SieveBlock{ID: "ai-exp", Attrs: map[string]interface{}{"type": "EXPLAIN"}}})
	if explain.Label == "" {
		t.Error("expected non-empty label for EXPLAIN")
	}
}

func TestAIBlockBuildContext(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	blk := block.NewSieveBlock("ai-block", "ai-ab12", map[string]interface{}{"response": "A compiled language."})
	blk.SetElements(block.QuestionAttr, block.Elements{foldProse("What is Go?")})

	ctx := p.BuildContext(blk, block.DocView{UUID: foldDocUUID}, map[string]bool{})
	if !strings.Contains(ctx.String(), "What is Go?") || !strings.Contains(ctx.String(), "A compiled language.") {
		t.Errorf("unexpected context: %q", ctx)
	}
}

// The ACTION (the block being asked) must NEVER carry its OWN prior answer: on a
// retry / re-run the block already has a `response` in the doc snapshot, and if it
// leaks into the prompt's ACTION it biases the new answer. qaHeader is the ACTION
// assembly — it renders QUESTION ABOUT + the question but drops **ANSWER:**.
// Contrast: BuildContext (used by THREAD / ref-chain / target callers) STILL appends
// the answer — the conversation history must keep prior answers.
func TestAIBlock_qaHeader_ASK_omitsOwnAnswer(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	doc := block.DocView{UUID: foldDocUUID}
	blk := block.NewSieveBlock("ai-block", "ai-retry", map[string]interface{}{
		"response": "STALE-PRIOR-ANSWER-a-compiled-language",
		"type":     "ASK",
	})
	blk.SetElements(block.QuestionAttr, block.Elements{foldTarget(foldLeafID), foldProse("What is Go?")})

	header := p.qaHeader(blk, doc)
	if !strings.Contains(header, "QUESTION ABOUT: "+foldLeafID) {
		t.Errorf("qaHeader lost the QUESTION ABOUT ref header; got %q", header)
	}
	if !strings.Contains(header, "What is Go?") {
		t.Errorf("qaHeader lost the question; got %q", header)
	}
	if strings.Contains(header, "STALE-PRIOR-ANSWER-a-compiled-language") {
		t.Errorf("ACTION leaked its own prior answer; got %q", header)
	}
	if strings.Contains(header, "**ANSWER:**") {
		t.Errorf("ACTION carried an **ANSWER:** marker; got %q", header)
	}
	// BuildContext (THREAD/ref-chain path) MUST still include the answer — unchanged.
	full := p.BuildContext(blk, doc, map[string]bool{}).String()
	if !strings.Contains(full, "STALE-PRIOR-ANSWER-a-compiled-language") || !strings.Contains(full, "**ANSWER:**") {
		t.Errorf("BuildContext (THREAD path) must still carry the answer; got %q", full)
	}
}

func TestAIBlock_qaHeader_EXPLAIN_omitsOwnAnswer(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	doc := block.DocView{UUID: foldDocUUID}
	blk := block.NewSieveBlock("ai-block", "ai-exp", map[string]interface{}{
		"response": "STALE-EXPLANATION-do-not-reuse",
		"type":     "EXPLAIN",
	})
	blk.SetElements(block.QuestionAttr, block.Elements{foldTarget(foldLeafID)})

	header := p.qaHeader(blk, doc)
	if !strings.Contains(header, "EXPLAIN NODE: "+foldLeafID) {
		t.Errorf("qaHeader lost the EXPLAIN NODE ref header; got %q", header)
	}
	if strings.Contains(header, "STALE-EXPLANATION-do-not-reuse") || strings.Contains(header, "**ANSWER:**") {
		t.Errorf("EXPLAIN ACTION leaked its own prior answer; got %q", header)
	}
	full := p.BuildContext(blk, doc, map[string]bool{}).String()
	if !strings.Contains(full, "STALE-EXPLANATION-do-not-reuse") || !strings.Contains(full, "**ANSWER:**") {
		t.Errorf("BuildContext (THREAD path) must still carry the EXPLAIN answer; got %q", full)
	}
}

// The ACTION context assembled in DescribeJob (questionCtx, captured by Work) must
// exclude the block's own answer. We prove it via the seam DescribeJob uses: the
// ACTION is qaHeader wrapped in an AIContext with the block's own NODE ID header.
func TestAIBlock_actionContext_hasNodeIdHeaderButNoOwnAnswer(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	blk := block.NewSieveBlock("ai-block", "ai-act", map[string]interface{}{
		"response": "STALE-ACTION-ANSWER",
		"type":     "ASK",
	})
	blk.SetElements(block.QuestionAttr, block.Elements{foldTarget(foldLeafID), foldProse("Follow up?")})

	actionCtx := block.AIContext{NodeIDs: []string{blk.ID},
		Content: p.qaHeader(blk, block.DocView{UUID: foldDocUUID})}.String()
	if !strings.Contains(actionCtx, "NODE ID: ai-act") {
		t.Errorf("ACTION lost its NODE ID header; got %q", actionCtx)
	}
	if !strings.Contains(actionCtx, "Follow up?") {
		t.Errorf("ACTION lost the question; got %q", actionCtx)
	}
	if strings.Contains(actionCtx, "STALE-ACTION-ANSWER") || strings.Contains(actionCtx, "**ANSWER:**") {
		t.Errorf("ACTION leaked its own answer; got %q", actionCtx)
	}
}
