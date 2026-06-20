package sieve

import (
	"context"
	"sieve/sieve/block"
	"strings"
	"testing"
	"time"
)

func TestContentForSave_replacesBlockInWysiwyg(t *testing.T) {
	block.RegisterProcessor("ai-block", &testRunJobProcessor{})
	// Authoritative block state lives in Doc; a SetBlock update must win on save.
	shadow := &block.ShadowDocument{
		UUID:  "test-uuid",
		Mode:  "wysiwyg",
		codec: block.NewDocumentCodec(block.GlobalRegistry()),
		Blocks: []block.SieveBlock{
			{ID: "pr-hello", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "# Hello"}},
			{ID: "ab-1234", Kind: "ai-block", Attrs: map[string]interface{}{
				"id":       "ab-1234",
				"question": "What?",
				"response": "Old answer",
				"status":   "COMPLETE",
			}},
			{ID: "pr-some", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Some prose."}},
		},
	}

	shadow.SetBlock(block.SieveBlock{ID: "ab-1234", Kind: "ai-block", Attrs: map[string]interface{}{
		"response": "New answer",
	}})

	result := shadow.ContentForSave()

	if !strings.Contains(result, "response: New answer") {
		t.Errorf("expected ContentForSave to update response, got:\n%s", result)
	}
	if strings.Contains(result, "response: Old answer") {
		t.Errorf("expected ContentForSave to remove old response, got:\n%s", result)
	}
	if !strings.Contains(result, "Some prose.") {
		t.Errorf("expected prose to be preserved, got:\n%s", result)
	}
}

func TestContentForSave_markdownModeIsVerbatim(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\n```"
	shadow := &block.ShadowDocument{
		UUID:         "test-uuid",
		mdModeBuffer: md,
		Mode:         "markdown",
	}

	result := shadow.ContentForSave()

	if result != md {
		t.Errorf("expected ContentForSave to return markdown verbatim, got:\n%s", result)
	}
}

func TestContentForSave_roundTripsWysiwyg(t *testing.T) {
	block.RegisterProcessor("ai-block", &testRunJobProcessor{})
	t.Cleanup(func() { block.UnregisterProcessor("ai-block") })
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: untouched\n```"
	shadow := block.NewShadow("test-uuid", md, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)

	result := shadow.ContentForSave()

	// Content is preserved through the serialization spine...
	if !strings.Contains(result, "# Hello") || !strings.Contains(result, "response: untouched") {
		t.Fatalf("expected content preserved, got:\n%s", result)
	}
	// ...and the serialization is stable (parse -> serialize -> parse is a fixpoint).
	if again := block.NewShadow("test-uuid", result, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil).ContentForSave(); again != result {
		t.Fatalf("serialization not stable:\n first: %q\nsecond: %q", result, again)
	}
}

// A doc-update carrying id-less prose (the pre-mint frontend fallback writes
// bare markdown) must never be persisted id-less: Go mints a handle for every
// id-less prose block on reparse, so ContentForSave always emits a delimited,
// addressable block. Backend discipline — a block has an id, period.
func TestShadowDocument_DocUpdateMintsHandlesForIdlessProse(t *testing.T) {
	shadow := block.NewShadow("test-uuid", "", block.NewDocumentCodec(block.GlobalRegistry()), 0, nil) // empty doc, wysiwyg
	shadow.SetMarkdown("First paragraph.\n\nSecond paragraph.")

	// Every prose block in the authoritative tree now carries an id.
	for i, b := range shadow.Blocks {
		if b.Kind == block.KindProse && b.ID == "" {
			t.Fatalf("block %d persisted id-less: %+v", i, b)
		}
	}

	// ...so the saved markdown is delimited (addressable), not bare prose.
	out := shadow.ContentForSave()
	if !strings.Contains(out, "<!--s:") || !strings.Contains(out, "<!--/s:") {
		t.Fatalf("expected delimited (id-bearing) prose on save, got:\n%s", out)
	}

	// And the minted identity is stable across reopen (idempotent).
	if again := block.NewShadow("test-uuid", out, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil).ContentForSave(); again != out {
		t.Fatalf("minted handles not stable:\n first: %q\nsecond: %q", out, again)
	}
}

func TestShadowDocument_setBlockCreatesEntry(t *testing.T) {
	shadow := &block.ShadowDocument{
		UUID: "test-uuid",
		Mode: "wysiwyg",
	}

	shadow.SetBlock(block.SieveBlock{
		Kind: "code",
		ID:   "cb-0001",
		Attrs: map[string]interface{}{
			"id":     "cb-0001",
			"source": "fmt.Println()",
		},
	})

	blk := shadow.findBlockIn("cb-0001")
	if blk == nil {
		t.Fatal("expected block cb-0001 to exist")
	}
	if blk.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", blk.Kind)
	}
}

func TestShadowDocument_setBlockMergesAttrs(t *testing.T) {
	shadow := &block.ShadowDocument{
		UUID: "test-uuid",
		Mode: "wysiwyg",
		Blocks: []block.SieveBlock{
			{ID: "cb-0001", Kind: "code", Attrs: map[string]interface{}{
				"id":       "cb-0001",
				"source":   "old",
				"language": "unknown",
			}},
		},
	}

	shadow.SetBlock(block.SieveBlock{
		Kind: "code",
		ID:   "cb-0001",
		Attrs: map[string]interface{}{
			"language": "python",
			"status":   "COMPLETE",
		},
	})

	blk := shadow.findBlockIn("cb-0001")
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
	block.RegisterProcessor("ai-block", &testRunJobProcessor{})
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)

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

	if err := es.Open(uuid, nil); err != nil {
		t.Fatalf("Open: %v", err)
	}
	es.UpdateMarkdown(uuid, "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\nstatus: COMPLETE\n```")
	es.UpdateBlock(uuid, block.SieveBlock{
		Kind: "ai-block",
		ID:   "ab-1234",
		Attrs: map[string]interface{}{
			"id":       "ab-1234",
			"response": "updated by user",
			"status":   "COMPLETE",
		},
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
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Doc\n\n```code\nid: cb-0001\nsource: old\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid, nil)
	es.UpdateMarkdown(uuid, "# Doc\n\n```code\nid: cb-0001\nsource: old\nstatus: COMPLETE\n```")
	es.UpdateBlock(uuid, block.SieveBlock{
		Kind: "code",
		ID:   "cb-0001",
		Attrs: map[string]interface{}{
			"id":     "cb-0001",
			"source": "updated source",
			"status": "COMPLETE",
		},
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

func TestEditorService_CloseFlushesAndRemovesShadow(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello\n\nSome prose."))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid, nil)
	es.UpdateMarkdown(uuid, "# Hello\n\nEdited prose.")

	es.Close(uuid)

	// Shadow must be gone after Close.
	es.mu.RLock()
	_, stillOpen := es.shadows[uuid]
	es.mu.RUnlock()
	if stillOpen {
		t.Error("expected shadow to be removed after Close")
	}

	// Content must be on disk.
	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(reloaded.Body()), "Edited prose.") {
		t.Errorf("expected Close to flush content, got:\n%s", reloaded.Body())
	}
}

func TestEditorService_FlushAllWritesAllShadows(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)

	var uuids []string
	for i, body := range []string{"doc one body", "doc two body"} {
		doc, _ := ds.New()
		doc.SetBody([]byte("original"))
		doc, _ = ds.Save(doc)
		uuids = append(uuids, doc.UUID())
		_ = es.Open(doc.UUID(), nil)
		es.UpdateMarkdown(doc.UUID(), body)
		_ = i
	}

	es.FlushAll()

	for i, uuid := range uuids {
		reloaded, err := ds.LoadByUUID(uuid)
		if err != nil {
			t.Fatalf("doc %d LoadByUUID: %v", i, err)
		}
		if strings.Contains(string(reloaded.Body()), "original") {
			t.Errorf("doc %d: expected FlushAll to overwrite original, got:\n%s", i, reloaded.Body())
		}
	}
}

func TestEditorService_UpdateMarkdown_NoShadowIsNoop(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)
	// No Open — shadow doesn't exist; should not panic.
	es.UpdateMarkdown("nonexistent-uuid", "some content")
}

func TestEditorService_UpdateBlock_NoShadowIsNoop(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)
	es.UpdateBlock("nonexistent-uuid", block.SieveBlock{Kind: "ai-block", ID: "ab-0001", Attrs: map[string]interface{}{"id": "ab-0001"}})
}

func TestEditorService_EnterMarkdown_NoShadowReturnsEmpty(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)
	result := es.EnterMarkdown("nonexistent-uuid")
	if result != "" {
		t.Errorf("expected empty string for missing shadow, got %q", result)
	}
}

func TestEditorService_EnterWysiwyg_NoShadowIsNoop(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)
	es.EnterWysiwyg("nonexistent-uuid") // must not panic
}

func TestEditorService_NotifySavedCalledAfterDebounce(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	// Use a very short debounce so the test doesn't take long.
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 50*time.Millisecond)

	doc, _ := ds.New()
	doc.SetBody([]byte("original"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	notified := make(chan struct{}, 1)
	_ = es.Open(uuid, func() { notified <- struct{}{} })
	es.UpdateMarkdown(uuid, "updated content")

	select {
	case <-notified:
		// good
	case <-time.After(2 * time.Second):
		t.Fatal("notifySaved was not called within 2s after debounce")
	}

	reloaded, _ := ds.LoadByUUID(uuid)
	if !strings.Contains(string(reloaded.Body()), "updated content") {
		t.Errorf("expected debounce to save content, got:\n%s", reloaded.Body())
	}
}

func TestEditorService_EnterWysiwygReparsesBlocks(t *testing.T) {
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Second)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Doc\n\n```code\nid: cb-0001\nsource: original\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	_ = es.Open(uuid, nil)
	_ = es.EnterMarkdown(uuid)

	// User edits block YAML directly in markdown mode
	es.UpdateMarkdown(uuid, "# Doc\n\n```code\nid: cb-0001\nsource: hand-edited\nstatus: COMPLETE\n```")

	es.EnterWysiwyg(uuid)

	es.UpdateBlock(uuid, block.SieveBlock{
		Kind: "code",
		ID:   "cb-0001",
		Attrs: map[string]interface{}{
			"language": "go",
		},
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

func TestEditorService_CreateBlock_code(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)
	defer waitJobs(t, es, uuid)

	id, rawYaml, err := es.CreateBlock(uuid, "code", nil)
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	if len(id) < 5 {
		t.Errorf("expected valid id, got %q", id)
	}
	if !strings.Contains(rawYaml, "status: PENDING") {
		t.Errorf("expected PENDING in rawYaml, got:\n%s", rawYaml)
	}

	// Block must be in shadow with complete attrs
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()
	shadow.mu.Lock()
	blk := shadow.findBlockIn(id)
	shadow.mu.Unlock()
	if blk == nil {
		t.Fatal("expected block in shadow")
	}
	if blk.Attrs["id"] != id {
		t.Errorf("expected id in attrs, got %v", blk.Attrs["id"])
	}
	if _, ok := blk.Attrs["source"]; !ok {
		t.Error("expected source field in attrs (zero value)")
	}
	if _, ok := blk.Attrs["language"]; !ok {
		t.Error("expected language field in attrs (zero value)")
	}
}

func TestEditorService_CreateBlock_withOverrides(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)
	defer waitJobs(t, es, uuid)

	id, rawYaml, err := es.CreateBlock(doc.UUID(), "code", map[string]interface{}{
		"source": "print('hello')",
		"hint":   "python",
	})
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}
	if !strings.Contains(rawYaml, "print") {
		t.Errorf("expected source in rawYaml, got:\n%s", rawYaml)
	}
	_ = id
}

func TestEditorService_HandlePaste_delegatesToCreateBlock(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)
	defer waitJobs(t, es, uuid)

	kind, id, rawYaml, matched := es.HandlePaste(uuid, []block.ContentEntry{{MIMEType: "text/plain", Content: "```python\nprint('hello')\n```"}})
	if !matched {
		t.Fatal("expected match")
	}
	if kind != "code" {
		t.Errorf("expected kind=code, got %q", kind)
	}
	if len(id) < 5 {
		t.Errorf("expected valid id, got %q", id)
	}
	// rawYaml must contain the complete initial state, not just paste-extracted values
	if !strings.Contains(rawYaml, "status: PENDING") {
		t.Errorf("expected complete state in rawYaml, got:\n%s", rawYaml)
	}
	if !strings.Contains(rawYaml, "print") {
		t.Errorf("expected source in rawYaml, got:\n%s", rawYaml)
	}
}

func TestEditorService_HandlePaste_noMatch(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	_ = es.Open(doc.UUID(), nil)

	_, _, _, matched := es.HandlePaste(doc.UUID(), []block.ContentEntry{{MIMEType: "text/plain", Content: "just plain text"}})
	if matched {
		t.Fatal("expected no match for plain text")
	}
}

type mockLifecycleListener struct {
	onCreated func(uuid, kind, blockID, rawYaml string)
	onUpdated func(uuid, blockID string, attrs map[string]interface{}, rawYaml string)
}

func (l *mockLifecycleListener) OnBlockPromoted(uuid, blockID string, replacement string) {}

func (l *mockLifecycleListener) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, rawYaml string) {
	if l.onCreated != nil {
		l.onCreated(uuid, kind, blockID, rawYaml)
	}
}

func (l *mockLifecycleListener) OnBlockUpdated(uuid, blockID string, attrs map[string]interface{}, rawYaml string) {
	if l.onUpdated != nil {
		l.onUpdated(uuid, blockID, attrs, rawYaml)
	}
}

func TestHandleBlockUpdate_notifySendsSnapshotUnderLock(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	var notifyID string
	var notifyYaml string
	notifyCalled := make(chan struct{}, 1)

	listener := &mockLifecycleListener{
		onUpdated: func(uuid, blockID string, attrs map[string]interface{}, rawYaml string) {
			if strings.Contains(rawYaml, "language:") {
				notifyID = blockID
				notifyYaml = rawYaml
				select {
				case notifyCalled <- struct{}{}:
				default:
				}
			}
		},
	}
	es.SetLifecycleListener(listener)

	doc, _ := ds.New()
	doc.SetBody([]byte("# Hello"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)

	// Create a code block with a very short source (<30 chars) so heuristics
	// do not fire in InitAttrs and language stays empty. OnChange will then
	// receive a long Go source (>=30 chars) that triggers heuristic detection,
	// producing a non-empty attrsChanged and exercising the notify path.
	id, _, err := es.CreateBlock(uuid, "code", map[string]interface{}{
		"source": "x", // too short for heuristics; language stays ""
	})
	if err != nil {
		t.Fatalf("CreateBlock: %v", err)
	}

	// Supply a Go source long enough to pass minSourceLength (30) so that
	// OnChange detects "go" and sets language, making attrsChanged non-empty.
	goSource := "package main\n\nimport \"fmt\"\n\nfunc main() { fmt.Println(\"hello\") }"
	es.HandleBlockUpdate(uuid, "code", id, map[string]interface{}{
		"source": goSource,
	})

	select {
	case <-notifyCalled:
		// notify was invoked synchronously by the OnChange heuristic path
	case <-time.After(2 * time.Second):
		t.Fatal("notify was not called within 2s")
	}

	if notifyID != id {
		t.Errorf("expected notify block id=%q, got %q", id, notifyID)
	}
	if !strings.Contains(notifyYaml, "language:") {
		t.Errorf("expected notify rawYaml to contain language: key, got:\n%s", notifyYaml)
	}

	// Wait for background RunJob to complete so the temp dir cleanup doesn't race
	for i := 0; i < 50; i++ {
		es.mu.Lock()
		shadow := es.shadows[uuid]
		es.mu.Unlock()
		if shadow != nil {
			shadow.mu.Lock()
			blk := shadow.findBlockIn(id)
			status := ""
			if blk != nil {
				status, _ = blk.Attrs["status"].(string)
			}
			shadow.mu.Unlock()
			if status == block.BlockStatusError || status == block.BlockStatusComplete {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type testRunJobProcessor struct {
	block.FencedSerializer
	block.FencedDeserializer
	runJob func(ctx context.Context, uuid string, blk *block.SieveBlock) error
}

func (p *testRunJobProcessor) Mode() block.BlockMode { return block.BlockModeBlock }
func (p *testRunJobProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id, "status": block.BlockStatusPending}
	for k, v := range overrides {
		attrs[k] = v
	}
	return attrs
}
func (p *testRunJobProcessor) IsBlock(entries []block.ContentEntry) bool { return false }
func (p *testRunJobProcessor) Transform(entries []block.ContentEntry, _ string, _ string) map[string]interface{} {
	return nil
}
func (p *testRunJobProcessor) BuildContext(_ block.SieveBlock, _ block.DocView, _ map[string]bool) string {
	return ""
}
func (p *testRunJobProcessor) MarkdownRepresentation(_ block.SieveBlock) string { return "" }
func (p *testRunJobProcessor) OnChange(_ *block.SieveBlock)                     {}
func (p *testRunJobProcessor) RunJob(jctx block.JobContext) error {
	if p.runJob != nil {
		return p.runJob(jctx.Ctx, jctx.UUID, jctx.Block)
	}
	return nil
}
func (p *testRunJobProcessor) JobLabel(_ *block.SieveBlock) string { return "" }

func TestEditorService_RunJob_dynamicMerging(t *testing.T) {
	resetRegistry()

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Test"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)

	// Create a block with initial attributes
	initialAttrs := map[string]interface{}{
		"source":   "original source",
		"language": "python",
		"hint":     "some-hint",
		"status":   block.BlockStatusDispatched,
	}

	var blockID string

	// Register a mock processor
	proc := &testRunJobProcessor{
		runJob: func(ctx context.Context, uuid string, blk *block.SieveBlock) error {
			// Simulate job modifying attrs
			blk.Attrs["language"] = "go"         // modified
			blk.Attrs["added_key"] = "new value" // added
			blk.Attrs["status"] = block.BlockStatusComplete
			delete(blk.Attrs, "hint") // deleted

			// Simulate a concurrent user edit to "source" during the job execution
			es.mu.Lock()
			shadow := es.shadows[uuid]
			es.mu.Unlock()
			shadow.mu.Lock()
			shadow.findBlockIn(blockID).Attrs["source"] = "concurrent user edit"
			shadow.mu.Unlock()

			return nil
		},
	}
	block.RegisterProcessor("mock-kind", proc)

	blockID, _, err := es.CreateBlock(uuid, "mock-kind", initialAttrs)
	if err != nil {
		t.Fatalf("CreateBlock failed: %v", err)
	}

	// Call RunJob
	es.RunJob(context.Background(), uuid, blockID)

	// Check final attributes in shadow
	es.mu.Lock()
	shadow := es.shadows[uuid]
	es.mu.Unlock()

	shadow.mu.Lock()
	blk := shadow.findBlockIn(blockID)
	shadow.mu.Unlock()

	if blk == nil {
		t.Fatal("expected block to exist in shadow")
	}

	// Check updates
	if blk.Attrs["language"] != "go" {
		t.Errorf("expected language to be updated to 'go', got %v", blk.Attrs["language"])
	}
	if blk.Attrs["added_key"] != "new value" {
		t.Errorf("expected added_key to be 'new value', got %v", blk.Attrs["added_key"])
	}
	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("expected status to be COMPLETE, got %v", blk.Attrs["status"])
	}

	// Check deleted keys
	if _, exists := blk.Attrs["hint"]; exists {
		t.Error("expected hint key to be deleted")
	}

	// Check preserved concurrent edit
	if blk.Attrs["source"] != "concurrent user edit" {
		t.Errorf("expected concurrent user edit to be preserved, got %v", blk.Attrs["source"])
	}
}

func TestEditorService_RunJob_shadowRecreatedMidJob(t *testing.T) {
	resetRegistry()

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("# Test"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)

	initialAttrs := map[string]interface{}{
		"status": block.BlockStatusDispatched,
		// A realistic recent createdAt: a freshly-created block is not "stuck", so
		// resetStuckDispatched on the mid-job reopen must not re-dispatch it. (Now
		// that created blocks persist through Close, this keeps the test focused on
		// the recreate-mid-job behaviour it is actually exercising.)
		"createdAt": time.Now().Format(time.RFC3339),
	}

	var blockID string

	proc := &testRunJobProcessor{
		runJob: func(ctx context.Context, jobUUID string, blk *block.SieveBlock) error {
			// Simulate the user navigating away (Close) and back (Open) while the job runs
			es.Close(uuid)
			if errOpen := es.Open(uuid, nil); errOpen != nil {
				t.Logf("Open error: %v", errOpen)
			}

			blk.Attrs["status"] = block.BlockStatusComplete
			return nil
		},
	}
	block.RegisterProcessor("mock-kind2", proc)

	blockID, _, err := es.CreateBlock(uuid, "mock-kind2", initialAttrs)
	if err != nil {
		t.Fatalf("CreateBlock failed: %v", err)
	}

	es.RunJob(context.Background(), uuid, blockID)

	// Ensure the NEW shadow has the COMPLETE state
	es.mu.RLock()
	shadow := es.shadows[uuid]
	es.mu.RUnlock()

	if shadow == nil {
		t.Fatal("expected new shadow to exist")
	}

	shadow.mu.Lock()
	blk := shadow.findBlockIn(blockID)
	shadow.mu.Unlock()

	if blk == nil {
		t.Fatal("expected block to exist in new shadow")
	}

	if blk.Attrs["status"] != block.BlockStatusComplete {
		t.Errorf("expected status to be applied to the NEW shadow, got %v", blk.Attrs["status"])
	}
}

// TestApplyJobUpdate_closedDoc verifies that a job update targeting a document
// that is NOT open in memory (no shadow) is persisted to disk via a transient
// Open→apply→Close cycle, and that no shadow leaks into es.shadows afterward.
// Uses the "code" kind (real CodeBlockProcessor) so the fenced block is
// properly deserialized by the shadow and its block-id is recognized.
func TestApplyJobUpdate_closedDoc(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("code", NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	// Create and save a document with a code block; never open it in the EditorService.
	// createdAt is set to "now" so resetStuckDispatched (called on Open) does not
	// treat the DISPATCHED block as stuck and spawn a background RunJob goroutine,
	// which would race with our transient Close.
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	createdAt := time.Now().Format(time.RFC3339)
	body := "# Job Update Test\n\n```code\nid: cb-closed\nstatus: DISPATCHED\ncreatedAt: " + createdAt + "\nsource: old source\n```"
	doc.SetBody([]byte(body))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	uuid := doc.UUID()

	// Confirm no shadow exists before the update.
	es.mu.RLock()
	_, hasShadow := es.shadows[uuid]
	es.mu.RUnlock()
	if hasShadow {
		t.Fatal("precondition: expected no open shadow before applyJobUpdate")
	}

	// Apply a job update to the closed document.
	es.applyJobUpdate(uuid, "cb-closed", "code",
		map[string]interface{}{"status": block.BlockStatusComplete, "source": "new source"},
		nil, // no deletes
		"",  // no explicit flush reason; Close will flush
	)

	// Shadow must be gone after the transient open+close.
	es.mu.RLock()
	_, stillOpen := es.shadows[uuid]
	es.mu.RUnlock()
	if stillOpen {
		t.Error("expected no shadow to remain after transient applyJobUpdate on closed doc")
	}

	// The update must be persisted on disk.
	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	diskBody := string(reloaded.Body())
	if !strings.Contains(diskBody, "new source") {
		t.Errorf("expected disk body to contain 'new source' after job update, got:\n%s", diskBody)
	}
	if !strings.Contains(diskBody, string(block.BlockStatusComplete)) {
		t.Errorf("expected disk body to contain COMPLETE status after job update, got:\n%s", diskBody)
	}
	if strings.Contains(diskBody, "old source") {
		t.Errorf("expected old source to be replaced on disk, got:\n%s", diskBody)
	}
}

func waitJobs(t *testing.T, es *EditorService, uuid string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		es.mu.Lock()
		shadow := es.shadows[uuid]
		es.mu.Unlock()
		if shadow == nil {
			return
		}
		shadow.mu.Lock()
		allDone := true
		for i := range shadow.Blocks {
			status := shadow.Blocks[i].Status()
			if status == block.BlockStatusPending || status == block.BlockStatusDispatched {
				allDone = false
				break
			}
		}
		shadow.mu.Unlock()
		if allDone {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Log("warning: waitJobs timed out")
}
