package fencedblock

import (
	"strings"
	"testing"
)

type testBlock struct {
	ID       string `yaml:"id"`
	Status   string `yaml:"status,omitempty"`
	Question string `yaml:"question,omitempty"`
	Response string `yaml:"response,omitempty"`
}

func TestParseAll_Basic(t *testing.T) {
	body := "```test-block\nid: abc\nstatus: COMPLETE\nquestion: Q?\n```"
	blocks := ParseAll[testBlock](body, "test-block")
	if len(blocks) != 1 {
		t.Fatalf("expected 1, got %d", len(blocks))
	}
	if blocks[0].ID != "abc" || blocks[0].Status != "COMPLETE" {
		t.Errorf("unexpected block: %+v", blocks[0])
	}
}

func TestParseAll_SkipsMissingID(t *testing.T) {
	body := "```test-block\nstatus: PENDING\n```"
	if len(ParseAll[testBlock](body, "test-block")) != 0 {
		t.Error("block without id should be skipped")
	}
}

func TestParseAll_WrongTag(t *testing.T) {
	body := "```other-block\nid: x\nstatus: PENDING\n```"
	if len(ParseAll[testBlock](body, "test-block")) != 0 {
		t.Error("different tag should not be matched")
	}
}

func TestParseAll_Multiple(t *testing.T) {
	body := "```test-block\nid: a\nstatus: PENDING\n```\ntext\n```test-block\nid: b\nstatus: COMPLETE\n```"
	blocks := ParseAll[testBlock](body, "test-block")
	if len(blocks) != 2 {
		t.Fatalf("expected 2, got %d", len(blocks))
	}
	if blocks[0].ID != "a" || blocks[1].ID != "b" {
		t.Errorf("unexpected ids: %q %q", blocks[0].ID, blocks[1].ID)
	}
}

func TestSerialize_SimpleFields(t *testing.T) {
	b := testBlock{ID: "x1", Status: "PENDING", Question: "What?"}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "id: x1") {
		t.Error("missing id")
	}
	if !strings.Contains(s, "status: PENDING") {
		t.Error("missing status")
	}
	if !strings.Contains(s, "question: What?") {
		t.Error("missing question")
	}
}

func TestSerialize_MultilineResponse(t *testing.T) {
	b := testBlock{ID: "m1", Response: "Line 1\nLine 2\n---\nLine 3"}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	// Block scalar content must be indented ≥ 4 spaces (Rule 3).
	if !strings.Contains(s, "    Line 1") {
		t.Errorf("expected 4-space indent in block scalar, got:\n%s", s)
	}
}

func TestSerialize_SpecialCharsQuoted(t *testing.T) {
	b := testBlock{ID: "q1", Question: "What is this: a test?"}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	// Round-trip must preserve the value regardless of quoting style.
	blocks := ParseAll[testBlock]("```test-block\n"+s+"\n```", "test-block")
	if len(blocks) != 1 || blocks[0].Question != b.Question {
		t.Errorf("round-trip failed: got %q", blocks[0].Question)
	}
}

func TestReplace_Basic(t *testing.T) {
	body := "before\n```test-block\nid: abc\nstatus: PENDING\n```\nafter"
	updated := testBlock{ID: "abc", Status: "COMPLETE", Response: "Done."}
	result, err := Replace(body, "test-block", "abc", updated)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "status: COMPLETE") {
		t.Error("missing COMPLETE status")
	}
	if !strings.Contains(result, "Done.") {
		t.Error("missing response")
	}
	if !strings.Contains(result, "before") || !strings.Contains(result, "after") {
		t.Error("surrounding content lost")
	}
}

func TestReplace_NotFound(t *testing.T) {
	body := "```test-block\nid: xyz\nstatus: PENDING\n```"
	_, err := Replace(body, "test-block", "notexist", testBlock{ID: "notexist"})
	if err == nil {
		t.Error("expected error for missing block")
	}
}

func TestInsertAfterRef_AppendWhenDocRef(t *testing.T) {
	body := "# Heading\n\nSome text."
	fence := "```test-block\nid: new1\nstatus: PENDING\n```"
	result := InsertAfterRef(body, "doc", fence)
	if !strings.HasSuffix(strings.TrimRight(result, "\n"), "```") {
		t.Error("fence should be at end of document")
	}
	if !strings.Contains(result, "# Heading") {
		t.Error("original content lost")
	}
}

func TestInsertAfterRef_AfterAnchor(t *testing.T) {
	body := "```test-block\nid: anchor1\nstatus: COMPLETE\n```\n\ntrailing text"
	fence := "```test-block\nid: new1\nstatus: PENDING\n```"
	result := InsertAfterRef(body, "anchor1", fence)

	anchorEnd := strings.Index(result, "id: anchor1")
	newBlockStart := strings.Index(result, "id: new1")
	if anchorEnd == -1 || newBlockStart == -1 {
		t.Fatal("could not locate both blocks in result")
	}
	if newBlockStart <= anchorEnd {
		t.Error("new block should appear after anchor block")
	}
	if !strings.Contains(result, "trailing text") {
		t.Error("trailing content lost")
	}
}

func TestInsertAfterRef_FallbackWhenAnchorMissing(t *testing.T) {
	body := "```test-block\nid: other\nstatus: COMPLETE\n```"
	fence := "```test-block\nid: new1\nstatus: PENDING\n```"
	result := InsertAfterRef(body, "nonexistent", fence)
	if !strings.Contains(result, "id: new1") {
		t.Error("fence should still be inserted on fallback")
	}
}

func TestSerialize_CodeFenceInResponse(t *testing.T) {
	// yaml.v3 defaults to double-quoted style for strings starting with backticks.
	// Serialize must force literal block style so the output is human-readable.
	b := testBlock{
		ID:       "ai-1",
		Status:   "COMPLETE",
		Response: "```go\npackage main\n\nfunc main() {}\n```",
	}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, `\"`) || strings.Contains(s, `\n`) {
		t.Errorf("response should be a block scalar, not escaped: %s", s)
	}
	if !strings.Contains(s, "response: |") {
		t.Errorf("expected literal block indicator 'response: |', got:\n%s", s)
	}
	// Round-trip must preserve the code fence content.
	blocks := ParseAll[testBlock]("```test-block\n"+s+"\n```", "test-block")
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block after round-trip, got %d", len(blocks))
	}
	if !strings.Contains(blocks[0].Response, "```go") {
		t.Errorf("code fence lost in round-trip: %q", blocks[0].Response)
	}
}

func TestRoundTrip(t *testing.T) {
	original := testBlock{
		ID:       "rt1",
		Status:   "COMPLETE",
		Question: "What is the strangler fig pattern?",
		Response: "A migration strategy.\n\n---\n\nNamed after the tree.",
	}
	s, err := SerializeYaml(original)
	if err != nil {
		t.Fatal(err)
	}
	blocks := ParseAll[testBlock]("```test-block\n"+s+"\n```", "test-block")
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	b := blocks[0]
	if b.ID != original.ID || b.Status != original.Status {
		t.Errorf("id/status mismatch: %+v", b)
	}
	if !strings.Contains(b.Response, "---") || !strings.Contains(b.Response, "tree") {
		t.Errorf("response not preserved: %q", b.Response)
	}
}
