package vault

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGetPromptContent(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "stash-prompts-test")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tempDir)

	settings := Settings{}
	
	// Test Default
	content, err := GetPromptContent("file", settings)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if content != DefaultFilingPrompt {
		t.Errorf("expected default content, got %s", content)
	}

	// Test Override
	overridePath := filepath.Join(tempDir, "file.md")
	overrideContent := "Custom Prompt"
	if err := os.WriteFile(overridePath, []byte(overrideContent), 0644); err != nil {
		t.Fatal(err)
	}

	settings.Prompts.File = overridePath
	content, err = GetPromptContent("file", settings)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if content != overrideContent {
		t.Errorf("expected custom content, got %s", content)
	}

	// Test Fallback when file is missing
	os.Remove(overridePath)
	content, err = GetPromptContent("file", settings)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if content != DefaultFilingPrompt {
		t.Errorf("expected fallback to default, got %s", content)
	}

	// Test Invalid name
	_, err = GetPromptContent("invalid", settings)
	if err == nil {
		t.Errorf("expected error for invalid prompt name")
	}
}
