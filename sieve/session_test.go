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

func TestParseSession_ShowLineNumbers(t *testing.T) {
	// Defaults on, both for a fresh session and one predating the field.
	if !ParseSession(nil).ShowLineNumbers {
		t.Fatal("expected ShowLineNumbers=true by default")
	}
	legacy := ParseSession([]byte(`{"activeIdx": 0, "showSidebar": true}`))
	if !legacy.ShowLineNumbers {
		t.Fatal("expected ShowLineNumbers=true for a session without the field")
	}
	// An explicit false survives a round-trip (no omitempty).
	off := ParseSession([]byte(`{"showLineNumbers": false}`))
	if off.ShowLineNumbers {
		t.Fatal("expected ShowLineNumbers=false when explicitly set")
	}
}
