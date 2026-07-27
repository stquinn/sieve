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

// A kind-less (partially built) deserializer must not present a catch-all shape.
func TestFencedDeserializer_Shape_kindlessIsZero(t *testing.T) {
	if !(FencedDeserializer{}).Shape().IsZero() {
		t.Fatal("a kind-less deserializer must declare no shape")
	}
}
