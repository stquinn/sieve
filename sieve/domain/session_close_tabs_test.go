package domain

import "testing"

func tabsSession(active int, ids ...string) Session {
	ts := make([]Tab, len(ids))
	for i, id := range ids {
		ts[i] = Tab{ID: id, Mode: "wysiwyg"}
	}
	return Session{Tabs: ts, ActiveIdx: active}
}

func activeTabID(s Session) string {
	if s.ActiveIdx < 0 || s.ActiveIdx >= len(s.Tabs) {
		return ""
	}
	return s.Tabs[s.ActiveIdx].ID
}

// Closing a BACKGROUND tab keeps the same tab active (by identity, not index).
func TestCloseTabs_keepsActiveIdentityWhenBackgroundClosed(t *testing.T) {
	s := tabsSession(2, "A", "B", "C", "D") // active C
	filed := s.CloseTabs([]string{"B"})
	if got := activeTabID(s); got != "C" {
		t.Fatalf("active = %q, want C", got)
	}
	if len(s.Tabs) != 3 {
		t.Fatalf("tabs = %d, want 3", len(s.Tabs))
	}
	if len(filed) != 1 || filed[0] != "B" {
		t.Fatalf("filed = %v, want [B]", filed)
	}
}

// Closing the ACTIVE tab falls to the nearest surviving tab on its right.
func TestCloseTabs_closingActivePicksNearestRight(t *testing.T) {
	s := tabsSession(2, "A", "B", "C", "D") // active C
	s.CloseTabs([]string{"C"})
	if got := activeTabID(s); got != "D" {
		t.Fatalf("active = %q, want D (nearest right)", got)
	}
}

// Closing the active LAST tab clamps left.
func TestCloseTabs_closingActiveLastPicksLeft(t *testing.T) {
	s := tabsSession(2, "A", "B", "C") // active C (last)
	s.CloseTabs([]string{"C"})
	if got := activeTabID(s); got != "B" {
		t.Fatalf("active = %q, want B (clamped left)", got)
	}
}

// Close Others: everything but the target closes; the target ends active.
func TestCloseTabs_closeOthersLeavesTargetActive(t *testing.T) {
	s := tabsSession(2, "A", "B", "C", "D") // active C
	s.CloseTabs([]string{"A", "C", "D"})    // keep B
	if len(s.Tabs) != 1 || s.Tabs[0].ID != "B" {
		t.Fatalf("tabs = %v, want [B]", s.Tabs)
	}
	if got := activeTabID(s); got != "B" {
		t.Fatalf("active = %q, want B", got)
	}
}

// Close All: every id closes → empty session; all non-prompt ids returned to file.
func TestCloseTabs_closeAllEmptiesAndFilesDocs(t *testing.T) {
	s := tabsSession(0, "A", "B")
	filed := s.CloseTabs([]string{"A", "B"})
	if len(s.Tabs) != 0 {
		t.Fatalf("tabs = %d, want 0", len(s.Tabs))
	}
	if len(filed) != 2 {
		t.Fatalf("filed = %v, want 2 docs", filed)
	}
}

// Prompt tabs are removed but never filed (they are not documents).
func TestCloseTabs_promptTabsRemovedButNotFiled(t *testing.T) {
	s := tabsSession(0, "prompt:file", "A")
	filed := s.CloseTabs([]string{"prompt:file", "A"})
	if len(s.Tabs) != 0 {
		t.Fatalf("tabs = %d, want 0", len(s.Tabs))
	}
	if len(filed) != 1 || filed[0] != "A" {
		t.Fatalf("filed = %v, want [A] (prompt excluded)", filed)
	}
}
