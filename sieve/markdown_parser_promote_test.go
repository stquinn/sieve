package sieve

import (
	"testing"
)

func TestPromoteBlock_replacesBlockWithContent(t *testing.T) {
	markdown := "Before\n\n```smart-card\nid: ri-0001\nhref: https://example.com\n```\n\nAfter"
	// Register a minimal processor so the parser recognises smart-card
	RegisterProcessor("smart-card", NewSmartCardProcessor(BlockServices{}))
	defer UnregisterProcessor("smart-card")

	result, ok := PromoteBlock(markdown, "ri-0001", "### [Example](https://example.com)")
	if !ok {
		t.Fatal("PromoteBlock: block not found")
	}
	if result == markdown {
		t.Fatal("PromoteBlock: markdown unchanged")
	}
	if !contains(result, "### [Example](https://example.com)") {
		t.Errorf("PromoteBlock: promoted content missing; got:\n%s", result)
	}
	if contains(result, "```smart-card") {
		t.Error("PromoteBlock: fenced block still present after promotion")
	}
	if !contains(result, "Before") || !contains(result, "After") {
		t.Error("PromoteBlock: surrounding content lost")
	}
}

func TestPromoteBlock_unknownIDReturnsFalse(t *testing.T) {
	markdown := "Some content without any blocks"
	result, ok := PromoteBlock(markdown, "ri-9999", "replacement")
	if ok {
		t.Error("PromoteBlock: expected false for unknown blockID")
	}
	if result != markdown {
		t.Error("PromoteBlock: markdown must be unchanged when block not found")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		func() bool {
			for i := 0; i <= len(s)-len(substr); i++ {
				if s[i:i+len(substr)] == substr {
					return true
				}
			}
			return false
		}())
}
