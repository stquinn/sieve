package sieve

import (
	"strings"
	"testing"
)

func TestRemux_replacesBlockInWysiwyg(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nquestion: What?\nresponse: Old answer\nstatus: COMPLETE\n```\n\nSome prose."
	shadow := &ShadowDocument{
		UUID:     "test-uuid",
		Markdown: md,
		Mode:     "wysiwyg",
		Blocks: map[string]*SieveBlock{
			"ab-1234": {
				ID:   "ab-1234",
				Kind: "ai-block",
				Attrs: map[string]interface{}{
					"id":       "ab-1234",
					"question": "What?",
					"response": "New answer",
					"status":   "COMPLETE",
				},
			},
		},
	}

	result := shadow.Remux()

	if !strings.Contains(result, "response: New answer") {
		t.Errorf("expected Remux to update response, got:\n%s", result)
	}
	if strings.Contains(result, "response: Old answer") {
		t.Errorf("expected Remux to remove old response, got:\n%s", result)
	}
	if !strings.Contains(result, "Some prose.") {
		t.Errorf("expected prose to be preserved, got:\n%s", result)
	}
}

func TestRemux_markdownModeIsNoop(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\n```"
	shadow := &ShadowDocument{
		UUID:     "test-uuid",
		Markdown: md,
		Mode:     "markdown",
		Blocks: map[string]*SieveBlock{
			"ab-1234": {
				ID:   "ab-1234",
				Kind: "ai-block",
				Attrs: map[string]interface{}{
					"id":       "ab-1234",
					"response": "this should NOT appear",
				},
			},
		},
	}

	result := shadow.Remux()

	if result != md {
		t.Errorf("expected Remux to be no-op in markdown mode, got:\n%s", result)
	}
}

func TestRemux_emptyBlocksIsNoop(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: untouched\n```"
	shadow := &ShadowDocument{
		UUID:     "test-uuid",
		Markdown: md,
		Mode:     "wysiwyg",
		Blocks:   make(map[string]*SieveBlock),
	}

	result := shadow.Remux()

	if result != md {
		t.Errorf("expected no change with empty Blocks, got:\n%s", result)
	}
}

func TestShadowDocument_setBlockCreatesEntry(t *testing.T) {
	shadow := &ShadowDocument{
		UUID:   "test-uuid",
		Mode:   "wysiwyg",
		Blocks: make(map[string]*SieveBlock),
	}

	shadow.setBlock("code", "cb-0001", map[string]interface{}{
		"id":     "cb-0001",
		"source": "fmt.Println()",
	})

	blk, ok := shadow.Blocks["cb-0001"]
	if !ok {
		t.Fatal("expected block cb-0001 to exist")
	}
	if blk.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", blk.Kind)
	}
}

func TestShadowDocument_setBlockMergesAttrs(t *testing.T) {
	shadow := &ShadowDocument{
		UUID: "test-uuid",
		Mode: "wysiwyg",
		Blocks: map[string]*SieveBlock{
			"cb-0001": {
				ID:   "cb-0001",
				Kind: "code",
				Attrs: map[string]interface{}{
					"id":       "cb-0001",
					"source":   "old",
					"language": "unknown",
				},
			},
		},
	}

	shadow.setBlock("code", "cb-0001", map[string]interface{}{
		"language": "python",
		"status":   "COMPLETE",
	})

	blk := shadow.Blocks["cb-0001"]
	if blk.Attrs["source"] != "old" {
		t.Errorf("expected source to be preserved, got %v", blk.Attrs["source"])
	}
	if blk.Attrs["language"] != "python" {
		t.Errorf("expected language=python, got %v", blk.Attrs["language"])
	}
	if blk.Attrs["status"] != "COMPLETE" {
		t.Errorf("expected status=COMPLETE, got %v", blk.Attrs["status"])
	}
}
