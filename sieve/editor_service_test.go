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

func TestEditorService_FlushWritesToDisk(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc.SetBody([]byte("# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\nstatus: COMPLETE\n```"))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	es.UpdateMarkdown(uuid, "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\nstatus: COMPLETE\n```")
	es.UpdateBlock(uuid, "ai-block", "ab-1234", map[string]interface{}{
		"id":       "ab-1234",
		"response": "updated by user",
		"status":   "COMPLETE",
	})

	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(reloaded.Body()), "updated by user") {
		t.Errorf("expected flushed content to contain updated response, got:\n%s", reloaded.Body())
	}
}

func TestEditorService_EnterMarkdownEmbedsBlocks(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Doc\n\n```code\nid: cb-0001\nsource: old\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid)
	es.UpdateMarkdown(uuid, "# Doc\n\n```code\nid: cb-0001\nsource: old\nstatus: COMPLETE\n```")
	es.UpdateBlock(uuid, "code", "cb-0001", map[string]interface{}{
		"id":     "cb-0001",
		"source": "updated source",
		"status": "COMPLETE",
	})

	seed := es.EnterMarkdown(uuid)
	if !strings.Contains(seed, "updated source") {
		t.Errorf("expected EnterMarkdown seed to include updated block, got:\n%s", seed)
	}

	// After entering markdown mode, Flush should save verbatim — not re-apply stale Blocks
	es.UpdateMarkdown(uuid, seed)
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	reloaded, _ := ds.LoadByUUID(uuid)
	if !strings.Contains(string(reloaded.Body()), "updated source") {
		t.Errorf("expected disk to contain updated source after markdown-mode flush")
	}
}

func TestEditorService_EnterWysiwygReparsesBlocks(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Doc\n\n```code\nid: cb-0001\nsource: original\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid)
	_ = es.EnterMarkdown(uuid)

	// User edits block YAML directly in markdown mode
	es.UpdateMarkdown(uuid, "# Doc\n\n```code\nid: cb-0001\nsource: hand-edited\nstatus: COMPLETE\n```")

	es.EnterWysiwyg(uuid)

	// Now UpdateBlock should merge into the re-parsed block
	es.UpdateBlock(uuid, "code", "cb-0001", map[string]interface{}{
		"language": "go",
	})

	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	reloaded, _ := ds.LoadByUUID(uuid)
	body := string(reloaded.Body())
	if !strings.Contains(body, "hand-edited") {
		t.Errorf("expected hand-edited source to be preserved, got:\n%s", body)
	}
	if !strings.Contains(body, "language: go") {
		t.Errorf("expected UpdateBlock to have applied language, got:\n%s", body)
	}
}

