package webclip

import (
	"strings"
	"testing"
)

func TestParseAll_Pending(t *testing.T) {
	body := "```web-clip\nid: abc123\nsource: https://example.com\nmode: fetch\nstatus: PENDING\ncreatedAt: 2026-05-22T10:00:00Z\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	b := blocks[0]
	if b.ID != "abc123" {
		t.Errorf("id: got %q", b.ID)
	}
	if b.Source != "https://example.com" {
		t.Errorf("source: got %q", b.Source)
	}
	if b.Mode != "fetch" {
		t.Errorf("mode: got %q", b.Mode)
	}
	if b.Status != "PENDING" {
		t.Errorf("status: got %q", b.Status)
	}
}

func TestParseAll_Complete(t *testing.T) {
	body := "```web-clip\nid: xyz\nsource: https://example.com\ntitle: My Page\nmode: summarise\nstatus: COMPLETE\nmodel: claude-sonnet-4-6\ncreatedAt: 2026-05-22T10:00:00Z\ncompletedAt: 2026-05-22T10:01:00Z\ncontent: |\n  # Heading\n\n  Some content here.\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	b := blocks[0]
	if b.Title != "My Page" {
		t.Errorf("title: got %q", b.Title)
	}
	if b.Model != "claude-sonnet-4-6" {
		t.Errorf("model: got %q", b.Model)
	}
	if !strings.Contains(b.Content, "Heading") {
		t.Errorf("content: got %q", b.Content)
	}
}

func TestParseAll_Error(t *testing.T) {
	body := "```web-clip\nid: err1\nsource: https://example.com\nmode: fetch\nstatus: ERROR\ncreatedAt: 2026-05-22T10:00:00Z\nerror: |\n  Could not retrieve page.\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if !strings.Contains(blocks[0].Error, "Could not retrieve") {
		t.Errorf("error: got %q", blocks[0].Error)
	}
}

func TestParseAll_NoBlocks(t *testing.T) {
	if len(ParseAll("# Heading\n\n```go\ncode\n```\n")) != 0 {
		t.Error("expected no web-clip blocks")
	}
}

func TestParseAll_MissingID(t *testing.T) {
	body := "```web-clip\nsource: https://example.com\nstatus: PENDING\n```"
	if len(ParseAll(body)) != 0 {
		t.Error("block with no id should be skipped")
	}
}

func TestParseAll_MultipleBlocks(t *testing.T) {
	body := "text\n```web-clip\nid: a1\nsource: https://a.com\nmode: fetch\nstatus: PENDING\n```\nmiddle\n```web-clip\nid: a2\nsource: https://b.com\nmode: summarise\nstatus: COMPLETE\ncontent: |\n  Summary.\n```\nend"
	blocks := ParseAll(body)
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	if blocks[0].ID != "a1" || blocks[1].ID != "a2" {
		t.Errorf("unexpected ids: %q %q", blocks[0].ID, blocks[1].ID)
	}
}

func TestReplace_CompleteUpdate(t *testing.T) {
	body := "before\n```web-clip\nid: abc\nsource: https://example.com\nmode: fetch\nstatus: PENDING\ncreatedAt: 2026-05-22T10:00:00Z\n```\nafter"
	updated := WebClipData{
		ID:          "abc",
		Source:      "https://example.com",
		Title:       "Example Page",
		Mode:        "fetch",
		Status:      "COMPLETE",
		Model:       "claude-sonnet-4-6",
		CreatedAt:   "2026-05-22T10:00:00Z",
		CompletedAt: "2026-05-22T10:01:00Z",
		Content:     "# Example\n\nSome content.",
	}
	result, err := Replace(body, updated)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result, "status: COMPLETE") {
		t.Error("missing COMPLETE status")
	}
	if !strings.Contains(result, "Example Page") {
		t.Error("missing title content")
	}
	if !strings.Contains(result, "Some content.") {
		t.Error("missing content")
	}
	if !strings.Contains(result, "before") || !strings.Contains(result, "after") {
		t.Error("surrounding content lost")
	}
}

func TestReplace_NotFound(t *testing.T) {
	body := "```web-clip\nid: xyz\nsource: https://example.com\nmode: fetch\nstatus: PENDING\n```"
	_, err := Replace(body, WebClipData{ID: "notexist"})
	if err == nil {
		t.Error("expected error for missing block")
	}
}

func TestRoundTrip(t *testing.T) {
	original := WebClipData{
		ID:          "rt1",
		Source:      "https://confluence.example.com/Architecture",
		Title:       "Architecture Overview",
		Mode:        "summarise",
		Status:      "COMPLETE",
		Model:       "claude-sonnet-4-6",
		CreatedAt:   "2026-05-22T10:00:00Z",
		CompletedAt: "2026-05-22T10:01:00Z",
		Content:     "The system has three layers.\n\n## Ingestion\n\nAll data enters here.",
	}
	yaml := SerializeYAML(original)
	body := "```web-clip\n" + yaml + "\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	b := blocks[0]
	if b.ID != original.ID {
		t.Errorf("id: %q", b.ID)
	}
	if b.Title != original.Title {
		t.Errorf("title: %q", b.Title)
	}
	if !strings.Contains(b.Content, "three layers") {
		t.Errorf("content not preserved: %q", b.Content)
	}
}

func TestSerializeYAML_Defaults(t *testing.T) {
	d := WebClipData{ID: "x1", Source: "https://example.com", Mode: "fetch"}
	s := SerializeYAML(d)
	if !strings.Contains(s, "status: PENDING") {
		t.Error("expected default status: PENDING")
	}
}

func TestSerializeYAML_ColonInTitle(t *testing.T) {
	d := WebClipData{
		ID:     "colon1",
		Source: "https://example.com",
		Title:  "React: A Complete Guide",
		Mode:   "fetch",
		Status: "COMPLETE",
	}
	yaml := SerializeYAML(d)
	body := "```web-clip\n" + yaml + "\n```"
	blocks := ParseAll(body)
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block after round-trip with colon title, got %d", len(blocks))
	}
	if blocks[0].Title != d.Title {
		t.Errorf("title: got %q, want %q", blocks[0].Title, d.Title)
	}
}
