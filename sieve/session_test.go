package sieve

import "testing"

func TestParseSession_ShowToolbar(t *testing.T) {
	data := []byte(`{"showToolbar": true, "activeIdx": 0}`)
	s := ParseSession(data)
	if !s.ShowToolbar {
		t.Fatal("expected ShowToolbar=true")
	}

	empty := ParseSession(nil)
	if empty.ShowToolbar {
		t.Fatal("expected ShowToolbar=false by default")
	}
}
