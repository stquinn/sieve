package sieve

import (
	"strings"
	"testing"
)

// (a) A column-row with a single column holding one prose child round-trips:
// the prose survives verbatim and is the only child of the only column.
func TestColumnRow_ProseOnly(t *testing.T) {
	cr := ColumnRow{
		ID: "cr1",
		Columns: []Column{
			{Children: []Child{{Prose: "Every request carries a **bearer token**."}}},
		},
	}

	body, err := SerializeColumnRow(cr)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	got, err := ParseColumnRow(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	if got.ID != "cr1" {
		t.Errorf("id: got %q want %q", got.ID, "cr1")
	}
	if len(got.Columns) != 1 || len(got.Columns[0].Children) != 1 {
		t.Fatalf("structure: got %d columns, child counts vary: %+v", len(got.Columns), got.Columns)
	}
	child := got.Columns[0].Children[0]
	if child.Block != nil {
		t.Fatalf("expected prose child, got block %+v", child.Block)
	}
	if child.Prose != "Every request carries a **bearer token**." {
		t.Errorf("prose: got %q", child.Prose)
	}
}

// A string child must serialize as a YAML string scalar, never a single-key map.
func TestColumnRow_ProseIsScalarNotMap(t *testing.T) {
	cr := ColumnRow{
		ID:      "cr1",
		Columns: []Column{{Children: []Child{{Prose: "hello"}}}},
	}
	body, err := SerializeColumnRow(cr)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if !strings.Contains(body, "- hello") {
		t.Errorf("expected prose emitted as a scalar list item, got:\n%s", body)
	}
}

// (b) A column-row with prose in one column and a diagram block in another:
// the block child lifts to a single-key map (kind → attrs) and lowers back.
func TestColumnRow_ProseAndDiagramChild(t *testing.T) {
	cr := ColumnRow{
		ID: "cr1",
		Columns: []Column{
			{Children: []Child{{Prose: "The gateway checks the cache."}}},
			{Children: []Child{{Block: &SieveBlock{
				ID:   "d1",
				Kind: "diagram",
				Attrs: map[string]interface{}{
					"id":     "d1",
					"source": "Client --> Gateway --> Auth",
				},
			}}}},
		},
	}

	body, err := SerializeColumnRow(cr)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	// Shape-1 lift: the kind is the map key.
	if !strings.Contains(body, "diagram:") {
		t.Errorf("expected kind lifted to map key 'diagram:', got:\n%s", body)
	}

	got, err := ParseColumnRow(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got.Columns) != 2 {
		t.Fatalf("columns: got %d want 2", len(got.Columns))
	}
	blk := got.Columns[1].Children[0].Block
	if blk == nil {
		t.Fatalf("expected block child in column 2, got %+v", got.Columns[1].Children[0])
	}
	if blk.Kind != "diagram" || blk.ID != "d1" {
		t.Errorf("block lower: got kind=%q id=%q", blk.Kind, blk.ID)
	}
	if blk.Attrs["source"] != "Client --> Gateway --> Auth" {
		t.Errorf("block attrs: got %v", blk.Attrs["source"])
	}
}

// (c) widths round-trip as a ratio array.
func TestColumnRow_WidthsRoundTrip(t *testing.T) {
	cr := ColumnRow{
		ID:     "cr1",
		Widths: []float64{0.55, 0.45},
		Columns: []Column{
			{Children: []Child{{Prose: "left"}}},
			{Children: []Child{{Prose: "right"}}},
		},
	}
	body, err := SerializeColumnRow(cr)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	got, err := ParseColumnRow(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got.Widths) != 2 || got.Widths[0] != 0.55 || got.Widths[1] != 0.45 {
		t.Errorf("widths: got %v want [0.55 0.45]", got.Widths)
	}
}

// Multiline prose must serialize as a literal block scalar (|), 4-space indented,
// never a double-quoted "\n" string (inner-fence safety).
func TestColumnRow_MultilineProseLiteralStyle(t *testing.T) {
	prose := "Every request carries a **bearer token**.\nThe gateway checks the cache, then the auth service."
	cr := ColumnRow{
		ID:      "cr1",
		Columns: []Column{{Children: []Child{{Prose: prose}}}},
	}
	body, err := SerializeColumnRow(cr)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if strings.Contains(body, "\\n") {
		t.Errorf("multiline prose must not be a double-quoted \\n string, got:\n%s", body)
	}
	if !strings.Contains(body, "|") {
		t.Errorf("expected literal block scalar (|), got:\n%s", body)
	}
	got, err := ParseColumnRow(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got.Columns[0].Children[0].Prose != prose {
		t.Errorf("multiline prose round-trip:\n got %q\nwant %q", got.Columns[0].Children[0].Prose, prose)
	}
}

// THE SPIKE (spec §7): confirm forceLiteralStyle's recursion composes under
// nesting. A child block carries a deeply-nested multiline scalar; it must still
// emit as a literal block scalar (no \n escaping), and the whole structure must
// round-trip stably (Serialize → Parse → Serialize is idempotent).
func TestColumnRow_NestedScalarComposesUnderNesting(t *testing.T) {
	mermaid := "graph TD\n  Client --> Gateway\n  Gateway --> Auth"
	cr := ColumnRow{
		ID: "cr1",
		Columns: []Column{
			{Children: []Child{{Block: &SieveBlock{
				ID:   "d1",
				Kind: "diagram",
				Attrs: map[string]interface{}{
					"id":     "d1",
					"source": mermaid, // level-2 multiline scalar (block attr)
					"config": map[string]interface{}{
						"script": "step1\nstep2\nstep3", // level-3 multiline scalar (nested map)
					},
				},
			}}}},
		},
	}

	body, err := SerializeColumnRow(cr)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	// Raw-output assertion: no double-quoted \n anywhere — every multiline
	// scalar, however deep, must be literal-styled.
	if strings.Contains(body, "\\n") {
		t.Errorf("deep multiline scalar escaped to \\n instead of literal style:\n%s", body)
	}
	// The deep scalar content must be indented ≥ 4 spaces so it can never sit
	// at columns 0–3 and prematurely close the outer ``` fence (CommonMark only
	// allows a closing fence with 0–3 leading spaces). Content may carry its own
	// internal indentation on top of the structural indent, so the invariant is
	// "≥ 4", not "exactly a multiple of 4".
	for _, line := range strings.Split(body, "\n") {
		if strings.Contains(line, "Gateway --> Auth") || strings.Contains(line, "step3") {
			indent := len(line) - len(strings.TrimLeft(line, " "))
			if indent < 4 {
				t.Errorf("deep scalar line not fence-safe (indent=%d < 4): %q", indent, line)
			}
		}
	}

	// Round-trip stability: re-serializing the parsed form is byte-identical.
	parsed, err := ParseColumnRow(body)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	body2, err := SerializeColumnRow(parsed)
	if err != nil {
		t.Fatalf("re-serialize: %v", err)
	}
	if body != body2 {
		t.Errorf("round-trip not byte-stable:\n--- first ---\n%s\n--- second ---\n%s", body, body2)
	}
}
