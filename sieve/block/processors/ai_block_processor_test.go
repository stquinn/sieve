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
	if p.JobLabel(&block.SieveBlock{Attrs: map[string]interface{}{"type": "ASK"}}) == "" {
		t.Error("expected non-empty label for ASK")
	}
	if p.JobLabel(&block.SieveBlock{Attrs: map[string]interface{}{"type": "EXPLAIN"}}) == "" {
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
	if !strings.Contains(ctx, "What is Go?") || !strings.Contains(ctx, "A compiled language.") {
		t.Errorf("unexpected context: %q", ctx)
	}
}
