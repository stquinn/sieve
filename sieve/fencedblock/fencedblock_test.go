package fencedblock

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// parseAll is TEST-ONLY scaffolding — production never parses fenced YAML this way
// (the document parser is scanBlocks/goldmark; serialization is a BlockProcessor
// concern). It lives in this _test.go file so it is compiled ONLY for tests: the
// round-trip checks below need an inverse for SerializeYaml, but that inverse must
// not masquerade as a production API in fencedblock.go.
func parseAll[T any](body, tag string) []T {
	fence := "```" + tag
	lines := strings.Split(body, "\n")
	var out []T
	i := 0
	for i < len(lines) {
		if lines[i] == fence {
			j := i + 1
			for j < len(lines) && lines[j] != "```" {
				j++
			}
			if j < len(lines) {
				content := strings.Join(lines[i+1:j], "\n")
				var meta struct {
					ID string `yaml:"id"`
				}
				if yaml.Unmarshal([]byte(content), &meta) == nil && meta.ID != "" {
					var v T
					if yaml.Unmarshal([]byte(content), &v) == nil {
						out = append(out, v)
					}
				}
				i = j + 1
				continue
			}
		}
		i++
	}
	return out
}

type testBlock struct {
	ID       string `yaml:"id"`
	Status   string `yaml:"status,omitempty"`
	Question string `yaml:"question,omitempty"`
	Response string `yaml:"response,omitempty"`
}

func TestParseAll_Basic(t *testing.T) {
	body := "```test-block\nid: abc\nstatus: COMPLETE\nquestion: Q?\n```"
	blocks := parseAll[testBlock](body, "test-block")
	if len(blocks) != 1 {
		t.Fatalf("expected 1, got %d", len(blocks))
	}
	if blocks[0].ID != "abc" || blocks[0].Status != "COMPLETE" {
		t.Errorf("unexpected block: %+v", blocks[0])
	}
}

func TestParseAll_SkipsMissingID(t *testing.T) {
	body := "```test-block\nstatus: PENDING\n```"
	if len(parseAll[testBlock](body, "test-block")) != 0 {
		t.Error("block without id should be skipped")
	}
}

func TestParseAll_WrongTag(t *testing.T) {
	body := "```other-block\nid: x\nstatus: PENDING\n```"
	if len(parseAll[testBlock](body, "test-block")) != 0 {
		t.Error("different tag should not be matched")
	}
}

func TestParseAll_Multiple(t *testing.T) {
	body := "```test-block\nid: a\nstatus: PENDING\n```\ntext\n```test-block\nid: b\nstatus: COMPLETE\n```"
	blocks := parseAll[testBlock](body, "test-block")
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
	blocks := parseAll[testBlock]("```test-block\n"+s+"\n```", "test-block")
	if len(blocks) != 1 || blocks[0].Question != b.Question {
		t.Errorf("round-trip failed: got %q", blocks[0].Question)
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
	blocks := parseAll[testBlock]("```test-block\n"+s+"\n```", "test-block")
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
	blocks := parseAll[testBlock]("```test-block\n"+s+"\n```", "test-block")
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
