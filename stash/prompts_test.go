package stash

import (
	"testing"
)

func TestGetPromptContent(t *testing.T) {
	// Default — no override.
	content, err := GetPromptContent("file", "")
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if content != DefaultFilingPrompt {
		t.Errorf("expected default content, got %s", content)
	}

	// Override provided.
	overrideContent := "Custom Prompt"
	content, err = GetPromptContent("file", overrideContent)
	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
	if content != overrideContent {
		t.Errorf("expected override content %q, got %q", overrideContent, content)
	}

	// Unknown name returns error.
	_, err = GetPromptContent("invalid", "")
	if err == nil {
		t.Errorf("expected error for invalid prompt name")
	}
}
