# Processor-Owned Segmentation Implementation Plan

> **STATUS — ✅ COMPLETE (closed out 2026-06-28).** Segmentation is a processor concern: a `Shape()` `(head,tail)` delimiter pair rides the `BlockProcessor` SerDes surface; one custom goldmark block parser recognises every registered shape as an opaque raw span (prose `<!--s:-->` blocks arrive whole, inner fences intact). `Deserialize` collapsed to first-acceptor-wins (prose last); `firstAcceptor`/`flushProse`/coalescing **deleted**. Full Go suite green. **Deferred follow-up (Stage E):** consolidate the two goldmark parsers + retire `markdown_parser.go`'s legacy `sieveBlockASTTransformer`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make document segmentation a processor concern — each processor declares the delimiter shape it relies on — so `DocumentCodec.Deserialize` collapses to "for each region, first acceptor wins (prose last)" and the `firstAcceptor`-exclusion / `flushProse` / coalescing complexity is deleted.

**Architecture:** Add a `Shape()` method to the `BlockProcessor` SerDes surface, supplied for free by the embedded `FencedDeserializer{Kind}` / `ProseProcessor` / `InlineDeserializer`. A single custom goldmark block parser, fed the union of registered shapes, recognises every shape (fenced `` ```kind `` and prose `<!--s:`) as an opaque raw AST node; the `RegionScanner` walks that AST into an ordered `[]Region`; the codec dispatches each region by first-`Accepts`-wins. Goldmark stays confined to the codec.

**Tech Stack:** Go; goldmark v1.8.2 (`github.com/yuin/goldmark`, already a dependency); `gopkg.in/yaml.v3` via the existing `fencedblock` helpers. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-06-20-processor-owned-segmentation-design.md`](../specs/2026-06-20-processor-owned-segmentation-design.md)

## Global Constraints

- **One uniform mechanism — no `fenced vs marker` categories.** Every block-mode processor registers the same `Shape()`; the segmenter and dispatch treat all shapes identically. (Memory: `feedback_prefer_uniform_patterns`.)
- **No loose/free functions.** Behaviour attaches to the owning type/service (CLAUDE.md design principle). The shape block parser is a type; its helpers are its methods.
- **TDD.** Every production change is preceded by a failing test that is watched fail.
- **Goldmark confined to the codec.** No code outside `sieve/block/` imports goldmark for this work; `markdown_parser.go`'s existing parser is NOT touched (consolidation is a separate follow-up, spec §5).
- **Verify before claiming done:** `go build ./...`, `go vet ./...`, `go test ./...`, `go test -race ./sieve/block/... ./sieve/services/`, and `cd frontend && npx vitest run`.
- **Commits:** one per task; NO `Co-Authored-By` trailer (memory `feedback_no_coauthor`). Stage explicit paths; never `git add -A` (untracked scratch exists in the repo root).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `sieve/block/processor_registry.go` (modify) | `RegionShape` type; `Shape()` on `BlockProcessor`; defaults on `FencedDeserializer` + `InlineDeserializer` | 1 |
| `sieve/block/processors/prose_processor.go` (modify) | `ProseProcessor.Shape()` → markers | 1 |
| `sieve/block/shape_block_parser.go` (create) | custom goldmark block parser + `shapeNode`; recognises all registered shapes as opaque raw spans | 2 |
| `sieve/block/region_scanner.go` (modify) | drive goldmark with the shape parser; `Scan` walks the AST → `[]Region` (shape spans + gap text) | 3 |
| `sieve/block/document_codec.go` (modify) | `Deserialize` = first-acceptor-wins with prose sorted last; delete `firstAcceptor`, `flushProse`, coalescing | 4 |
| `sieve/block/document_codec.go` / tests (modify) | delete now-dead helpers; regression sweep | 5 |

---

### Task 1: `Shape()` on the BlockProcessor SerDes surface

**Files:**
- Modify: `sieve/block/processor_registry.go`
- Modify: `sieve/block/processors/prose_processor.go`
- Test: `sieve/block/shape_test.go` (create), `sieve/block/processors/prose_shape_test.go` (create)

**Interfaces:**
- Produces: `type RegionShape struct { Kind, Head, Tail string }`; `RegionShape.IsZero() bool`; `BlockProcessor.Shape() RegionShape`. `FencedDeserializer{Kind:"diagram"}.Shape()` → `{Kind:"diagram", Head:"```diagram", Tail:"```"}`. `ProseProcessor.Shape()` → `{Kind:"prose", Head:"<!--s:", Tail:"<!--/s:"}`. `InlineDeserializer.Shape()` → zero value (no shape).

- [ ] **Step 1: Write the failing test** (`sieve/block/shape_test.go`):

```go
package block

import "testing"

func TestFencedDeserializer_Shape(t *testing.T) {
	s := FencedDeserializer{Kind: "diagram"}.Shape()
	if s.Kind != "diagram" || s.Head != "```diagram" || s.Tail != "```" {
		t.Fatalf("fenced shape: got %+v", s)
	}
	if s.IsZero() {
		t.Fatal("fenced shape must not be zero")
	}
}

func TestInlineDeserializer_Shape_isZero(t *testing.T) {
	if !(InlineDeserializer{}).Shape().IsZero() {
		t.Fatal("inline must declare no shape")
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./sieve/block/ -run 'Shape' -v`
Expected: FAIL — `RegionShape`/`Shape` undefined (compile error).

- [ ] **Step 3: Add the type + interface method + defaults** in `sieve/block/processor_registry.go`.

Add the type near the top of the file (after the imports):

```go
// RegionShape is the kind-qualified delimiter pair a processor relies on — the
// "angle brackets" that bound its on-disk regions. It rides with the SerDes
// (the code that writes <!--s:…--> is the code that finds it), so it is supplied
// for free by the embedded FencedDeserializer / ProseProcessor. A zero value
// (empty Head) means "I have no document region" — inline flavours.
type RegionShape struct {
	Kind string // the kind a matched region is tagged with (e.g. "diagram", "prose")
	Head string // opening token, kind-qualified (e.g. "```diagram", "<!--s:")
	Tail string // closing token (e.g. "```", "<!--/s:")
}

// IsZero reports that the processor declares no document region (inline flavours).
func (s RegionShape) IsZero() bool { return s.Head == "" }
```

Add `Shape()` to the `BlockProcessor` interface, immediately after the `Accepts`/`Deserialize` lines:

```go
	// Shape returns the kind-qualified delimiter pair this flavour's regions use
	// on disk — the segmentation half of recognition. Supplied for free by the
	// embedded FencedDeserializer (from Kind); inline flavours return a zero shape.
	Shape() RegionShape
```

Add the default on `FencedDeserializer` (after its `Deserialize` method):

```go
// Shape derives the fenced delimiter pair from Kind — every structured flavour
// gets ```Kind … ``` recognition for free by embedding.
func (d FencedDeserializer) Shape() RegionShape {
	return RegionShape{Kind: d.Kind, Head: "```" + d.Kind, Tail: "```"}
}
```

Add the default on `InlineDeserializer` (after its `Deserialize` method):

```go
// Shape: inline things are never document regions (Accepts is already false).
func (InlineDeserializer) Shape() RegionShape { return RegionShape{} }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `go test ./sieve/block/ -run 'Shape' -v`
Expected: PASS.

- [ ] **Step 5: Add `ProseProcessor.Shape()` + its failing test** (`sieve/block/processors/prose_shape_test.go`):

```go
package processors

import "testing"

func TestProseProcessor_Shape(t *testing.T) {
	s := (&ProseProcessor{}).Shape()
	if s.Kind != "prose" || s.Head != "<!--s:" || s.Tail != "<!--/s:" {
		t.Fatalf("prose shape: got %+v", s)
	}
}
```

Run: `go test ./sieve/block/processors/ -run TestProseProcessor_Shape -v`
Expected: FAIL — `ProseProcessor` has no `Shape` (it implements `BlockProcessor` directly, so the build for package `processors` now fails too).

- [ ] **Step 6: Implement `ProseProcessor.Shape()`** in `prose_processor.go` (next to `Accepts`):

```go
// Shape: prose regions are delimited by paired <!--s:ID--> / <!--/s:ID--> markers.
// Kind is "prose"; the markers are kind-blind so Head/Tail carry no id.
func (p *ProseProcessor) Shape() block.RegionShape {
	return block.RegionShape{Kind: block.KindProse, Head: "<!--s:", Tail: "<!--/s:"}
}
```

- [ ] **Step 7: Build everything (catches any other direct implementers)**

Run: `go build ./... && go test ./sieve/block/... -run 'Shape' -v`
Expected: build clean; tests PASS. (Fenced/inline processors inherit `Shape()` by embedding; prose now implements it. If `go build` flags another type missing `Shape()`, it is a test double — add the method to it the same way.)

- [ ] **Step 8: Commit**

```bash
git add sieve/block/processor_registry.go sieve/block/processors/prose_processor.go sieve/block/shape_test.go sieve/block/processors/prose_shape_test.go
git commit -m "Segmentation: Shape() joins the BlockProcessor SerDes surface"
```

---

### Task 2: Custom goldmark shape block parser

**Files:**
- Create: `sieve/block/shape_block_parser.go`
- Test: `sieve/block/shape_block_parser_test.go`

**Interfaces:**
- Consumes: `RegionShape` (Task 1).
- Produces: `type shapeNode struct { ast.BaseBlock; ShapeKind string; Start, Stop int }` with `kindShapeNode`; `newShapeParser(shapes []RegionShape) *shapeBlockParser` implementing `goldmark/parser.BlockParser`. A `shapeNode` carries the kind it matched and the exact source byte span `[Start, Stop)` (head line through tail line, including the trailing newline of the tail line when present).

**Behaviour to pin with tests:** given goldmark configured with this parser at priority 50 (ahead of fenced=700 / HTML=900), `<!--s:pr-1-->…<!--/s:pr-1-->` and `` ```diagram …``` `` each become ONE `shapeNode` whose `[Start,Stop)` slices the whole span; a `` ```java `` block (no registered shape) is NOT a `shapeNode`; an inner `` ``` `` inside a prose marker span is NOT split out.

- [ ] **Step 1: Write the failing test** (`sieve/block/shape_block_parser_test.go`):

```go
package block

import (
	"testing"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	gmparser "github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// shapesFor builds the two shapes used across these tests.
func shapesFor() []RegionShape {
	return []RegionShape{
		{Kind: "diagram", Head: "```diagram", Tail: "```"},
		{Kind: KindProse, Head: "<!--s:", Tail: "<!--/s:"},
	}
}

func parseShapeNodes(t *testing.T, src string, shapes []RegionShape) ([]*shapeNode, []byte) {
	t.Helper()
	md := goldmark.New(goldmark.WithParserOptions(
		gmparser.WithBlockParsers(util.Prioritized(newShapeParser(shapes), 50)),
	))
	source := []byte(src)
	root := md.Parser().Parse(text.NewReader(source))
	var nodes []*shapeNode
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(*shapeNode); ok {
			nodes = append(nodes, sn)
		}
		return ast.WalkContinue, nil
	})
	return nodes, source
}

func TestShapeParser_proseMarkerSpanIsOneOpaqueNode(t *testing.T) {
	src := "<!--s:pr-1-->\nSome notes.\n\n```mermaid\ngraph\n```\n\nMore.\n<!--/s:pr-1-->\n"
	nodes, source := parseShapeNodes(t, src, shapesFor())
	if len(nodes) != 1 {
		t.Fatalf("want 1 shape node, got %d", len(nodes))
	}
	if nodes[0].ShapeKind != KindProse {
		t.Fatalf("want prose, got %q", nodes[0].ShapeKind)
	}
	got := string(source[nodes[0].Start:nodes[0].Stop])
	want := "<!--s:pr-1-->\nSome notes.\n\n```mermaid\ngraph\n```\n\nMore.\n<!--/s:pr-1-->\n"
	if got != want {
		t.Fatalf("span mismatch:\n got %q\nwant %q", got, want)
	}
}

func TestShapeParser_registeredFenceIsANode_standardFenceIsNot(t *testing.T) {
	src := "```diagram\nid: dg-1\n```\n\n```java\nx();\n```\n"
	nodes, source := parseShapeNodes(t, src, shapesFor())
	if len(nodes) != 1 {
		t.Fatalf("want 1 shape node (diagram only), got %d", len(nodes))
	}
	if nodes[0].ShapeKind != "diagram" {
		t.Fatalf("want diagram, got %q", nodes[0].ShapeKind)
	}
	got := string(source[nodes[0].Start:nodes[0].Stop])
	if got != "```diagram\nid: dg-1\n```\n" {
		t.Fatalf("diagram span: got %q", got)
	}
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./sieve/block/ -run TestShapeParser -v`
Expected: FAIL — `newShapeParser` / `shapeNode` undefined.

- [ ] **Step 3: Implement the parser** (`sieve/block/shape_block_parser.go`). The "consume raw lines until the tail" loop mirrors goldmark's own `fencedCodeBlockParser`:

```go
package block

import (
	"strings"

	"github.com/yuin/goldmark/ast"
	gmparser "github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// shapeNode is the opaque AST block a matched shape produces: a kind-tagged span
// carrying its exact source byte range [Start,Stop). Its interior is NOT parsed —
// the whole span is taken verbatim, so an inner ``` inside a prose marker span is
// never split out.
type shapeNode struct {
	ast.BaseBlock
	ShapeKind string
	Start     int
	Stop      int
}

func (n *shapeNode) Dump(src []byte, level int) { ast.DumpHelper(n, src, level, nil, nil) }

var kindShapeNode = ast.NewNodeKind("SieveShape")

func (n *shapeNode) Kind() ast.NodeKind { return kindShapeNode }

// shapeBlockParser recognises every registered shape — fenced and marker alike —
// as one opaque raw block. ONE parser for all shapes (no fenced/marker split).
// Registered at priority < 700 so it wins over goldmark's fenced-code (700) and
// HTML-comment (900) parsers when a registered head opens.
type shapeBlockParser struct {
	shapes []RegionShape
}

func newShapeParser(shapes []RegionShape) *shapeBlockParser {
	return &shapeBlockParser{shapes: shapes}
}

// shapeParseState rides on the parser context while a span is open.
type shapeParseState struct {
	tail  string
	start int
	stop  int
}

var shapeStateKey = gmparser.NewContextKey()

// Trigger: the distinct first bytes of every registered head (e.g. '`' and '<').
func (p *shapeBlockParser) Trigger() []byte {
	seen := map[byte]bool{}
	var out []byte
	for _, s := range p.shapes {
		if s.Head == "" {
			continue
		}
		if b := s.Head[0]; !seen[b] {
			seen[b] = true
			out = append(out, b)
		}
	}
	return out
}

// matchHead returns the shape whose Head the trimmed line begins with, or false.
func (p *shapeBlockParser) matchHead(line string) (RegionShape, bool) {
	t := strings.TrimSpace(line)
	for _, s := range p.shapes {
		if s.Head != "" && strings.HasPrefix(t, s.Head) {
			return s, true
		}
	}
	return RegionShape{}, false
}

func (p *shapeBlockParser) Open(parent ast.Node, reader text.Reader, pc gmparser.Context) (ast.Node, gmparser.State) {
	line, segment := reader.PeekLine()
	shape, ok := p.matchHead(string(line))
	if !ok {
		return nil, gmparser.NoChildren
	}
	node := &shapeNode{ShapeKind: shape.Kind, Start: segment.Start, Stop: segment.Stop}
	pc.Set(shapeStateKey, &shapeParseState{tail: shape.Tail, start: segment.Start, stop: segment.Stop})
	reader.Advance(segment.Len())
	return node, gmparser.NoChildren
}

func (p *shapeBlockParser) Continue(node ast.Node, reader text.Reader, pc gmparser.Context) gmparser.State {
	st, _ := pc.Get(shapeStateKey).(*shapeParseState)
	line, segment := reader.PeekLine()
	if st == nil || line == nil {
		return gmparser.Close
	}
	st.stop = segment.Stop
	reader.Advance(segment.Len())
	if strings.HasPrefix(strings.TrimSpace(string(line)), st.tail) {
		return gmparser.Close
	}
	return gmparser.Continue | gmparser.NoChildren
}

func (p *shapeBlockParser) Close(node ast.Node, reader text.Reader, pc gmparser.Context) {
	if st, ok := pc.Get(shapeStateKey).(*shapeParseState); ok && st != nil {
		if sn, ok := node.(*shapeNode); ok {
			sn.Stop = st.stop
		}
	}
	pc.Set(shapeStateKey, nil)
}

// CanInterruptParagraph: a shape head may begin right after a paragraph line.
func (p *shapeBlockParser) CanInterruptParagraph() bool { return true }

// CanAcceptIndentedLine: heads are column-0; never open on an indented line.
func (p *shapeBlockParser) CanAcceptIndentedLine() bool { return false }
```

- [ ] **Step 4: Run the test; iterate on byte offsets if needed**

Run: `go test ./sieve/block/ -run TestShapeParser -v`
Expected: PASS. If a span is off by the final newline, adjust using `segment.Stop` (goldmark line segments include the trailing newline); the test asserts the exact bytes, so tighten until both span assertions pass.

- [ ] **Step 5: Commit**

```bash
git add sieve/block/shape_block_parser.go sieve/block/shape_block_parser_test.go
git commit -m "Segmentation: custom goldmark shape block parser (opaque raw spans)"
```

---

### Task 3: `RegionScanner` driven by shapes

**Files:**
- Modify: `sieve/block/region_scanner.go`
- Test: `sieve/block/region_scanner_test.go` (add cases; keep existing ones green)

**Interfaces:**
- Consumes: `newShapeParser` + `shapeNode` (Task 2), `RegionShape` (Task 1).
- Produces: `NewRegionScanner(shapes []RegionShape) *RegionScanner`; `(*RegionScanner).Scan(markdown string) []Region`. A registered shape span → `Region{Kind, Body, Raw}` (Body == Raw for shapes); the bytes between shape spans → text `Region{Kind:"", Body:Raw, Raw}`. Regions tile the source gaplessly.

- [ ] **Step 1: Write the failing test** (add to `region_scanner_test.go`):

```go
func TestScan_proseMarkerSpanWithInnerFence_isOneRegion(t *testing.T) {
	shapes := []RegionShape{
		{Kind: "diagram", Head: "```diagram", Tail: "```"},
		{Kind: KindProse, Head: "<!--s:", Tail: "<!--/s:"},
	}
	src := "intro\n\n<!--s:pr-1-->\na\n\n```mermaid\nx\n```\n\nb\n<!--/s:pr-1-->\n\nend\n"
	regions := NewRegionScanner(shapes).Scan(src)

	// Expect: [text "intro"][prose span][text "end"].
	if len(regions) != 3 {
		t.Fatalf("want 3 regions, got %d: %#v", len(regions), regions)
	}
	if regions[0].Kind != "" || !strings.Contains(regions[0].Raw, "intro") {
		t.Fatalf("region0: %#v", regions[0])
	}
	if regions[1].Kind != KindProse || !strings.Contains(regions[1].Raw, "```mermaid") {
		t.Fatalf("region1 must be the whole prose span incl inner fence: %#v", regions[1])
	}
	if regions[2].Kind != "" || !strings.Contains(regions[2].Raw, "end") {
		t.Fatalf("region2: %#v", regions[2])
	}
	// Gapless tiling: concatenating Raw reproduces the source.
	if regions[0].Raw+regions[1].Raw+regions[2].Raw != src {
		t.Fatalf("regions are not gapless")
	}
}
```

(Add `"strings"` to the test file imports if not already present.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./sieve/block/ -run TestScan_proseMarkerSpanWithInnerFence -v`
Expected: FAIL — `NewRegionScanner` now needs a `[]RegionShape` argument (compile error) and the new walk does not exist.

- [ ] **Step 3: Rewrite `region_scanner.go`** to drive goldmark with the shape parser and walk shape nodes. Replace the file body (keep the package + `Region` type doc) with:

```go
package block

import (
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	gmparser "github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Region is the portable unit the codec dispatches on (unchanged contract): a
// shape span carries its kind in Kind and its exact bytes in Raw (Body == Raw);
// a text run between spans has empty Kind. Regions tile the source gaplessly, so
// concatenating every Raw reproduces the input — that is what lets prose absorb
// an unclaimed fence verbatim.
type Region struct {
	Kind string
	Body string
	Raw  string
}

// RegionScanner splits markdown into ordered regions using the registered shapes.
// It is delimiter-aware but kind-blind: a shape's head tells it where a region is;
// what claims the region is the codec's job. goldmark is an implementation detail
// fully hidden behind Scan.
type RegionScanner struct {
	md goldmark.Markdown
}

// NewRegionScanner builds a scanner whose goldmark recognises the given shapes as
// opaque raw blocks (priority 50, ahead of fenced/HTML). Bytes no shape claims are
// parsed natively and surface as gap text.
func NewRegionScanner(shapes []RegionShape) *RegionScanner {
	md := goldmark.New(goldmark.WithParserOptions(
		gmparser.WithBlockParsers(util.Prioritized(newShapeParser(shapes), 50)),
	))
	return &RegionScanner{md: md}
}

// Scan returns gapless regions: each shape node becomes a kind-tagged region; the
// byte spans between shape nodes become text regions.
func (s *RegionScanner) Scan(markdown string) []Region {
	source := []byte(markdown)
	root := s.md.Parser().Parse(text.NewReader(source))

	// Collect shape nodes in document order (they are top-level blocks).
	var spans []*shapeNode
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		if sn, ok := n.(*shapeNode); ok {
			spans = append(spans, sn)
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})

	var regions []Region
	cursor := 0
	emitText := func(end int) {
		if end > cursor {
			raw := string(source[cursor:end])
			regions = append(regions, Region{Body: raw, Raw: raw})
		}
	}
	for _, sn := range spans {
		emitText(sn.Start)
		raw := string(source[sn.Start:sn.Stop])
		regions = append(regions, Region{Kind: sn.ShapeKind, Body: raw, Raw: raw})
		cursor = sn.Stop
	}
	emitText(len(source))
	return regions
}
```

(The old `fenceBounds`/`fenceBody`/`regionMDParser` are deleted with this rewrite.)

- [ ] **Step 4: Update `NewDocumentCodec` to pass shapes** so the package compiles. In `document_codec.go`, change the constructor:

```go
func NewDocumentCodec(reg ProcessorRegistry) *DocumentCodec {
	var shapes []RegionShape
	for _, p := range reg.Ordered() {
		if s := p.Shape(); !s.IsZero() {
			shapes = append(shapes, s)
		}
	}
	return &DocumentCodec{registry: reg, scanner: NewRegionScanner(shapes)}
}
```

- [ ] **Step 5: Run the new test + the existing scanner tests**

Run: `go test ./sieve/block/ -run 'TestScan|Region' -v`
Expected: the new test PASSES; pre-existing `region_scanner_test.go` cases still pass (they exercise fence/text tiling, which the new walk preserves). Fix any case that assumed the old vanilla-goldmark fence behaviour by registering the relevant shape in that test's scanner.

- [ ] **Step 6: Commit**

```bash
git add sieve/block/region_scanner.go sieve/block/document_codec.go sieve/block/region_scanner_test.go
git commit -m "Segmentation: RegionScanner driven by registered shapes (one walk, opaque spans)"
```

---

### Task 4: Collapse `DocumentCodec.Deserialize`

**Files:**
- Modify: `sieve/block/document_codec.go`
- Test: `sieve/block/processors/document_codec_test.go` (add cases; existing round-trip tests must stay green)

**Interfaces:**
- Consumes: `(*RegionScanner).Scan` (Task 3), `BlockProcessor.Accepts`/`Deserialize`/`Mode` (existing).
- Produces: `Deserialize` dispatches each region to the first processor whose `Accepts` returns true, with the prose (terminal) processor sorted LAST so its always-true `Accepts` never shadows a structured recogniser. `firstAcceptor`, `flushProse`, and the `pending` coalescing loop are deleted.

- [ ] **Step 1: Write the failing test** (`document_codec_test.go`, package `processors`):

```go
func TestCodec_proseBlockContainingFence_roundTripsAsOneBlock(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("diagram", &block.FencedProc{Kind: "diagram"}) // see note
	t.Cleanup(resetRegistry)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	src := "<!--s:pr-1-->\nNotes.\n\n```mermaid\ngraph\n```\n\nMore.\n<!--/s:pr-1-->"
	blocks, err := codec.Deserialize(src)
	if err != nil {
		t.Fatalf("deserialize: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].ID != "pr-1" || blocks[0].Kind != block.KindProse {
		t.Fatalf("want prose pr-1, got id=%q kind=%q", blocks[0].ID, blocks[0].Kind)
	}
	if !strings.Contains(blocks[0].Content(), "```mermaid") {
		t.Fatalf("inner fence lost: %q", blocks[0].Content())
	}
}
```

NOTE on the test double: package `processors` already has helpers for the real registry; if no exported fenced test processor exists, register a real one (e.g. `NewAIBlockProcessor(block.BlockServices{})` under `"ai-block"` and use a `` ```ai-block `` instead of `diagram`) rather than inventing `FencedProc`. Pick whichever matches the existing test helpers; the assertion (one prose block, id preserved, inner fence intact) is unchanged.

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./sieve/block/processors/ -run TestCodec_proseBlockContainingFence -v`
Expected: PASS already if the scanner change alone fixed it — but it must still go through the NEW dispatch. If it fails, it is because the old `firstAcceptor`/`flushProse` path is still wired. Proceed to Step 3 regardless to delete that path.

- [ ] **Step 3: Rewrite `Deserialize` + delete the dead helpers** in `document_codec.go`:

```go
// Deserialize parses markdown into an ordered block slice. The scanner (driven by
// registered shapes) yields gapless regions; each region goes to the first
// processor whose Accepts claims it. The terminal prose processor sorts LAST, so
// its always-true Accepts mops up gap text and unsupported fences without ever
// shadowing a structured recogniser. No coalescing: a shape span already arrives
// whole, so a prose block containing a fence is one region.
func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error) {
	ordered := c.orderedProseLast()
	var out []SieveBlock
	for _, region := range c.scanner.Scan(markdown) {
		p := firstAccepting(ordered, region)
		if p == nil {
			return nil, fmt.Errorf("DocumentCodec: no processor accepted region kind %q (prose terminal missing?)", region.Kind)
		}
		blocks, err := p.Deserialize(region)
		if err != nil {
			return nil, err
		}
		out = append(out, blocks...)
	}
	return out, nil
}

// orderedProseLast returns the registry's processors with the terminal prose
// (BlockModeProse) flavour moved to the end, so first-acceptor dispatch lets
// structured recognisers win and prose mops up the rest.
func (c *DocumentCodec) orderedProseLast() []BlockProcessor {
	all := c.registry.Ordered()
	out := make([]BlockProcessor, 0, len(all))
	var prose []BlockProcessor
	for _, p := range all {
		if p.Mode() == BlockModeProse {
			prose = append(prose, p)
			continue
		}
		out = append(out, p)
	}
	return append(out, prose...)
}

// firstAccepting returns the first processor (in the given order) that claims the
// region, or nil.
func firstAccepting(ordered []BlockProcessor, region Region) BlockProcessor {
	for _, p := range ordered {
		if p.Accepts(region) {
			return p
		}
	}
	return nil
}
```

Then DELETE from the file: the old `Deserialize` body's `pending`/`flushProse` machinery and the `firstAcceptor` method (the prose-excluding one). Keep `Serialize`, `serializeBlock`, `serializeFencedBlock`, the `ProcessorRegistry` interface, and `registryAdapter`. Ensure `"fmt"` stays imported (now used by the new error).

`firstAccepting` is a free function on `Region`/`[]BlockProcessor`; to honour the no-loose-functions rule, prefer making it a method: `func (c *DocumentCodec) firstAccepting(ordered []BlockProcessor, region Region) BlockProcessor`. Use the method form.

- [ ] **Step 4: Run the new test + the full codec suite**

Run: `go test ./sieve/block/processors/ -run 'Codec|RoundTrip|Deserialize' -v`
Expected: the new test PASSES; existing round-trip/codec tests stay green. The prose-terminal ordering means a gap region (Kind "") and a `<!--s:` region (Kind "prose") both reach `ProseProcessor.Accepts` (true) and are parsed by `scanProseRegion` exactly as before.

- [ ] **Step 5: Commit**

```bash
git add sieve/block/document_codec.go sieve/block/processors/document_codec_test.go
git commit -m "Segmentation: Deserialize = first-acceptor-wins (prose last); delete coalescing"
```

---

### Task 5: Delete dead code + full regression

**Files:**
- Modify: `sieve/block/document_codec.go` (remove any now-unused helper), `sieve/block/region_scanner.go` (confirm old fence helpers gone)
- Test: whole suite

- [ ] **Step 1: Confirm no dead references remain**

Run: `go vet ./... && grep -rn "firstAcceptor\|flushProse\|fenceBounds\|fenceBody\|regionMDParser" sieve/`
Expected: `go vet` clean; grep returns NOTHING (all deleted). If grep hits a test, update that test to the new API.

- [ ] **Step 2: Full Go verification**

Run: `go build ./... && go test ./... && go test -race ./sieve/block/... ./sieve/services/`
Expected: all green.

- [ ] **Step 3: Frontend tests (unchanged, but prove no coupling broke)**

Run: `cd frontend && npx vitest run`
Expected: all pass (this change is backend-only; the count should match the pre-change baseline).

- [ ] **Step 4: Manual round-trip sanity on a real fixture** (optional but recommended) — open the app (`wails dev`), confirm a note with a structured block + prose round-trips on save, and that a code sample (` ```java `) typed in prose stays inside its prose block. (Memory `project_test_perf_in_wails_app`: verify in the WebKitGTK app, not just a dev server.)

- [ ] **Step 5: Commit (if Step 1 required test edits) + update tech-debt**

Mark tech-debt **S-B** resolved in `docs/TECH-DEBT.md` (the `DocumentCodec.Deserialize` prose-fallback confusion is gone: no `firstAcceptor`/`flushProse`/coalescing). Then:

```bash
git add sieve/ docs/TECH-DEBT.md
git commit -m "Segmentation: retire S-B (codec prose-fallback) — dead code removed, suite green"
```

---

## Self-review notes

- **Spec coverage:** §3.1 Shape on interface → Task 1. §3.2 single custom goldmark parser → Task 2. scanner walk → Task 3. §3.3 first-acceptor dispatch + §3.5 deletions → Task 4. §3.4 prose-not-shredded → Task 2/4 tests. §4 invariants (opaque interior, column-0/indent) → exercised by Task 2/4 fence-in-prose tests. §6 containers → out of scope (noted). §5 consolidation → out of scope (markdown_parser.go untouched).
- **Prose terminal ordering:** the one place prose is "special" is `orderedProseLast` — a single explicit ordering rule reflecting prose's genuine catch-all role, NOT a per-region branch (uniform loop preserved; memory `feedback_prefer_uniform_patterns`).
- **Risk:** Task 2's byte-offset capture (`segment.Start`/`Stop`, trailing newline) is the one place to expect iteration — the tests assert exact spans, so the cycle catches it. Priority 50 must stay below goldmark's fenced (700) / HTML (900) parsers.
