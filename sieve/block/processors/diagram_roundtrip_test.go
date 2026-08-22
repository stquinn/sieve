package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

// hostileDiagramSource carries every shape that has historically broken diagram
// persistence at once: leading indentation (the 4-space literal-block indent has
// to survive as CONTENT, not be re-consumed as YAML structure), an inner ``` fence
// inside a node label (a naive emitter closes the outer fence on it), blank lines
// (a block scalar must keep them), and a trailing blank line.
const hostileDiagramSource = "flowchart TD\n" +
	"  subgraph A[Group A]\n" +
	"    a1[Alpha]\n" +
	"  end\n" +
	"\n" +
	"  subgraph B[Group B]\n" +
	"    b1[Beta]\n" +
	"  end\n" +
	"  a1 -- \"cross link\" --> b1\n" +
	"  a1 -->|Yes| b1\n" +
	"  note[\"```fenced```\"]\n" +
	"\n"

// serializeDiagram builds a one-diagram document and returns its on-disk form.
func serializeDiagram(t *testing.T, source string) string {
	t.Helper()
	blocks := []block.SieveBlock{{
		ID:   "019ff758-7aaf-79b1-a2e3-4221af4bb71a",
		Kind: "diagram",
		Attrs: map[string]interface{}{
			"id":          "019ff758-7aaf-79b1-a2e3-4221af4bb71a",
			"diagramType": "mermaid",
			"mode":        "edit",
			"status":      block.BlockStatusComplete,
			"source":      source,
		},
	}}
	md, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(blocks)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	return md
}

// reserializeDiagram runs one full parse -> serialize round trip over a document,
// returning the re-emitted document and the diagram's source attr as parsed.
func reserializeDiagram(t *testing.T, md string) (string, string) {
	t.Helper()
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	blocks, err := codec.Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var source string
	var found bool
	for _, b := range blocks {
		if b.Kind == "diagram" {
			source, _ = b.Attrs["source"].(string)
			found = true
		}
	}
	if !found {
		t.Fatalf("no diagram block survived the parse:\n%s", md)
	}
	out, err := codec.Serialize(blocks)
	if err != nil {
		t.Fatalf("reserialize: %v", err)
	}
	return out, source
}

// registerDiagram installs the diagram flavour over the production baseline.
func registerDiagram(t *testing.T) {
	t.Helper()
	resetRegistry()
	block.RegisterProcessor(NewDiagramProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)
}

// Two full round trips, byte-for-byte — TWO because the #52 corruption was
// CUMULATIVE (each save grew every line's indent by the running total of the
// indents above it). A single round trip cannot distinguish "stable" from
// "growing by a constant"; a second one makes any accumulation visible.
func TestDiagram_RoundTripIsByteStable_HostileSource(t *testing.T) {
	registerDiagram(t)

	md1 := serializeDiagram(t, hostileDiagramSource)
	md2, source2 := reserializeDiagram(t, md1)
	if md1 != md2 {
		t.Fatalf("first round trip changed the document:\n--- md1 ---\n%s\n--- md2 ---\n%s", md1, md2)
	}
	md3, source3 := reserializeDiagram(t, md2)
	if md2 != md3 {
		t.Fatalf("second round trip changed the document:\n--- md2 ---\n%s\n--- md3 ---\n%s", md2, md3)
	}

	// The document being a fixpoint would still permit a source that was mangled
	// identically every time, so assert the payload itself against the original.
	for i, got := range []string{source2, source3} {
		if got != hostileDiagramSource {
			t.Errorf("round trip %d mutated the diagram source:\n--- want ---\n%q\n--- got ---\n%q",
				i+1, hostileDiagramSource, got)
		}
	}
}

// The inner ``` must stay inside the block scalar rather than terminating the
// enclosing sieve fence — otherwise the diagram is torn in half and the tail
// re-parses as prose.
func TestDiagram_RoundTripKeepsInnerFenceInsideTheBlock(t *testing.T) {
	registerDiagram(t)

	md := serializeDiagram(t, hostileDiagramSource)
	blocks, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(blocks) != 1 {
		kinds := make([]string, len(blocks))
		for i, b := range blocks {
			kinds[i] = b.Kind
		}
		t.Fatalf("inner fence split the document into %d blocks (%s):\n%s",
			len(blocks), strings.Join(kinds, ", "), md)
	}
}

// The exact #52 signature, asserted directly: every character doubled
// ("flowchart TD" -> "ffl loowwcchhaarrtt  TTDD") and a per-line indent that
// accumulates the running total of the indents above it. Both were produced by a
// frontend echo loop, but this pins the persistence layer as the place they can
// never originate or be amplified.
func TestDiagram_RoundTripNeitherDoublesCharsNorCascadesIndent(t *testing.T) {
	registerDiagram(t)

	md := serializeDiagram(t, hostileDiagramSource)
	for range 3 {
		var source string
		md, source = reserializeDiagram(t, md)

		wantLines := strings.Split(hostileDiagramSource, "\n")
		gotLines := strings.Split(source, "\n")
		if len(gotLines) != len(wantLines) {
			t.Fatalf("line count drifted: want %d, got %d", len(wantLines), len(gotLines))
		}
		for i := range wantLines {
			if indentOf(gotLines[i]) != indentOf(wantLines[i]) {
				t.Errorf("line %d indent cascaded: want %d spaces, got %d (%q)",
					i, indentOf(wantLines[i]), indentOf(gotLines[i]), gotLines[i])
			}
			if len(gotLines[i]) != len(wantLines[i]) {
				t.Errorf("line %d length drifted (character doubling): want %d, got %d (%q)",
					i, len(wantLines[i]), len(gotLines[i]), gotLines[i])
			}
		}
	}
}

func indentOf(line string) int {
	return len(line) - len(strings.TrimLeft(line, " "))
}
