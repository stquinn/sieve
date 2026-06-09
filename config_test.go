package main

import (
	"fmt"
	"testing"
)

func TestLibraryDisplayName(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/home/user/notes", "Notes"},
		{"/home/user/production-notes", "Production Notes"},
		{"/home/user/devTesting", "Dev Testing"},
		{"/home/user/work_notes", "Work Notes"},
		{"/home/user/myKnowledgeBase", "My Knowledge Base"},
		{"/home/user/my-dev_notes", "My Dev Notes"},
	}
	for _, tt := range tests {
		got := libraryDisplayName(tt.path)
		if got != tt.want {
			t.Errorf("libraryDisplayName(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}

func TestAddRecent(t *testing.T) {
	c := GlobalConfig{}

	c.AddRecent("/a/notes")
	if len(c.RecentLibraries) != 1 || c.RecentLibraries[0].Path != "/a/notes" {
		t.Fatalf("expected 1 entry, got %v", c.RecentLibraries)
	}

	// dedup: adding same path moves it to front
	c.AddRecent("/b/other")
	c.AddRecent("/a/notes")
	if len(c.RecentLibraries) != 2 || c.RecentLibraries[0].Path != "/a/notes" {
		t.Fatalf("dedup failed: %v", c.RecentLibraries)
	}

	// trim to 8
	for i := 0; i < 10; i++ {
		c.AddRecent(fmt.Sprintf("/x/lib%d", i))
	}
	if len(c.RecentLibraries) != 8 {
		t.Fatalf("expected 8 entries, got %d", len(c.RecentLibraries))
	}
}
