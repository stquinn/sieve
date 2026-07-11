package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

func TestAIBlockInitAttrs(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-ab12", map[string]interface{}{
		"question": "What does this mean?",
		"ref":      "blk-1234",
		"type":     "ASK",
	})
	if attrs["id"] != "ai-ab12" {
		t.Errorf("expected id=ai-ab12, got %v", attrs["id"])
	}
	if attrs["status"] != block.BlockStatusPending {
		t.Errorf("expected status=PENDING, got %v", attrs["status"])
	}
	if attrs["ref"] != "blk-1234" {
		t.Errorf("expected ref=blk-1234, got %v", attrs["ref"])
	}
	if attrs["createdAt"] == "" || attrs["createdAt"] == nil {
		t.Error("expected createdAt to be set")
	}
}

func TestAIBlockInitAttrsDefaultRef(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-ab12", map[string]interface{}{"question": "Hello?"})
	if attrs["ref"] != "doc" {
		t.Errorf("expected default ref=doc, got %v", attrs["ref"])
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
	p := &AIBlockProcessor{}
	blk := block.SieveBlock{
		ID:   "ai-ab12",
		Kind: "ai-block",
		Attrs: map[string]interface{}{
			"question": "What is Go?",
			"response": "A compiled language.",
		},
	}
	ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{})
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
	p := &AIBlockProcessor{}
	blk := block.SieveBlock{
		ID:   "ai-retry",
		Kind: "ai-block",
		Attrs: map[string]interface{}{
			"ref":      "pr-1",
			"question": "What is Go?",
			"response": "STALE-PRIOR-ANSWER-a-compiled-language",
			"type":     "ASK",
		},
	}
	header := p.qaHeader(blk)
	if !strings.Contains(header, "QUESTION ABOUT: pr-1") {
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
	full := p.BuildContext(blk, block.DocView{}, map[string]bool{}).String()
	if !strings.Contains(full, "STALE-PRIOR-ANSWER-a-compiled-language") || !strings.Contains(full, "**ANSWER:**") {
		t.Errorf("BuildContext (THREAD path) must still carry the answer; got %q", full)
	}
}

func TestAIBlock_qaHeader_EXPLAIN_omitsOwnAnswer(t *testing.T) {
	p := &AIBlockProcessor{}
	blk := block.SieveBlock{
		ID:   "ai-exp",
		Kind: "ai-block",
		Attrs: map[string]interface{}{
			"ref":      "pr-9",
			"response": "STALE-EXPLANATION-do-not-reuse",
			"type":     "EXPLAIN",
		},
	}
	header := p.qaHeader(blk)
	if !strings.Contains(header, "EXPLAIN NODE: pr-9") {
		t.Errorf("qaHeader lost the EXPLAIN NODE ref header; got %q", header)
	}
	if strings.Contains(header, "STALE-EXPLANATION-do-not-reuse") || strings.Contains(header, "**ANSWER:**") {
		t.Errorf("EXPLAIN ACTION leaked its own prior answer; got %q", header)
	}
	full := p.BuildContext(blk, block.DocView{}, map[string]bool{}).String()
	if !strings.Contains(full, "STALE-EXPLANATION-do-not-reuse") || !strings.Contains(full, "**ANSWER:**") {
		t.Errorf("BuildContext (THREAD path) must still carry the EXPLAIN answer; got %q", full)
	}
}

// The ACTION context assembled in DescribeJob (questionCtx, captured by Work) must
// exclude the block's own answer. We prove it via the seam DescribeJob uses: the
// ACTION is qaHeader wrapped in an AIContext with the block's own NODE ID header.
func TestAIBlock_actionContext_hasNodeIdHeaderButNoOwnAnswer(t *testing.T) {
	p := &AIBlockProcessor{}
	blk := block.SieveBlock{
		ID:   "ai-act",
		Kind: "ai-block",
		Attrs: map[string]interface{}{
			"ref":      "pr-1",
			"question": "Follow up?",
			"response": "STALE-ACTION-ANSWER",
			"type":     "ASK",
		},
	}
	actionCtx := block.AIContext{NodeIDs: []string{blk.ID}, Content: p.qaHeader(blk)}.String()
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
