# Promote-to-Document: Block Anchor Chain Continuity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a sieve block is promoted to a document, wrap the promoted markdown in a `[!block] id="<blockID>"…[!block-end]` anchor so that downstream AI chains referencing that block ID continue to find context after promotion.

**Architecture:** Go wraps the `MarkdownRepresentation()` result in a block anchor before substituting it into the markdown file; the frontend discards its surgical node-swap and calls the existing `softReloadContent()` instead, which fetches the updated markdown and re-runs TipTap's full parse pipeline (including the `blockRef` `updateDOM` step that converts `[!block]` syntax into a proper `blockRef` node).

**Tech Stack:** Go (`sieve` package), vanilla JS (TipTap editor), existing `BlockAnchorProvider` / `FindBlockByID` / `softReloadContent` infrastructure — no new dependencies.

---

## Files

| File | Change |
|---|---|
| `sieve/editor_service.go` | Wrap replacement in block anchor before calling `PromoteBlock()` and before notifying the frontend |
| `frontend/src/static/editor.js` | Replace surgical `insertContentAt` swap with `softReloadContent(currentUuid)` |
| `sieve/editor_service_promote_test.go` | New test file: `TestEditorService_PromoteBlock_wrapsInBlockAnchor` |

---

## Task 1: Write the failing Go test

**Files:**
- Create: `sieve/editor_service_promote_test.go`

- [ ] **Create the test file** with this exact content:

```go
package sieve

import (
	"strings"
	"testing"
)

// testMarkdownProcessor returns a fixed MarkdownRepresentation so we can
// assert the block anchor wrapper without depending on any real processor.
type testMarkdownProcessor struct{ md string }

func (p *testMarkdownProcessor) InitAttrs(id string, _ map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"id": id}
}
func (p *testMarkdownProcessor) PasteMatch(_ []PasteEntry, _, _ string) (bool, map[string]interface{}) {
	return false, nil
}
func (p *testMarkdownProcessor) RunJob(_ JobContext) error         { return nil }
func (p *testMarkdownProcessor) JobLabel(_ *SieveBlock) string     { return "" }
func (p *testMarkdownProcessor) OnChange(_ *SieveBlock)            {}
func (p *testMarkdownProcessor) Mode() BlockMode                   { return BlockModeBlock }
func (p *testMarkdownProcessor) BuildContext(_ SieveBlock, _ ShadowDocument, _ map[string]bool) string {
	return ""
}
func (p *testMarkdownProcessor) MarkdownRepresentation(_ SieveBlock) string { return p.md }

func TestEditorService_PromoteBlock_wrapsInBlockAnchor(t *testing.T) {
	RegisterProcessor("test-md", &testMarkdownProcessor{md: "promoted content"})
	t.Cleanup(func() { UnregisterProcessor("test-md") })

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte("Before\n\n```test-md\nid: tm-0001\n```\n\nAfter"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	_ = es.Open(uuid, nil)
	es.UpdateMarkdown(uuid, "Before\n\n```test-md\nid: tm-0001\n```\n\nAfter")

	if err := es.PromoteBlock(uuid, "tm-0001"); err != nil {
		t.Fatalf("PromoteBlock: %v", err)
	}

	// The markdown saved to disk must contain the block anchor wrapper.
	saved, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	body := string(saved.Body())

	if !strings.Contains(body, `[!block] id="tm-0001"`) {
		t.Errorf("expected block anchor header in saved markdown, got:\n%s", body)
	}
	if !strings.Contains(body, "promoted content") {
		t.Errorf("expected promoted content in saved markdown, got:\n%s", body)
	}
	if !strings.Contains(body, "[!block-end]") {
		t.Errorf("expected [!block-end] in saved markdown, got:\n%s", body)
	}
	if strings.Contains(body, "```test-md") {
		t.Errorf("expected original fence to be gone, got:\n%s", body)
	}
	if !strings.Contains(body, "Before") || !strings.Contains(body, "After") {
		t.Errorf("expected surrounding prose to be preserved, got:\n%s", body)
	}
}
```

- [ ] **Run the test to confirm it fails:**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/ -run TestEditorService_PromoteBlock_wrapsInBlockAnchor -v
```

Expected: FAIL — the saved markdown will contain `promoted content` but NOT the `[!block]` wrapper (yet).

---

## Task 2: Implement the Go change

**Files:**
- Modify: `sieve/editor_service.go:728-745`

- [ ] **Replace the current `replacement` lines in `EditorService.PromoteBlock()`.**

Current code (lines 728–745):
```go
replacement := processor.MarkdownRepresentation(blkCopy)
if replacement == "" {
    return fmt.Errorf("block cannot be promoted")
}

shadow.mu.Lock()
newMarkdown, ok := PromoteBlock(shadow.Markdown, blockID, replacement)
if !ok {
    shadow.mu.Unlock()
    return fmt.Errorf("block not found in markdown AST")
}
shadow.Markdown = newMarkdown
delete(shadow.Blocks, blockID)
shadow.resetDebounce()
shadow.mu.Unlock()

_ = es.Flush(uuid)
es.notifyBlockPromoted(uuid, blockID, replacement)
return nil
```

Replace with:
```go
plainContent := processor.MarkdownRepresentation(blkCopy)
if plainContent == "" {
    return fmt.Errorf("block cannot be promoted")
}

markdownReplacement := fmt.Sprintf("[!block] id=%q\n%s\n[!block-end]", blockID, plainContent)

shadow.mu.Lock()
newMarkdown, ok := PromoteBlock(shadow.Markdown, blockID, markdownReplacement)
if !ok {
    shadow.mu.Unlock()
    return fmt.Errorf("block not found in markdown AST")
}
shadow.Markdown = newMarkdown
delete(shadow.Blocks, blockID)
shadow.resetDebounce()
shadow.mu.Unlock()

_ = es.Flush(uuid)
es.notifyBlockPromoted(uuid, blockID, plainContent)
return nil
```

Note: `notifyBlockPromoted` still receives `plainContent` (not wrapped). The frontend does a full soft reload — it doesn't need the anchor syntax.

- [ ] **Add `fmt` to imports if it isn't already there** — check the top of `editor_service.go`:

```bash
head -20 /home/stephen/Development/projects/sieve/sieve/editor_service.go
```

`fmt` is almost certainly already imported. If not, add it to the import block.

- [ ] **Run the failing test again to confirm it now passes:**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/ -run TestEditorService_PromoteBlock_wrapsInBlockAnchor -v
```

Expected: PASS

- [ ] **Run the full sieve package tests to check for regressions:**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/ -v 2>&1 | tail -30
```

Expected: all PASS. If `TestPromoteBlock_replacesBlockWithContent` still passes, the core `PromoteBlock()` function in `markdown_parser.go` is unaffected (it was not changed).

- [ ] **Compile-check the full project:**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```

Expected: no errors.

- [ ] **Commit:**

```bash
cd /home/stephen/Development/projects/sieve && git add sieve/editor_service.go sieve/editor_service_promote_test.go && git commit -m "feat(promote): wrap promoted block in [!block] anchor to preserve chain refs"
```

---

## Task 3: Update the JS handler

**Files:**
- Modify: `frontend/src/static/editor.js:329-348`

- [ ] **Replace the `block-promoted` handler block.**

Current code (lines 329–348):
```js
if (msg.type === 'block-promoted') {
  if (!msg.id || !msg.replacement || !currentEditor) return
  var promotedId = msg.id
  var promotedHtml = currentEditor.storage.markdown.parser.md.render(msg.replacement)
  var nodePos = null
  var nodeSize = null
  currentEditor.state.doc.descendants(function (node, pos) {
    if (node.type.name.startsWith('sieve-') && node.attrs.id === promotedId) {
      nodePos = pos
      nodeSize = node.nodeSize
      return false
    }
  })
  if (nodePos !== null) {
    currentEditor.commands.insertContentAt(
      { from: nodePos, to: nodePos + nodeSize },
      promotedHtml + '<p></p>'
    )
  }
}
```

Replace with:
```js
if (msg.type === 'block-promoted') {
  softReloadContent(currentUuid)
}
```

`softReloadContent` (defined at line ~809) fetches Go's authoritative markdown from `/api/editor/load`, calls `editor.commands.setContent(body)` which runs TipTap's full markdown pipeline including the `blockRef` `updateDOM` step, and restores cursor position.

- [ ] **Verify the file looks correct around the edit:**

```bash
sed -n '325,355p' /home/stephen/Development/projects/sieve/frontend/src/static/editor.js
```

Expected: the handler is now 3 lines, no references to `promotedId`, `promotedHtml`, `nodePos`, `nodeSize`, or `insertContentAt`.

- [ ] **Commit:**

```bash
cd /home/stephen/Development/projects/sieve && git add frontend/src/static/editor.js && git commit -m "feat(promote): soft-reload editor on block-promoted to correctly parse block anchor"
```

---

## Task 4: Manual verification

- [ ] **Start the dev server:**

```bash
cd /home/stephen/Development/projects/sieve && wails dev
```

- [ ] **Create an AI block and wait for it to complete** (status COMPLETE with a response).

- [ ] **Create a second AI block with `ref:` pointing to the first block's ID** — e.g. ask a follow-up question that uses the first block as context. Verify the second block resolves with context from the first.

- [ ] **Right-click the first (completed) AI block → "Promote to Document".** Verify:
  1. The fenced `ai-block` node disappears from the editor
  2. The promoted response text is visible in the document, wrapped in a block anchor container (invisible div — no visual border expected)
  3. No console errors in the browser DevTools

- [ ] **Check the raw markdown file on disk** to confirm the block anchor was written:

```bash
# Find the file — list recent .md files in the sieve data directory
ls -lt ~/.local/share/sieve/notes/ | head -5
# Then cat the relevant file and look for [!block]
grep -A5 "\[!block\]" ~/.local/share/sieve/notes/<uuid>.md
```

Expected: `[!block] id="ai-XXXX"` followed by the promoted content, then `[!block-end]`.

- [ ] **Trigger the second AI block again (retry/re-ask)** and confirm it still receives context from the promoted content. Verify the response makes sense given the first block's content.
