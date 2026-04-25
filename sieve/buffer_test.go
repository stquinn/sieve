package sieve

import (
	"path/filepath"
	"testing"
)

func TestCleanFolderPath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"Test Folder 3", "Test Folder 3"},
		{"Nested/Folder With Spaces", filepath.Join("Nested", "Folder With Spaces")},
		{"./Dangerous/../Path", filepath.Join("Dangerous", "Path")},
		{"Folder! @# With $ Symbols", "Folder With Symbols"},
		{"   Trim Me   ", "Trim Me"},
		{"Mixed.Dots-and_Underscores", "Mixed.Dots-and_Underscores"},
	}

	for _, tt := range tests {
		got := cleanFolderPath(tt.input)
		if got != tt.expected {
			t.Errorf("cleanFolderPath(%q) = %q, expected %q", tt.input, got, tt.expected)
		}
	}
}
