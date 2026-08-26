package processors

import "testing"

func TestProseProcessor_Shapes(t *testing.T) {
	shapes := (&ProseProcessor{}).Shapes()
	if len(shapes) != 1 {
		t.Fatalf("prose has no aliases: want 1 shape, got %d: %+v", len(shapes), shapes)
	}
	s := shapes[0]
	if s.Kind != "prose" || s.Head != "<!--s:" || s.Tail != "<!--/s:" {
		t.Fatalf("prose shape: got %+v", s)
	}
}
