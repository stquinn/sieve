package domain

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

func TestTab_ScrollRoundTrip(t *testing.T) {
	// A saved scroll offset survives Marshal → ParseSession (store/{hostname}/
	// session.json persistence — issue #51).
	s := Session{Tabs: []Tab{{ID: "doc-1", Scroll: 842}}}
	data, err := s.Marshal()
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	round := ParseSession(data)
	if len(round.Tabs) != 1 || round.Tabs[0].Scroll != 842 {
		t.Fatalf("expected Scroll=842 to round-trip, got %+v", round.Tabs)
	}

	// A session.json predating the field (no "scroll" key) yields 0 — backwards
	// compatible, and indistinguishable from "never scrolled" by design.
	legacy := ParseSession([]byte(`{"activeIdx": 0, "tabs": [{"id": "doc-2"}]}`))
	if len(legacy.Tabs) != 1 || legacy.Tabs[0].Scroll != 0 {
		t.Fatalf("expected Scroll=0 for a tab without the field, got %+v", legacy.Tabs)
	}
}

func TestParseSession_AskPanelHeight(t *testing.T) {
	// Defaults to 220 for a fresh session and one predating the field.
	if h := ParseSession(nil).AskPanelHeight; h != 220 {
		t.Fatalf("expected default AskPanelHeight=220, got %d", h)
	}
	legacy := ParseSession([]byte(`{"activeIdx": 0, "showSidebar": true}`))
	if legacy.AskPanelHeight != 220 {
		t.Fatalf("expected AskPanelHeight=220 for a session without the field, got %d", legacy.AskPanelHeight)
	}
	// A non-zero stored value is preserved.
	set := ParseSession([]byte(`{"askPanelHeight": 360}`))
	if set.AskPanelHeight != 360 {
		t.Fatalf("expected AskPanelHeight=360, got %d", set.AskPanelHeight)
	}
}
