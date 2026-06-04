# Target Highlighting (`==`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `==word==` precision target marks so users can right-click to tag specific words inside a BlockAnchor for AI attention, with correct markdown round-trip and Go AST extraction.

**Architecture:** The built-in `@tiptap/extension-highlight` Mark is extended with tiptap-markdown storage for `==...==` serialization; `markdown-it-mark` handles the parse side. The context menu "Highlight Target" action implements the full interaction matrix (wrap + mark, or mark-only). On the Go side, a new Goldmark inline parser for `==...==` creates `TargetHighlightNode`s, and an AST transformer walks `BlockAnchorNode` children to populate a `Targets []string` slice.

**Tech Stack:** `@tiptap/extension-highlight` (new dep), `markdown-it-mark` (new dep), tiptap-markdown mark storage API, ProseMirror transactions, Goldmark inline parser + AST transformer.

---

## File Map

| File | Change |
|------|--------|
| `frontend/tiptap-bundle-entry.js` | Install + export `@tiptap/extension-highlight` and `markdown-it-mark` |
| `frontend/src/static/vendor/tiptap.js` | Rebuilt bundle (do not edit directly — run `npm run bundle:tiptap`) |
| `frontend/src/static/extensions.js` | Add `HighlightMark` (extends `T.Highlight`) + expose on `T` |
| `frontend/src/static/editor.js` | Register `T.HighlightMark` in extensions array |
| `frontend/src/static/editor.css` | Add `mark` styles for normal + active states |
| `frontend/src/static/context-menu.js` | Add highlight SVG icon + "Highlight Target" action in `buildEditorItems` |
| `sieve/block_anchor.go` | Add `TargetHighlightNode`, inline parser, `Targets []string` on `BlockAnchorNode`, target-extraction AST transformer, `ParseBlockAnchors` public function |
| `sieve/block_anchor_test.go` | Tests for `==...==` parsing and `Targets` extraction |

---

## Task 1: Install packages and update the TipTap bundle

Install `@tiptap/extension-highlight` (official TipTap mark) and `markdown-it-mark` (the standard markdown-it plugin for `==...==`). Export both through the bundle so they're accessible to vanilla JS in `extensions.js`.

**Files:**
- Modify: `frontend/tiptap-bundle-entry.js`
- Rebuild: `frontend/src/static/vendor/tiptap.js`

- [ ] **Step 1: Install the two packages**

```bash
cd /home/stephen/Development/projects/sieve/frontend
npm install @tiptap/extension-highlight markdown-it-mark
```

Expected: both packages appear in `node_modules/@tiptap/extension-highlight` and `node_modules/markdown-it-mark`. `package.json` updated.

- [ ] **Step 2: Add exports to `tiptap-bundle-entry.js`**

The file currently ends with:

```js
export { Image } from '@tiptap/extension-image'
```

Add two more lines at the end:

```js
export { Highlight } from '@tiptap/extension-highlight'
export { default as markdownItMark } from 'markdown-it-mark'
```

- [ ] **Step 3: Rebuild the bundle**

```bash
cd /home/stephen/Development/projects/sieve/frontend
npm run bundle:tiptap
```

Expected: `frontend/src/static/vendor/tiptap.js` updated with no errors.

- [ ] **Step 4: Verify both exports land on `window.TipTap`**

Run `wails dev`, open the browser console and check:

```js
typeof window.TipTap.Highlight       // "function"
typeof window.TipTap.markdownItMark  // "function"
```

Expected: both `"function"`.

- [ ] **Step 5: Commit**

```bash
git add frontend/tiptap-bundle-entry.js frontend/src/static/vendor/tiptap.js package.json package-lock.json
git commit -m "feat(highlight): add @tiptap/extension-highlight and markdown-it-mark to bundle"
```

---

## Task 2: Add `HighlightMark` extension to `extensions.js`

Extend `T.Highlight` with tiptap-markdown storage so it round-trips through `==...==` in stored markdown. The `parse.setup` hook registers `T.markdownItMark` with the markdown-it instance.

**Files:**
- Modify: `frontend/src/static/extensions.js`

- [ ] **Step 1: Verify the file structure to find insertion points**

`extensions.js` is a single IIFE. The key sections are:
- `var T = window.TipTap` near the top
- `// ── Expose on window.TipTap ──` near the bottom (line ~601)

The `HighlightMark` definition goes immediately before the `// ── Expose` section.

- [ ] **Step 2: Add `HighlightMark`**

Insert before the `// ── Expose on window.TipTap ──` line (currently ~line 601):

```js
  // ── HighlightMark ──────────────────────────────────────────────────────────
  // Extends the built-in Highlight extension with tiptap-markdown storage so
  // ==word== round-trips correctly through the markdown serializer/parser.

  var HighlightMark = T.Highlight.extend({
    addStorage: function () {
      return {
        markdown: {
          serialize: {
            open: '==',
            close: '==',
            mixable: true,
            expelEnclosingWhitespace: true,
          },
          parse: {
            setup: function (md) {
              md.use(T.markdownItMark)
            },
          },
        },
      }
    },
  })
```

- [ ] **Step 3: Expose `HighlightMark` on `window.TipTap`**

Find the `// ── Expose on window.TipTap ──` block:

```js
  T.BlockNode = BlockNode
  T.Search = Search
  T.buildAiContext = buildAiContext
```

Add the new line:

```js
  T.BlockNode = BlockNode
  T.Search = Search
  T.buildAiContext = buildAiContext
  T.HighlightMark = HighlightMark
```

- [ ] **Step 4: Verify syntax is valid**

```bash
node --check /home/stephen/Development/projects/sieve/frontend/src/static/extensions.js
```

Expected: no output (clean parse).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/extensions.js
git commit -m "feat(highlight): add HighlightMark extending T.Highlight with == markdown serialization"
```

---

## Task 3: Register `HighlightMark` in `editor.js`

The extensions array in `editor.js` currently ends with `T.Image.configure(...)`. `HighlightMark` must be added before the `T.Markdown.configure` line so tiptap-markdown sees it when building the serializer/parser.

**Files:**
- Modify: `frontend/src/static/editor.js:96-113`

- [ ] **Step 1: Add `T.HighlightMark` to the extensions array**

Find the block (around line 96):

```js
      extensions: [
        T.StarterKit.configure({ link: false, codeBlock: false, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing…' : '' } }),
        T.BlockNode,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.Search,
        T.AiBlock,
        T.AiBlockLegacy,
        T.Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
      ].concat(T.getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
```

Add `T.HighlightMark,` after `T.Image.configure(...)` and before `].concat(...)`:

```js
      extensions: [
        T.StarterKit.configure({ link: false, codeBlock: false, history: { depth: 10000, newGroupDelay: 500 } }),
        T.Placeholder.configure({ placeholder: function (p) { return p.editor.isEmpty ? 'Start writing…' : '' } }),
        T.BlockNode,
        T.Table.configure({ resizable: false }),
        T.TableRow,
        T.TableHeader,
        T.TableCell,
        T.Search,
        T.AiBlock,
        T.AiBlockLegacy,
        T.Image.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
        T.HighlightMark,
      ].concat(T.getSieveNodes()).concat([
        T.TaskList,
        T.TaskItem.configure({ nested: true }),
        T.Markdown.configure({ html: true, transformPastedText: true, link: { openOnClick: false } }),
```

- [ ] **Step 2: Verify syntax is valid**

```bash
node --check /home/stephen/Development/projects/sieve/frontend/src/static/editor.js
```

Expected: no output.

- [ ] **Step 3: Manual smoke test**

Run `wails dev`, open a note. In the editor, type `==hello world==`. The text should display as plain text for now (CSS not added yet). Open the browser console and run:

```js
window._currentEditor.storage.markdown.getMarkdown()
```

Expected: the markdown contains `==hello world==`.

Now type `hello world` (plain), select it, and run:
```js
window._currentEditor.commands.setMark('highlight')
window._currentEditor.storage.markdown.getMarkdown()
```

Expected: markdown contains `==hello world==`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(highlight): register HighlightMark in editor extensions"
```

---

## Task 4: CSS for highlight mark states

Two visual states per the design doc:
- **Normal (chain present, not focused):** Subtle, always visible indicator that the word is AI-targeted. Use a warm amber underline to distinguish from search results (blue).
- **Active (chain focused):** Matches the `block-ref-active` visual language — accent-colored background + stronger indication.

**Files:**
- Modify: `frontend/src/static/editor.css`

- [ ] **Step 1: Find the insertion point**

Find the `/* ── Block target nodes ──` section (around line 585). The new rules should go directly after the `.block-node.block-ref-active` block (around line 605) to keep all block-anchor styles together.

- [ ] **Step 2: Add CSS rules**

Insert after the `.block-node.block-ref-active, .image-block.block-ref-active, .code-block-wrapper.block-ref-active { ... }` block:

```css
/* ── AI target highlight marks (==...==) ─────────────────────────────── */
/* Normal state: always visible as AI-targeted — amber underline.         */
/* Active state: prominent when parent block-anchor is focused.           */

.tiptap mark {
  background: transparent;
  border-radius: 2px;
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, #f59e0b 70%, transparent);
  text-decoration-style: dotted;
  text-underline-offset: 2px;
  color: inherit;
}

.block-ref-active mark,
.block-node.block-ref-active mark {
  background-color: color-mix(in srgb, #f59e0b 18%, transparent);
  text-decoration-color: #f59e0b;
  text-decoration-style: solid;
}
```

- [ ] **Step 3: Manual visual test**

With `wails dev` running, open a note. Type a word, select it, run in console:

```js
window._currentEditor.commands.setMark('highlight')
```

Expected: the word has a dotted amber underline. The surrounding paragraph has no special styling.

Click on an AI block that references this paragraph (if one exists). The highlighted word should get a solid amber underline + subtle amber background tint when `block-ref-active` is on the parent.

- [ ] **Step 4: Rebuild Tailwind (mark is not a Tailwind class — no Tailwind rebuild needed)**

The `.tiptap mark` selector uses plain CSS. Tailwind rebuild is not required.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor.css
git commit -m "feat(highlight): add CSS for highlight mark — dotted amber underline, active accent state"
```

---

## Task 5: "Highlight Target" context menu action

Add the action to `context-menu.js`. Implements the full interaction matrix from the design doc:

| Selection | In BlockAnchor? | Result |
|---|---|---|
| Whole node | No | Wrap in BlockAnchor — no `==` |
| Whole node | Yes | No-op |
| Word/phrase | No | Wrap parent paragraph in BlockAnchor AND apply `==` |
| Word/phrase | Yes | Apply `==` only |

**Files:**
- Modify: `frontend/src/static/context-menu.js`

- [ ] **Step 1: Add the highlight SVG icon to `IC`**

Find the `var IC = {` block (around line 11). Add a new icon entry (a marker/pen icon) at the end of the object before the closing `}`:

```js
    highlight:   svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/><line x1="15" y1="5" x2="18" y2="8"/>'),
```

(This is a pen/edit icon from Feather, distinct from the `edit` icon already present — the angled pen without the corner rectangle.)

- [ ] **Step 2: Add the "Highlight Target" action in `buildEditorItems`**

Find the AI section in `buildEditorItems` (around line 197):

```js
    items.push({ type: 'divider' })
    items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
```

Insert the "Highlight Target" item immediately BEFORE this divider:

```js
    if (hasSelection) {
      items.push({ icon: IC.highlight, label: 'Highlight Target', action: function () {
        var s = editor.state
        var sel = s.selection
        if (sel.empty) return

        // Detect if the selection covers the entire parent node (discounting whitespace)
        var $from = sel.$from
        var nodeStart = $from.start($from.depth)
        var nodeEnd = $from.end($from.depth)
        var coversNode =
          s.doc.textBetween(sel.from, sel.to).trim() ===
          s.doc.textBetween(nodeStart, nodeEnd).trim()

        // Detect if already inside a BlockAnchor (blockRef node)
        var inBlockAnchor = false
        for (var d = $from.depth; d >= 0; d--) {
          if ($from.node(d).type.name === 'blockRef') { inBlockAnchor = true; break }
        }

        if (coversNode && inBlockAnchor) {
          // No-op: block already defines the entire target
          return
        }

        if (coversNode && !inBlockAnchor) {
          // Wrap whole node in BlockAnchor only — no == mark needed
          var blockRef = 'blk-' + Math.random().toString(16).substring(2, 6)
          var blockRange = sel.$from.blockRange(sel.$to)
          if (blockRange) {
            var topRange = new T.NodeRange(blockRange.$from, blockRange.$to, 0)
            var tr = s.tr
            try {
              tr.wrap(topRange, [{ type: s.schema.nodes.blockRef, attrs: { id: blockRef } }])
              editor.view.dispatch(tr)
            } catch (e) { /* selection too complex to wrap */ }
          }
          return
        }

        // Word/phrase selected: apply == mark. Wrap parent in BlockAnchor first if not already.
        if (!inBlockAnchor) {
          var blockRef = 'blk-' + Math.random().toString(16).substring(2, 6)
          var blockRange = sel.$from.blockRange(sel.$to)
          if (blockRange) {
            var topRange = new T.NodeRange(blockRange.$from, blockRange.$to, 0)
            var tr = s.tr
            try {
              tr.wrap(topRange, [{ type: s.schema.nodes.blockRef, attrs: { id: blockRef } }])
              editor.view.dispatch(tr)
            } catch (e) { /* wrapping failed — still apply the mark */ }
          }
        }

        // Apply or toggle the highlight mark on the selection
        editor.commands.toggleMark('highlight')
        editor.commands.focus()
      }})
    }

    items.push({ type: 'divider' })
```

Note: `T.NodeRange` is already used by `buildAiContext` via `var NodeRange = T.NodeRange` inside that function. In `buildEditorItems`, reference it directly as `T.NodeRange` since `T` is in scope.

- [ ] **Step 3: Verify syntax is valid**

```bash
node --check /home/stephen/Development/projects/sieve/frontend/src/static/context-menu.js
```

Expected: no output.

- [ ] **Step 4: Manual interaction matrix test**

Run `wails dev`. For each case:

**Case A — word in plain paragraph:**
1. Type a paragraph with several words
2. Select one word
3. Right-click → "Highlight Target"
4. Expected: word has amber underline; paragraph is wrapped in a BlockAnchor (visible as `[!block] id="blk-..."` when switching to markdown mode)

**Case B — word already in BlockAnchor:**
1. Inside the BlockAnchor created in Case A, select a different word
2. Right-click → "Highlight Target"
3. Expected: new word gets amber underline; no additional BlockAnchor wrapper is added

**Case C — select entire paragraph in plain text:**
1. Select all text in a fresh paragraph (Ctrl+A selects from start to end of block)
2. Right-click → "Highlight Target"
3. Expected: paragraph wrapped in BlockAnchor; NO highlight mark applied

**Case D — select entire content already in BlockAnchor:**
1. Select all text of a paragraph already wrapped in BlockAnchor
2. Right-click → "Highlight Target"
3. Expected: no-op (nothing changes)

**Case E — toggle off:**
1. Right-click on an already-highlighted word → "Highlight Target"
2. Expected: highlight mark removed

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/context-menu.js
git commit -m "feat(highlight): add Highlight Target context menu action with full interaction matrix"
```

---

## Task 6: Backend — `TargetHighlightNode` and inline parser (Go)

Add an inline Goldmark parser for `==...==` that creates `TargetHighlightNode`s. Add `Targets []string` to `BlockAnchorNode`. Register both in `BlockAnchorExtension`.

**Files:**
- Modify: `sieve/block_anchor.go`
- Modify: `sieve/block_anchor_test.go`

- [ ] **Step 1: Write failing tests first**

Add the following tests to `sieve/block_anchor_test.go`, immediately after `TestBlockAnchorMultipleParagraphs`:

```go
func TestTargetHighlightNodeParsesMarker(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nThe patient showed ==acute== symptoms.\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no BlockAnchorNode found")
	}
	if len(anchor.Targets) != 1 {
		t.Fatalf("expected 1 target, got %d: %v", len(anchor.Targets), anchor.Targets)
	}
	if anchor.Targets[0] != "acute" {
		t.Errorf("expected target 'acute', got %q", anchor.Targets[0])
	}
}

func TestTargetHighlightNodeMultipleTargets(t *testing.T) {
	md := "[!block] id=\"blk-5678\"\n\nThe ==quick== brown ==fox== jumps.\n\n[!block-end]\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var anchor *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				anchor = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if anchor == nil {
		t.Fatal("no BlockAnchorNode found")
	}
	if len(anchor.Targets) != 2 {
		t.Fatalf("expected 2 targets, got %d: %v", len(anchor.Targets), anchor.Targets)
	}
	if anchor.Targets[0] != "quick" || anchor.Targets[1] != "fox" {
		t.Errorf("expected [quick fox], got %v", anchor.Targets)
	}
}

func TestTargetHighlightOutsideAnchorProducesNoTargets(t *testing.T) {
	// ==marks== outside a BlockAnchor don't crash and produce no BlockAnchorNode
	md := "The ==highlighted== word outside any anchor.\n"
	doc := mdParser().Parser().Parse(text.NewReader([]byte(md)))

	var found *BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				found = ba
				return ast.WalkStop, nil
			}
		}
		return ast.WalkContinue, nil
	})
	if found != nil {
		t.Error("unexpected BlockAnchorNode for content outside any anchor")
	}
}

func TestParseBlockAnchors(t *testing.T) {
	md := "[!block] id=\"blk-abc\"\n\nFoo ==bar== baz.\n\n[!block-end]\n\n[!block] id=\"blk-def\"\n\nNo targets here.\n\n[!block-end]\n"
	anchors := ParseBlockAnchors(md)
	if len(anchors) != 2 {
		t.Fatalf("expected 2 anchors, got %d", len(anchors))
	}
	byID := make(map[string]*BlockAnchorNode)
	for _, a := range anchors {
		byID[a.AnchorID] = a
	}
	if a := byID["blk-abc"]; a == nil || len(a.Targets) != 1 || a.Targets[0] != "bar" {
		t.Errorf("blk-abc: expected Targets=[bar], got %v", a)
	}
	if a := byID["blk-def"]; a == nil || len(a.Targets) != 0 {
		t.Errorf("blk-def: expected no targets, got %v", a.Targets)
	}
}
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -run "TestTargetHighlight|TestParseBlockAnchors" -v
```

Expected: `FAIL` with `undefined: TargetHighlightNode` or `anchor.Targets` not found (compilation errors / test failures). This confirms the tests are wired up.

- [ ] **Step 3: Add `Targets` to `BlockAnchorNode` and the new AST types**

In `sieve/block_anchor.go`, make the following changes:

**3a — Add `Targets` field to `BlockAnchorNode`:**

```go
// Before (current):
type BlockAnchorNode struct {
	ast.BaseBlock
	AnchorID string
}

// After:
type BlockAnchorNode struct {
	ast.BaseBlock
	AnchorID string
	Targets  []string
}
```

**3b — Add `TargetHighlightNode` type after `KindBlockAnchor`:**

```go
// TargetHighlightNode is an inline AST node representing a ==...== target mark.
// It stores the raw text content between the delimiters.
type TargetHighlightNode struct {
	ast.BaseInline
	Content string
}

func (n *TargetHighlightNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"Content": n.Content}, nil)
}

var KindTargetHighlight = ast.NewNodeKind("TargetHighlight")

func (n *TargetHighlightNode) Kind() ast.NodeKind { return KindTargetHighlight }
```

**3c — Add the inline parser:**

```go
// targetHighlightParser is a Goldmark inline parser for ==...== markers.
type targetHighlightParser struct{}

func (p *targetHighlightParser) Trigger() []byte { return []byte{'='} }

func (p *targetHighlightParser) Parse(parent ast.Node, reader text.Reader, pc parser.Context) ast.Node {
	line, _ := reader.PeekLine()
	if len(line) < 4 || line[0] != '=' || line[1] != '=' {
		return nil
	}
	rest := line[2:]
	end := bytes.Index(rest, []byte("=="))
	if end <= 0 {
		return nil
	}
	content := bytes.TrimSpace(rest[:end])
	if len(content) == 0 {
		return nil
	}
	reader.Advance(end + 4) // ==content== → 2 + end + 2
	return &TargetHighlightNode{Content: string(content)}
}
```

**3d — Add the AST transformer:**

```go
// blockAnchorTargetTransformer walks BlockAnchorNodes and collects
// all TargetHighlightNode text into the anchor's Targets slice.
type blockAnchorTargetTransformer struct{}

func (t *blockAnchorTargetTransformer) Transform(node *ast.Document, reader text.Reader, pc parser.Context) {
	_ = ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		ba, ok := n.(*BlockAnchorNode)
		if !ok {
			return ast.WalkContinue, nil
		}
		_ = ast.Walk(ba, func(child ast.Node, childEntering bool) (ast.WalkStatus, error) {
			if !childEntering {
				return ast.WalkContinue, nil
			}
			if ht, ok := child.(*TargetHighlightNode); ok {
				ba.Targets = append(ba.Targets, ht.Content)
			}
			return ast.WalkContinue, nil
		})
		return ast.WalkContinue, nil
	})
}
```

**3e — Add `ParseBlockAnchors` public function** (at the end of the file, after `BlockAnchorExtension`):

```go
// ParseBlockAnchors parses markdown and returns all BlockAnchorNodes,
// each with AnchorID and Targets populated.
func ParseBlockAnchors(markdown string) []*BlockAnchorNode {
	doc := mdParser().Parser().Parse(text.NewReader([]byte(markdown)))
	var anchors []*BlockAnchorNode
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if entering {
			if ba, ok := n.(*BlockAnchorNode); ok {
				anchors = append(anchors, ba)
			}
		}
		return ast.WalkContinue, nil
	})
	return anchors
}
```

**3f — Register the inline parser and AST transformer in `blockAnchorExtension.Extend()`:**

```go
// Before:
func (e *blockAnchorExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithBlockParsers(
			util.Prioritized(&blockAnchorParser{}, 100),
		),
	)
}

// After:
func (e *blockAnchorExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithBlockParsers(
			util.Prioritized(&blockAnchorParser{}, 100),
		),
		parser.WithInlineParsers(
			util.Prioritized(&targetHighlightParser{}, 50),
		),
		parser.WithASTTransformers(
			util.Prioritized(&blockAnchorTargetTransformer{}, 50),
		),
	)
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/stephen/Development/projects/sieve && go test ./sieve/... -run "TestTargetHighlight|TestParseBlockAnchors|TestBlockAnchor" -v
```

Expected: all tests PASS. The existing `TestBlockAnchor*` tests must still pass.

- [ ] **Step 5: Run the full test suite**

```bash
cd /home/stephen/Development/projects/sieve && go test ./... 2>&1 | tail -20
```

Expected: `ok  	sieve/sieve` (and all other packages). No failures.

- [ ] **Step 6: Compile check**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```

Expected: exits 0 with no output.

- [ ] **Step 7: Commit**

```bash
git add sieve/block_anchor.go sieve/block_anchor_test.go
git commit -m "feat(highlight): add TargetHighlightNode parser and Targets extraction to BlockAnchorNode"
```

---

## Self-Review

**Spec coverage check:**

| Design requirement | Covered |
|---|---|
| `==word==` as TipTap Mark, not raw chars | Task 2 (`HighlightMark` extends `T.Highlight`) |
| Markdown round-trip `==word==` | Task 2 (serialize `open/close: '=='`, parse via `T.markdownItMark`) |
| Highlight not in formatting toolbar | Task 3 (extension registered but no toolbar wiring) |
| Visual: dotted underline at rest | Task 4 (`.tiptap mark` CSS) |
| Visual: prominent when chain active | Task 4 (`.block-ref-active mark` CSS) |
| Right-click → "Highlight Target" | Task 5 |
| Interaction matrix (4 cases) | Task 5 |
| Auto-wrap in BlockAnchor if not present | Task 5 |
| Whole-node coverage detection | Task 5 (`coversNode` check) |
| No-op when whole node already in anchor | Task 5 |
| Go: `==...==` inline parser | Task 6 |
| Go: `Targets []string` on `BlockAnchorNode` | Task 6 |
| Go: targets populated by AST transformer | Task 6 |
| Go: `ParseBlockAnchors` public API | Task 6 |
| Tests for all Go behaviours | Task 6 |

**ContextProvider integration:** Intentionally deferred per design doc — it ships with the AI block migration. `ParseBlockAnchors` is the hook it will call.

**Placeholder scan:** No TBDs or "implement later" found.

**Type consistency:** `HighlightMark.name` is `'highlight'` in Task 2; `editor.commands.toggleMark('highlight')` in Task 5 uses the same name. `BlockAnchorNode.Targets` added in Task 6 step 3a and populated in 3d — consistent.
