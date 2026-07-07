package fencedblock

import (
	"strings"
	"testing"
)

// These test ONLY what fencedblock owns: SerializeYaml's OUTPUT PROPERTIES (field
// presence, literal block style, 4-space indent, no escaping). They deliberately
// do NOT parse the result — any parser here would be DUPLICATE parse code that
// could never catch a defect in the real document parser. The serialize↔parse
// ROUND-TRIP is tested in the sieve package against the REAL production parser
// (DocumentCodec.Deserialize) — the only place a parse regression actually fails.

type testBlock struct {
	ID       string `yaml:"id"`
	Status   string `yaml:"status,omitempty"`
	Question string `yaml:"question,omitempty"`
	Response string `yaml:"response,omitempty"`
}

func TestSerialize_SimpleFields(t *testing.T) {
	b := testBlock{ID: "x1", Status: "PENDING", Question: "What?"}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "id: x1") || !strings.Contains(s, "status: PENDING") || !strings.Contains(s, "question: What?") {
		t.Errorf("missing fields:\n%s", s)
	}
}

func TestSerialize_MultilineUsesIndentedBlockScalar(t *testing.T) {
	b := testBlock{ID: "m1", Response: "Line 1\nLine 2\n---\nLine 3"}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "response: |") {
		t.Errorf("expected a literal block scalar, got:\n%s", s)
	}
	// 4-space indent ensures block-scalar content can never trigger a closing fence.
	if !strings.Contains(s, "    Line 1") {
		t.Errorf("expected 4-space indent, got:\n%s", s)
	}
}

// TestRoundTrip_PreservesQuestionWhitespace pins the ai-block whitespace fix
// (bug 4): the question's whitespace must survive storage losslessly. Both halves
// of the SerDes pair (SerializeYaml + DeserializeYaml) are owned HERE, so their
// round-trip is this package's own contract to test — it is NOT the document
// parser (that round-trip lives in the sieve package). Any residual whitespace
// loss the user sees is presentation-only (markdown-it collapse at render),
// never storage; this guards that boundary.
func TestRoundTrip_PreservesQuestionWhitespace(t *testing.T) {
	cases := map[string]string{
		"multi-space run":           "hello    world",
		"internal newlines":         "line1\nline2\nline3",
		"leading spaces":            "    indented start",
		"trailing spaces":           "trailing spaces   ",
		"indented middle line":      "a\n        indented middle\nb",
		"tab":                       "tab\there",
		"trailing spaces mid-block": "line with trailing   \nnext",
		"consecutive blank lines":   "multi\n\n\nblank lines",
		"code fence in question":    "```go\nfunc main() {}\n```",
	}
	for name, q := range cases {
		t.Run(name, func(t *testing.T) {
			attrs := map[string]interface{}{"id": "ai-x", "question": q}
			body, err := SerializeYaml(attrs)
			if err != nil {
				t.Fatalf("serialize: %v", err)
			}
			got, err := DeserializeYaml(body)
			if err != nil {
				t.Fatalf("deserialize: %v", err)
			}
			back, _ := got["question"].(string)
			if back != q {
				t.Errorf("whitespace lost in storage round-trip\n in=%q\nout=%q\nyaml:\n%s", q, back, body)
			}
		})
	}
}

func TestSerialize_CodeFenceForcesLiteralStyle(t *testing.T) {
	// yaml.v3 defaults to double-quoted style for strings starting with backticks;
	// SerializeYaml must force literal block style — human-readable, unescaped.
	b := testBlock{ID: "ai-1", Status: "COMPLETE", Response: "```go\npackage main\n\nfunc main() {}\n```"}
	s, err := SerializeYaml(b)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, `\"`) || strings.Contains(s, `\n`) {
		t.Errorf("response should be a block scalar, not escaped:\n%s", s)
	}
	if !strings.Contains(s, "response: |") {
		t.Errorf("expected literal block indicator 'response: |', got:\n%s", s)
	}
	if !strings.Contains(s, "    ```go") {
		t.Errorf("expected the code fence inside a 4-space-indented block scalar, got:\n%s", s)
	}
}
