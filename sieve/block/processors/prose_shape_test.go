package processors

import "testing"

func TestProseProcessor_Shape(t *testing.T) {
	s := (&ProseProcessor{}).Shape()
	if s.Kind != "prose" || s.Head != "<!--s:" || s.Tail != "<!--/s:" {
		t.Fatalf("prose shape: got %+v", s)
	}
}
