package aiblock

import (
	"strings"
	"testing"
)

func TestParseAll_Basic(t *testing.T) {
	body := "```ai-block\nid: abc123\nref: doc\nstatus: COMPLETE\nquestion: What is X?\nresponse: |\n  It is Y.\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	b := blocks[0]
	if b.ID != "abc123" {
		t.Errorf("id: got %q", b.ID)
	}
	if b.Ref != "doc" {
		t.Errorf("ref: got %q", b.Ref)
	}
	if b.Status != "COMPLETE" {
		t.Errorf("status: got %q", b.Status)
	}
	if b.Question != "What is X?" {
		t.Errorf("question: got %q", b.Question)
	}
	if !strings.Contains(b.Response, "It is Y.") {
		t.Errorf("response: got %q", b.Response)
	}
}

func TestParseAll_Empty(t *testing.T) {
	if len(ParseAll("")) != 0 {
		t.Error("expected empty result for empty body")
	}
}

func TestParseAll_NoBlocks(t *testing.T) {
	if len(ParseAll("# Heading\n\nSome text.\n\n```go\ncode here\n```\n")) != 0 {
		t.Error("expected no ai-blocks")
	}
}

func TestParseAll_MissingID(t *testing.T) {
	body := "```ai-block\nref: doc\nstatus: PENDING\n```"
	if len(ParseAll(body)) != 0 {
		t.Error("block with no id should be skipped")
	}
}

func TestParseAll_MultilineResponse(t *testing.T) {
	body := "```ai-block\nid: x1\nref: doc\nstatus: COMPLETE\nquestion: Q?\nresponse: |\n  Para 1.\n\n  ---\n\n  Para 2.\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if !strings.Contains(blocks[0].Response, "---") {
		t.Errorf("expected --- preserved in response, got %q", blocks[0].Response)
	}
}

func TestParseAll_MultilineQuestion(t *testing.T) {
	body := "```ai-block\nid: q1\nstatus: PENDING\nquestion: |\n  Line one\n  Line two\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1, got %d", len(blocks))
	}
	if !strings.Contains(blocks[0].Question, "Line one") || !strings.Contains(blocks[0].Question, "Line two") {
		t.Errorf("multiline question not preserved: %q", blocks[0].Question)
	}
}

func TestParseAll_MultipleBlocks(t *testing.T) {
	body := "text\n```ai-block\nid: a1\nstatus: PENDING\nquestion: First\n```\nmiddle\n```ai-block\nid: a2\nstatus: COMPLETE\nquestion: Second\nresponse: |\n  Answer\n```\nend"
	blocks := ParseAll(body)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	if blocks[0].ID != "a1" || blocks[1].ID != "a2" {
		t.Errorf("unexpected ids: %q %q", blocks[0].ID, blocks[1].ID)
	}
}

func TestReplace_Basic(t *testing.T) {
	body := "before\n```ai-block\nid: abc\nref: doc\nstatus: PENDING\nquestion: Q?\n```\nafter"
	updated := AiBlockData{
		ID:       "abc",
		Ref:      "doc",
		Status:   "COMPLETE",
		Model:    "test-model",
		Question: "Q?",
		Response: "The answer.",
	}
	result, err := Replace(body, updated)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "status: COMPLETE") {
		t.Error("missing COMPLETE status")
	}
	if !strings.Contains(result, "The answer.") {
		t.Error("missing response content")
	}
	if !strings.Contains(result, "before") || !strings.Contains(result, "after") {
		t.Error("surrounding content lost")
	}
}

func TestReplace_NotFound(t *testing.T) {
	body := "```ai-block\nid: xyz\nstatus: PENDING\nquestion: Q?\n```"
	_, err := Replace(body, AiBlockData{ID: "notexist"})
	if err == nil {
		t.Error("expected error for missing block")
	}
}

func TestRoundTrip(t *testing.T) {
	original := AiBlockData{
		ID:       "rt1",
		Ref:      "doc",
		Status:   "COMPLETE",
		Model:    "claude-sonnet-4-6",
		Question: "What is the strangler fig pattern?",
		Response: "It is a migration strategy.\n\n---\n\nNamed after the strangler fig tree.",
	}
	yaml := SerializeYAML(original)
	body := "```ai-block\n" + yaml + "\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	b := blocks[0]
	if b.ID != original.ID {
		t.Errorf("id mismatch: %q vs %q", b.ID, original.ID)
	}
	if !strings.Contains(b.Response, "---") {
		t.Errorf("--- not preserved in round-trip response: %q", b.Response)
	}
	if !strings.Contains(b.Response, "strangler fig tree") {
		t.Errorf("response content not preserved: %q", b.Response)
	}
}

func TestSerializeYAML_Defaults(t *testing.T) {
	d := AiBlockData{ID: "x1"}
	s := SerializeYAML(d)
	if !strings.Contains(s, "ref: doc") {
		t.Error("expected default ref: doc")
	}
	if !strings.Contains(s, "status: PENDING") {
		t.Error("expected default status: PENDING")
	}
}
