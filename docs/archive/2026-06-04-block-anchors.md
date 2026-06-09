# Block Anchor Goldmark Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `BlockAnchorNode` as a first-class Goldmark container AST node so that `[!block] id="blk-XXXX"` … `[!block-end]` regions in the markdown are natively parsed as typed, walkable nodes with their children properly nested inside them.

**Architecture:** A Goldmark `BlockParser` (`blockAnchorParser`) fires when a line starts with `[`. Its `Open()` method matches `[!block] id="…"` and records the anchor ID; `Continue()` watches for `[!block-end]` and closes the node. The extension is added to `mdParser()` alongside the existing `SieveExtension`. The existing `sieveBlockASTTransformer` runs after parsing and will correctly promote `FencedCodeBlock` children of a `BlockAnchorNode` to `SieveBlockNode` — no changes needed there. No ContextProvider or AI context machinery is introduced in this plan; that is scoped to the AI Block migration plan.

**Tech Stack:** Go, `github.com/yuin/goldmark`, `github.com/yuin/goldmark/ast`, `github.com/yuin/goldmark/parser`, `github.com/yuin/goldmark/text`, `github.com/yuin/goldmark/util`

**Supersedes:** `docs/plan-block-anchors.md` sections 2A and 2B; this plan replaces Section 2C entirely (no `ExtractAnchorContent`).

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| CREATE | `sieve/block_anchor.go` | `BlockAnchorNode`, `blockAnchorParser`, `BlockAnchorExtension` |
| CREATE | `sieve/block_anchor_test.go` | Parsing correctness tests |
| MODIFY | `sieve/markdown_parser.go` | Add `BlockAnchorExtension` to `mdParser()` |

---

## Task 1: Create `BlockAnchorNode` and `blockAnchorParser`

**Files:**
- Create: `sieve/block_anchor.go`
- Test: `sieve/block_anchor_test.go`

- [ ] **Step 1: Write the failing test**

```go
// sieve/block_anchor_test.go
package sieve

import (
	"testing"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

func TestBlockAnchorParsesSimpleRegion(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content\n\n[!block-end]\n"
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

	if found == nil {
		t.Fatal("expected BlockAnchorNode, got nil")
	}
	if found.AnchorID != "blk-1234" {
		t.Errorf("expected AnchorID=blk-1234, got %q", found.AnchorID)
	}
}

func TestBlockAnchorHasChildren(t *testing.T) {
	md := "[!block] id=\"blk-1234\"\n\nSome content here\n\n[!block-end]\n"
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
		t.Fatal("no anchor found")
	}
	if anchor.ChildCount() == 0 {
		t.Error("expected anchor to have at least one child node")
	}
}

func TestBlockAnchorMissingIDIsIgnored(t *testing.T) {
	// [!block] without id= should NOT produce a BlockAnchorNode — falls through to plain text
	md := "[!block] notanid\n\nSome content\n\n[!block-end]\n"
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
		t.Error("expected no BlockAnchorNode for malformed anchor line")
	}
}

func TestBlockAnchorChildSieveBlockIsPromoted(t *testing.T) {
	// A fenced SieveBlock inside a BlockAnchor should be promoted to SieveBlockNode
	// by the existing sieveBlockASTTransformer.
	md := "[!block] id=\"blk-1234\"\n\n```code\nid: co-abcd\nstatus: COMPLETE\nsource: fmt.Println()\n```\n\n[!block-end]\n"
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
		t.Fatal("no anchor found")
	}

	var sieveChild *SieveBlockNode
	for child := anchor.FirstChild(); child != nil; child = child.NextSibling() {
		if sb, ok := child.(*SieveBlockNode); ok {
			sieveChild = sb
			break
		}
	}
	if sieveChild == nil {
		t.Error("expected SieveBlockNode child inside BlockAnchorNode")
	}
}

func TestBlockAnchorMultipleParagraphs(t *testing.T) {
	md := "[!block] id=\"blk-5678\"\n\nFirst paragraph.\n\nSecond paragraph.\n\n[!block-end]\n"
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
		t.Fatal("no anchor found")
	}
	if anchor.ChildCount() < 2 {
		t.Errorf("expected at least 2 children, got %d", anchor.ChildCount())
	}
}
```

- [ ] **Step 2: Run tests to confirm they all fail**

```bash
go test -tags webkit2_41 ./sieve/... -run TestBlockAnchor -v
```

Expected: compile error — `BlockAnchorNode` not defined.

- [ ] **Step 3: Implement `sieve/block_anchor.go`**

```go
package sieve

import (
	"bytes"
	"regexp"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// BlockAnchorNode is a Goldmark container AST node representing a
// [!block] id="…" … [!block-end] region.
// Its children are the parsed Markdown blocks within the region.
// Any fenced SieveBlocks inside will be promoted to SieveBlockNode by
// the existing sieveBlockASTTransformer.
type BlockAnchorNode struct {
	ast.BaseBlock
	AnchorID string
}

func (n *BlockAnchorNode) Dump(source []byte, level int) {
	ast.DumpHelper(n, source, level, map[string]string{"AnchorID": n.AnchorID}, nil)
}

// KindBlockAnchor is the unique Goldmark NodeKind for BlockAnchorNode.
var KindBlockAnchor = ast.NewNodeKind("BlockAnchor")

func (n *BlockAnchorNode) Kind() ast.NodeKind { return KindBlockAnchor }

// blockAnchorOpenRegex matches [!block] id="blk-XXXX" at the start of a line.
var blockAnchorOpenRegex = regexp.MustCompile(`^\[!block\]\s+id="([^"]+)"`)

// blockAnchorParser is a Goldmark BlockParser that recognises [!block] regions.
type blockAnchorParser struct{}

// Trigger returns '[' so the parser is only considered on lines starting with '['.
func (p *blockAnchorParser) Trigger() []byte { return []byte{'['} }

// Open fires when Goldmark encounters a line starting with '['.
// It returns the node and HasChildren if the line is a valid [!block] opener.
func (p *blockAnchorParser) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, _ := reader.PeekLine()
	match := blockAnchorOpenRegex.FindSubmatch(bytes.TrimRight(line, "\n\r"))
	if match == nil {
		return nil, parser.NoChildren
	}
	reader.Advance(len(line))
	return &BlockAnchorNode{AnchorID: string(match[1])}, parser.HasChildren
}

// Continue is called for each subsequent line while the node is open.
// It closes the node when it encounters [!block-end].
func (p *blockAnchorParser) Continue(node ast.Node, reader text.Reader, pc parser.Context) parser.State {
	line, _ := reader.PeekLine()
	if bytes.Equal(bytes.TrimSpace(line), []byte("[!block-end]")) {
		reader.Advance(len(line))
		return parser.Close
	}
	return parser.Continue | parser.HasChildren
}

// Close finalises the node. No action needed.
func (p *blockAnchorParser) Close(node ast.Node, reader text.Reader, pc parser.Context) {}

// CanInterruptParagraph returns true so [!block] can open without a preceding blank line.
func (p *blockAnchorParser) CanInterruptParagraph() bool { return true }

// CanAcceptIndentedCode returns false — the block anchor uses an explicit end marker.
func (p *blockAnchorParser) CanAcceptIndentedCode() bool { return false }

// blockAnchorExtension adds blockAnchorParser to a Goldmark Markdown instance.
type blockAnchorExtension struct{}

func (e *blockAnchorExtension) Extend(m goldmark.Markdown) {
	m.Parser().AddOptions(
		parser.WithBlockParsers(
			util.Prioritized(&blockAnchorParser{}, 100),
		),
	)
}

// BlockAnchorExtension is the Goldmark extension to register with goldmark.New().
var BlockAnchorExtension = &blockAnchorExtension{}
```

- [ ] **Step 4: Run tests — expect failures on `TestBlockAnchorChildSieveBlockIsPromoted` only**

```bash
go test -tags webkit2_41 ./sieve/... -run TestBlockAnchor -v
```

The SieveBlock child test will fail until `BlockAnchorExtension` is wired into `mdParser()` (Task 2), because `mdParser()` currently doesn't include the new extension, so `SieveExtension`'s transformer won't see the child.

The other four tests should pass.

- [ ] **Step 5: Commit**

```bash
git add sieve/block_anchor.go sieve/block_anchor_test.go
git commit -m "feat(block-anchor): add BlockAnchorNode and Goldmark BlockParser"
```

---

## Task 2: Wire `BlockAnchorExtension` into `mdParser()`

**Files:**
- Modify: `sieve/markdown_parser.go`

- [ ] **Step 1: Update `mdParser()`**

In `sieve/markdown_parser.go`, find the `mdParser()` function (currently at line 230):

```go
// Before
func mdParser() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(SieveExtension),
	)
}
```

Change to:

```go
// After
func mdParser() goldmark.Markdown {
	return goldmark.New(
		goldmark.WithExtensions(BlockAnchorExtension, SieveExtension),
	)
}
```

`BlockAnchorExtension` must come before `SieveExtension` so the block parser fires before the AST transformer runs. (Extensions are applied in order; the AST transformer runs as a post-parse step regardless, so order here primarily affects parser registration priority, not transform order — but listing it first is the correct semantic intent.)

- [ ] **Step 2: Run all block anchor tests — all five should now pass**

```bash
go test -tags webkit2_41 ./sieve/... -run TestBlockAnchor -v
```

Expected output:
```
--- PASS: TestBlockAnchorParsesSimpleRegion
--- PASS: TestBlockAnchorHasChildren
--- PASS: TestBlockAnchorMissingIDIsIgnored
--- PASS: TestBlockAnchorChildSieveBlockIsPromoted
--- PASS: TestBlockAnchorMultipleParagraphs
```

- [ ] **Step 3: Run the full sieve test suite**

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | tail -20
```

Expected: all existing tests still pass. If any existing test fails, investigate before proceeding — `BlockAnchorExtension` should be purely additive since it only fires on lines starting with `[!block]`.

- [ ] **Step 4: Build check**

```bash
go build -tags webkit2_41 ./...
```

Expected: compiles clean.

- [ ] **Step 5: Commit**

```bash
git add sieve/markdown_parser.go
git commit -m "feat(block-anchor): wire BlockAnchorExtension into mdParser"
```

---

## Verification

After both tasks are complete, confirm:

1. `ParseAllBlocks` does not return `BlockAnchorNode`s as `SieveBlock` entries (anchors have no Kind in the processor registry, so they are naturally excluded from the `if processor := GetProcessor(kind)` check in the transformer).
2. `InjectBlocks` leaves `[!block]` regions untouched (they are not `SieveNode`s, so the splice loop skips them).
3. Existing web-clip, code, smart-image, smart-link block parsing tests all pass.

```bash
go test -tags webkit2_41 ./sieve/... -v 2>&1 | grep -E "PASS|FAIL|ok"
```
