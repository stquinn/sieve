package services

import (
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
		got := LibraryDisplayName(tt.path)
		if got != tt.want {
			t.Errorf("LibraryDisplayName(%q) = %q, want %q", tt.path, got, tt.want)
		}
	}
}
