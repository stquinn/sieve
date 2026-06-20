package block

import "testing"

func TestFencedDeserializer_Shape(t *testing.T) {
	s := FencedDeserializer{Kind: "diagram"}.Shape()
	if s.Kind != "diagram" || s.Head != "```diagram" || s.Tail != "```" {
		t.Fatalf("fenced shape: got %+v", s)
	}
	if s.IsZero() {
		t.Fatal("fenced shape must not be zero")
	}
}

func TestInlineDeserializer_Shape_isZero(t *testing.T) {
	if !(InlineDeserializer{}).Shape().IsZero() {
		t.Fatal("inline must declare no shape")
	}
}
