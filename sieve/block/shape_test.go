package block

import "testing"

func TestFencedDeserializer_Shapes_noAliases(t *testing.T) {
	shapes := FencedDeserializer{Kind: "diagram"}.Shapes()
	if len(shapes) != 1 {
		t.Fatalf("no aliases: want 1 shape, got %d: %+v", len(shapes), shapes)
	}
	s := shapes[0]
	if s.Kind != "diagram" || s.Head != "```diagram" || s.Tail != "```" {
		t.Fatalf("fenced shape: got %+v", s)
	}
	if s.IsZero() {
		t.Fatal("fenced shape must not be zero")
	}
}

// A kind-less (partially built) deserializer must not present a catch-all shape.
func TestFencedDeserializer_Shapes_kindlessIsEmpty(t *testing.T) {
	if shapes := (FencedDeserializer{}).Shapes(); len(shapes) != 0 {
		t.Fatalf("a kind-less deserializer must declare no shapes, got %+v", shapes)
	}
}

// The canonical head comes first, then aliases in declaration order — the order
// callers rely on when they only want "my own form" (Shapes()[0]).
func TestFencedDeserializer_Shapes_canonicalFirstThenAliasesInOrder(t *testing.T) {
	shapes := FencedDeserializer{Kind: "reference", Aliases: []string{"attachment", "link"}}.Shapes()
	if len(shapes) != 3 {
		t.Fatalf("want 3 shapes (canonical + 2 aliases), got %d: %+v", len(shapes), shapes)
	}
	want := []struct{ kind, head string }{
		{"reference", "```reference"},
		{"attachment", "```attachment"},
		{"link", "```link"},
	}
	for i, w := range want {
		if shapes[i].Kind != w.kind || shapes[i].Head != w.head || shapes[i].Tail != "```" {
			t.Errorf("shapes[%d] = %+v, want Kind=%q Head=%q", i, shapes[i], w.kind, w.head)
		}
	}
}

// Accepts must claim a region tagged with an alias, exactly as it claims one
// tagged with the canonical kind.
func TestFencedDeserializer_Accepts_matchesAliasKind(t *testing.T) {
	d := FencedDeserializer{Kind: "reference", Aliases: []string{"attachment"}}
	if !d.Accepts(Region{Kind: "reference"}) {
		t.Error("must accept its own canonical kind")
	}
	if !d.Accepts(Region{Kind: "attachment"}) {
		t.Error("must accept a declared alias")
	}
	if d.Accepts(Region{Kind: "card"}) {
		t.Error("must not accept an undeclared kind")
	}
	if d.Accepts(Region{Kind: ""}) {
		t.Error("must not accept a kind-less region")
	}
}

// Pinned property: a processor with NO aliases behaves EXACTLY as before —
// Accepts only its own kind, nothing else.
func TestFencedDeserializer_Accepts_noAliasesUnchanged(t *testing.T) {
	d := FencedDeserializer{Kind: "diagram"}
	if !d.Accepts(Region{Kind: "diagram"}) {
		t.Error("must accept its own kind")
	}
	if d.Accepts(Region{Kind: "code"}) {
		t.Error("must not accept an unrelated kind")
	}
}

// Deserialize CANONICALISES: whichever head matched (canonical or alias), the
// resulting block's Kind is always the flavour's own Kind.
func TestFencedDeserializer_Deserialize_aliasFenceCanonicalises(t *testing.T) {
	d := FencedDeserializer{Kind: "reference", Aliases: []string{"attachment"}}
	region := Region{Kind: "attachment", Raw: "```attachment\nid: r-1\nuri: sieve://x\n```\n"}
	blocks, err := d.Deserialize(region)
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d", len(blocks))
	}
	if blocks[0].Kind != "reference" {
		t.Errorf("aliased fence must deserialise to the CANONICAL kind, got %q", blocks[0].Kind)
	}
	if blocks[0].ID != "r-1" {
		t.Errorf("id must round-trip: got %q", blocks[0].ID)
	}
}

// Pinned property: a processor with NO aliases deserialises to its own kind
// exactly as before.
func TestFencedDeserializer_Deserialize_noAliasesUnchanged(t *testing.T) {
	d := FencedDeserializer{Kind: "diagram"}
	region := Region{Kind: "diagram", Raw: "```diagram\nid: d-1\nsource: x\n```\n"}
	blocks, err := d.Deserialize(region)
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	if len(blocks) != 1 || blocks[0].Kind != "diagram" {
		t.Fatalf("want 1 diagram block, got %+v", blocks)
	}
}
