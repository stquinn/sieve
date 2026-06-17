# Sieve Block Document Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot Sieve from "markdown is the model" to "blocks are the model" — a uniform, ordered, addressable block tree where markdown is a storage serialization produced by one backend spine, delivered as a staged cutover (Go-testable core first).

**Architecture:** A new ordered `BlockDoc` tree of `DocBlock`s replaces the flat `markdown + map[id]*SieveBlock` pair. A single backend serialization spine (`ParseBlockDoc` / `SerializeBlockDoc`) round-trips the tree against markdown, retiring the `InjectBlocks` byte-splice (markdown_parser.go:321) and, later, the JS document-level serializer. Prose travels as markdown content per block; ProseMirror stays confined to the frontend; the Store seam owns persistence. Migration is a one-time internal cutover (NOT strangler) — no backward-compat shims; intermediate stages need only compile + pass tests, and the app is runnable end-to-end again from Stage D.

**Tech Stack:** Wails v2 + Go + chi + HTMX; goldmark (markdown AST), `gopkg.in/yaml.v3`, the existing `sieve/fencedblock` literal-style YAML machinery; TipTap/ProseMirror (frontend only). No React. No new npm deps.

**Spec:** [`docs/superpowers/specs/2026-06-17-block-document-model-design.md`](../specs/2026-06-17-block-document-model-design.md)

---

## Fidelity note (read before executing)

This plan commits to the full pivot but front-loads fidelity honestly, per spec §11:

- **Stage A** — fully bite-sized, execution-ready now (real Go code + TDD steps). It is the Go-testable serialization core, built in isolation and **not wired into the running app** — zero behavior change on completion.
- **Stages B–F** — roadmapped: file maps, interfaces, task outlines, exit criteria, dependencies. **Bite-size each just-in-time** when its predecessor lands, because exact code depends on what earlier stages create (and Stage F's live lineage couples to the separate reconciler project, spec §13). Writing exact code for them now would be fabrication.

Each stage compiles and passes its tests on its own; the app becomes runnable end-to-end again at Stage D.

---

## Scope note

The spec's stages are **sequential, not independent subsystems** — each builds on the prior (model → handles → wire → native frontend → containers → lenses). This is therefore **one plan with staged fidelity**, mirroring the precedent `2026-06-11-editor-layout-engine.md` plan, rather than separate per-subsystem plans.

---

## File map (whole arc)

| File | Responsibility | Stage |
|---|---|---|
| `sieve/block_document.go` *(new)* | `DocBlock` / `BlockDoc` types; `ParseBlockDoc` / `SerializeBlockDoc` serialization spine | A |
| `sieve/block_document_test.go` *(new)* | Go round-trip tests for the spine | A |
| `sieve/block_document.go` | Per-paragraph prose split; `{id=}` handle attach/strip; bijection | B |
| `sieve/handle_anchor.go` *(new)* | `{id=}` anchor parse/emit on prose (goldmark inline or pre/post pass) | B |
| `sieve/editor_service.go` | Swap `ShadowDocument` flush from `InjectBlocks` to the spine; handle-set + ref GC | B, C |
| `ws_handler.go` / `sse.go` (verify path) | Block-op envelope over WS (`create/update/delete/reorder/move`) | C |
| `frontend/src/static/editor.js` | Prose transaction observer → debounced `update-block`; consume block list | C, D |
| `frontend/src/static/block-anchor-view.js` *(new)* | `BlockAnchor` transparent `contentDOM` renderer (blockRef successor) | D |
| `sieve/block_document.go` | By-value container expansion (`column-row` → `DocBlock.Children`) | E |
| `frontend/src/static/column-row-renderer.js` *(from layout plan)* | container NodeView | E |
| `sieve/block_index.go` *(new)* | server-side tree search + structured-facet index | F |
| `frontend/src/static/lineage-gutter.js` / `doc-map.js` *(from layout plan)* | lineage lenses | F |

---

## Stage A — Backend block model + serialization spine

**Goal:** an ordered `BlockDoc` tree and a single spine that round-trips it against markdown, proven by Go tests in isolation. **No wiring into the app** — `ShadowDocument`/`InjectBlocks` are untouched this stage.

**Scope boundary (deliberate):** Stage A handles **prose runs** (verbatim markdown between top-level fenced blocks) + **top-level structured fenced blocks**. The `DocBlock.Children` tree *type* exists but is not yet populated — `column-row` is round-tripped as an opaque structured block (its by-value child expansion lands in Stage E, and is already separately proven by `columnrow_serializer_test.go`). Per-paragraph prose granularity + `{id=}` handles land in Stage B. This keeps the core spine small and fully testable.

**Exit criteria:**
- `ParseBlockDoc(md)` yields an ordered `BlockDoc`: one `DocBlock{Kind:"prose"}` per prose run, one structured `DocBlock{ID,Kind,Attrs}` per top-level fence.
- `SerializeBlockDoc(doc)` reproduces canonical markdown.
- `serialize → parse → serialize` is byte-stable on a mixed document including a `column-row` fence.
- `go test ./sieve/ -run BlockDoc` is green; the rest of the suite is unaffected.

### Task A1: `DocBlock` / `BlockDoc` types

**Files:**
- Create: `sieve/block_document.go`

- [ ] **Step 1: Create the types and kind constants.**

```go
package sieve

// DocBlock is a node in the unified, ordered block tree (spec §2). It supersedes
// the flat map[id]*SieveBlock model for serialization. Which payload field is
// meaningful depends on Kind:
//   - prose kinds      → Content holds verbatim markdown; Attrs/Children nil
//   - structured kinds → Attrs holds the fenced YAML payload; Content ""; Children nil
//   - container kinds  → Children holds the subtree; Attrs may hold layout (e.g. widths)
//
// ID is the block's primary handle. In Stage A prose blocks have an empty ID
// (positional); Stage B assigns universal {id=} handles.
type DocBlock struct {
	ID       string
	Kind     string
	Content  string
	Attrs    map[string]interface{}
	Children []DocBlock
}

// BlockDoc is an ordered list of top-level blocks — a tree wherever containers
// nest Children. It is the in-memory form the serialization spine round-trips
// against markdown.
type BlockDoc struct {
	Blocks []DocBlock
}

// Reserved kinds that are not registered BlockProcessors.
const (
	KindProse     = "prose"
	KindColumnRow = "column-row"
	KindColumn    = "column"
)
```

- [ ] **Step 2: Verify it compiles.**

Run: `go build ./sieve/`
Expected: no output (success). No name collisions (`DocBlock`/`BlockDoc`/`KindProse` are new).

- [ ] **Step 3: Commit.**

```bash
git add sieve/block_document.go
git commit -m "Block model: DocBlock/BlockDoc types + kind constants"
```

### Task A2: `SerializeBlockDoc` (registry-free fence serialization)

**Files:**
- Modify: `sieve/block_document.go`
- Create: `sieve/block_document_test.go`

- [ ] **Step 1: Write the failing test.**

```go
package sieve

import "testing"

func TestSerializeBlockDoc_ProseAndFence(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "Hello."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{
			"id":     "co-1",
			"source": "x = 1",
		}},
	}}
	got, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	if got != want {
		t.Fatalf("serialize mismatch:\n got: %q\nwant: %q", got, want)
	}
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `go test ./sieve/ -run TestSerializeBlockDoc_ProseAndFence -v`
Expected: FAIL — `undefined: SerializeBlockDoc`.

- [ ] **Step 3: Implement `SerializeBlockDoc` + `serializeFencedBlock`.** Add to `sieve/block_document.go` (and add `"strings"` and `"sieve/sieve/fencedblock"` to imports):

```go
// SerializeBlockDoc assembles markdown from the block tree — the single
// serialization spine that replaces InjectBlocks (markdown_parser.go:321).
// Prose blocks emit their verbatim Content; structured blocks emit a fenced
// YAML block. Blocks are joined by a blank line (canonical spacing).
func SerializeBlockDoc(doc BlockDoc) (string, error) {
	parts := make([]string, 0, len(doc.Blocks))
	for _, b := range doc.Blocks {
		if b.Kind == KindProse {
			parts = append(parts, b.Content)
			continue
		}
		s, err := serializeFencedBlock(b)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n"), nil
}

// serializeFencedBlock renders any block-mode kind as ```kind\n<yaml>\n```
// using the shared literal-style machinery — registry-free, so it serializes
// code, diagram, column-row, etc. uniformly without needing a BlockProcessor.
func serializeFencedBlock(b DocBlock) (string, error) {
	body, err := fencedblock.SerializeYaml(b.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + b.Kind + "\n" + body + "\n```", nil
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `go test ./sieve/ -run TestSerializeBlockDoc_ProseAndFence -v`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add sieve/block_document.go sieve/block_document_test.go
git commit -m "Block spine: SerializeBlockDoc (registry-free fence serialization)"
```

### Task A3: `ParseBlockDoc` (top-level segmentation)

**Files:**
- Modify: `sieve/block_document.go`, `sieve/block_document_test.go`

- [ ] **Step 1: Write the failing test.** Parsing recognizes a fence only if a block-mode processor is registered for its kind (the existing goldmark gate), so register the real `CodeBlockProcessor` exactly as `markdown_parser_test.go:77` does.

```go
func TestParseBlockDoc_ProseAndFence(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nWorld."
	doc, err := ParseBlockDoc(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc.Blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc.Blocks), doc.Blocks)
	}
	if doc.Blocks[0].Kind != KindProse || doc.Blocks[0].Content != "Hello." {
		t.Fatalf("block 0: %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].Kind != "code" || doc.Blocks[1].ID != "co-1" {
		t.Fatalf("block 1: %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Kind != KindProse || doc.Blocks[2].Content != "World." {
		t.Fatalf("block 2: %+v", doc.Blocks[2])
	}
}
```

- [ ] **Step 2: Run it to confirm it fails.**

Run: `go test ./sieve/ -run TestParseBlockDoc_ProseAndFence -v`
Expected: FAIL — `undefined: ParseBlockDoc`.

- [ ] **Step 3: Implement `ParseBlockDoc`.** Add to `sieve/block_document.go` (add `"github.com/yuin/goldmark/text"` to imports; `mdParser`, `sieveBlockNode` are already in-package from `markdown_parser.go`):

```go
// ParseBlockDoc parses markdown into an ordered BlockDoc. Only TOP-LEVEL fenced
// Sieve blocks (direct children of the document root) become structured
// DocBlocks; everything between them — prose, headings, lists, and (Stage A)
// legacy block-anchor regions — becomes one verbatim prose DocBlock per run.
// Per-paragraph granularity and {id=} handles arrive in Stage B; container
// child expansion arrives in Stage E.
func ParseBlockDoc(markdown string) (BlockDoc, error) {
	source := []byte(markdown)
	root := mdParser().Parser().Parse(text.NewReader(source))

	var out BlockDoc
	cursor := 0

	emitProse := func(end int) {
		if end <= cursor {
			return
		}
		raw := strings.Trim(string(source[cursor:end]), "\n")
		if strings.TrimSpace(raw) != "" {
			out.Blocks = append(out.Blocks, DocBlock{Kind: KindProse, Content: raw})
		}
	}

	for n := root.FirstChild(); n != nil; n = n.NextSibling() {
		sn, ok := n.(*sieveBlockNode)
		if !ok {
			continue // prose/anchor: absorbed into the surrounding run
		}
		emitProse(sn.StartByte())
		out.Blocks = append(out.Blocks, DocBlock{
			ID:    sn.SieveBlock.ID,
			Kind:  sn.SieveBlock.Kind,
			Attrs: sn.SieveBlock.Attrs,
		})
		cursor = sn.EndByte()
	}
	emitProse(len(source))
	return out, nil
}
```

- [ ] **Step 4: Run the test to confirm it passes.**

Run: `go test ./sieve/ -run TestParseBlockDoc_ProseAndFence -v`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add sieve/block_document.go sieve/block_document_test.go
git commit -m "Block spine: ParseBlockDoc (top-level prose/fence segmentation)"
```

### Task A4: Round-trip stability (incl. a `column-row` fence)

**Files:**
- Modify: `sieve/block_document_test.go`

- [ ] **Step 1: Write the round-trip test.** Build a mixed doc programmatically (so we never hand-write YAML), serialize → parse → serialize, and assert byte-stability + structure. `column-row` is exercised as an opaque structured block (Stage A scope).

```go
func TestBlockDoc_RoundTripStable(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })
	RegisterProcessor("column-row", &CodeBlockProcessor{}) // any block-mode processor suffices for the parse gate
	t.Cleanup(func() { UnregisterProcessor("column-row") })

	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "# Title\n\nIntro prose."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Content: "Between."},
		{ID: "cr-1", Kind: KindColumnRow, Attrs: map[string]interface{}{"id": "cr-1", "widths": []interface{}{0.5, 0.5}}},
		{Kind: KindProse, Content: "Tail."},
	}}

	md1, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize 1: %v", err)
	}
	parsed, err := ParseBlockDoc(md1)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed.Blocks) != len(doc.Blocks) {
		t.Fatalf("block count drift: want %d got %d", len(doc.Blocks), len(parsed.Blocks))
	}
	md2, err := SerializeBlockDoc(parsed)
	if err != nil {
		t.Fatalf("serialize 2: %v", err)
	}
	if md1 != md2 {
		t.Fatalf("round-trip not stable:\n md1: %q\n md2: %q", md1, md2)
	}
}
```

- [ ] **Step 2: Run it.**

Run: `go test ./sieve/ -run TestBlockDoc_RoundTripStable -v`
Expected: PASS. If it fails on the `column-row` block, confirm the parse gate sees a registered block-mode processor for `column-row` (the test registers one).

- [ ] **Step 3: Run the whole stage + full suite (no regressions).**

Run: `go test ./sieve/ -run BlockDoc -v && go test ./...`
Expected: Stage A tests PASS; the pre-existing suite stays green (Stage A wires nothing).

- [ ] **Step 4: Commit.**

```bash
git add sieve/block_document_test.go
git commit -m "Block spine: round-trip stability test (mixed doc incl column-row)"
```

---

## Stage B — Universal handles + bijection (roadmap)

**Goal:** every block — prose included — carries a stable `{id=}` handle, hidden in the editor and stripped on export, making markdown ↔ `BlockDoc` a lossless bijection. Refine prose from coarse runs to per-paragraph blocks keyed by handle.

**Dependencies:** Stage A. **Exit criteria:** parse→serialize preserves prose handles; a prose block edited in isolation keeps its handle; handle-set union on merge and fresh mint on split are implemented + Go-tested; anchors never reach the editor (strip-on-load / re-attach-on-save).

**Marker decision (locked — spec §3.1):** prose handle = a **leading own-line HTML comment** `<!--s:KIND-hex-->` (e.g. `<!--s:pr-3f9a-->`), handle value via `GenerateBlockID` (kind prefix is a cosmetic hint; resolution is opaque, one global namespace). **Bypass goldmark** — a deterministic strip-from-editor / re-attach-on-save line pass operating **only on prose spans** (fenced blocks keep `id:` in YAML). Marker pairs to the block immediately below it. The id is hidden in the editor but always written back to disk.

**Files & interfaces (bite-size when starting):**
- `sieve/handle_anchor.go` — marker strip/emit (NOT a goldmark parser). `stripHandles(markdown) (clean string, []handleAt)` where `handleAt = {handle string; blockIndex int}` pairs each `<!--s:…-->` to the prose block below it via regex `<!--s:([\w-]+)-->`; `attachHandles(BlockDoc) string` re-prepends a marker line above each prose block carrying an `ID`. Confine to prose spans (use the spine's top-level segmentation; never touch fenced-block byte ranges).
- `sieve/block_document.go` — split prose runs into per-top-level-node `DocBlock`s (needs the deferred goldmark top-level byte-range helper); carry `ID` on prose blocks from the strip map.
- Handle-set type: extend `DocBlock` with `Aliases []string` (absorbed handles); implement `mergeHandles` (union tail into head) / `splitHandles` (head keeps, tail mints via `GenerateBlockID`) per spec §7 + the "next save strips dangling refs" GC.

**Task outline:**
- B.1 prose per-paragraph segmentation (needs the goldmark top-level byte-range helper deferred from Stage A) + tests.
- B.2 `{id=}` anchor attach/strip + bijection round-trip tests.
- B.3 handle-set (`Aliases`) + merge-union / split-mint + undo-stable handle assignment tests.
- B.4 ref GC: strip non-resolving refs on serialize; tests.

---

## Stage C — Wire protocol (block ops over WS) (roadmap)

**Goal:** replace document-level save with block ops; introduce the Sieve-native envelope and the prose transaction observer.

**Dependencies:** Stages A–B. **Exit criteria:** `ShadowDocument` flush goes through `SerializeBlockDoc` (retiring `InjectBlocks` at editor_service.go:134 and :675); `create/update/delete/reorder/move` ops round-trip; prose edits emit debounced `update-block {uuid, blockId, content}`.

**Files & interfaces (bite-size when starting):**
- `sieve/editor_service.go` — replace `InjectBlocks(s.Markdown, s.Blocks)` with the spine over a `BlockDoc`; `ShadowDocument` holds a `BlockDoc` (or a thin adapter during the cutover).
- WS handler (verify current path via `ws_handler.go` / `sse.go`) — block-op message schema `{op, uuid, blockId, kind, content, attrs, index}`.
- `frontend/src/static/editor.js` — transaction observer: map changed range → owning block handle → debounced `update-block`; detect split (`create-block` + mint) / merge (`delete-block` + union).

**Task outline:** C.1 spine into flush (Go); C.2 block-op schema + handler (Go, table-tested); C.3 transaction observer (JS, manual `wails dev` protocol); C.4 split/merge → ops (JS + Go handle rules).

---

## Stage D — Native frontend (roadmap) — **app runnable end-to-end again from here**

**Goal:** frontend renders from the block list; `BlockAnchor` transparent `contentDOM` container (blockRef successor); retire the JS document-level serializer (keep per-block inline markdown↔PM only).

**Dependencies:** Stage C. **Exit criteria:** open/edit/save a real note end-to-end through block ops; free-flow prose typing + cross-paragraph selection intact (regression vs editor-layout Stage 1); per-kind render modes (atoms vs transparent PM nodes) correct.

**Files & interfaces (bite-size when starting):**
- `frontend/src/static/block-anchor-view.js` — transparent container NodeView with real `contentDOM` (PM selection traverses).
- `frontend/src/static/editor.js` — drive NodeViews from the block list; remove the document-level `tiptap-markdown` serialize path; keep per-block inline conversion.

**Task outline:** D.1 BlockAnchor view; D.2 block-list → editor render; D.3 remove document-level JS serializer; D.4 end-to-end manual protocol + selection/copy-paste regression (reuse editor-layout Stage 1 protocols).

---

## Stage E — Containers / tree + columns (roadmap)

**Goal:** populate `DocBlock.Children` by-value; reframe `column-row` as a real subtree; retire legacy `blockRef`.

**Dependencies:** Stages A–D. **Exit criteria:** a `column-row` round-trips as a `DocBlock` with `Children` (not opaque Attrs); columns render side-by-side; `blockRef` removed; search/serialize traverse the tree.

**Files & interfaces (bite-size when starting):**
- `sieve/block_document.go` — `columnRowToDocBlock` / `docBlockToColumnRow` lift/lower between `ColumnRow`/`Column`/`Child` (columnrow_serializer.go) and `DocBlock.Children`; `ParseBlockDoc`/`SerializeBlockDoc` descend containers.
- `frontend/src/static/column-row-renderer.js` (from the editor-layout plan, Stage 3) — container NodeView on the new substrate.
- Remove `blockRef` / `[!block]` parser (markdown_parser.go:382-549) once columns prove the container.

**Task outline:** E.1 container lift/lower + recursive spine + tests; E.2 column NodeView; E.3 retire blockRef; E.4 tree-aware traversal.

---

## Stage F — Lenses + server-side search (roadmap)

**Goal:** layout/lineage projections over the id-graph; server-side search that traverses the tree and can query structured facets (handle/kind/refs), not just full text (spec §10).

**Dependencies:** Stages A–E; **live lineage / dirty-glow couples to the separate reconciler project (spec §13) — do not start that part before it lands.**

**Files & interfaces (bite-size when starting):**
- `sieve/block_index.go` — walk the `BlockDoc` tree → full-text + facet index (handle, kind, ref edges).
- `frontend/src/static/lineage-gutter.js` / `doc-map.js` (from editor-layout plan, Stage 4) — render lineage as read-only lenses.

**Task outline:** F.1 tree search index (Go, tested); F.2 facet queries; F.3 lineage rail v0 (ref-chain, no reconciler); F.4 live lineage + doc map (gated on reconciler).

---

## Self-review

- **Spec coverage:** §2 model → A1 ✓; §3 three layers (markdown storage / Sieve envelope wire / PM internal) → A spine + C envelope ✓; §4 block ops → C ✓; §5 per-kind render mode → D ✓; §6 one serialization spine (retire InjectBlocks/JS split) → A3/A4 + C.1 + D.3 ✓; §7 handles/refs (merge-union, split-mint, GC) → B.3/B.4 ✓; §8 by-value containers → E ✓; §9 lenses → F ✓; §10 server-side tree search + facets → F.1/F.2 ✓; §11 staged cutover (Go core first, runnable from D) → stage order ✓; §12 reframes layout-engine (Stage 1 stands; columns/lineage as structure+lenses) → E/F reuse layout plan files ✓; §13 reconciler coupling deferred → F.4 gated ✓.
- **Placeholder scan:** Stage A carries real code + exact commands + expected output. Stages B–F are explicitly *roadmap outlines to bite-size just-in-time* (declared in the Fidelity note), with file maps, interfaces, exit criteria, and dependencies — not hidden placeholders.
- **Type/name consistency:** `DocBlock`/`BlockDoc`, `KindProse`/`KindColumnRow`/`KindColumn`, `ParseBlockDoc`/`SerializeBlockDoc`/`serializeFencedBlock` used consistently; confirmed no collisions with existing `Document`/`SieveBlock`/`KindBuffer` names. Reuses existing `fencedblock.SerializeYaml`, `mdParser`, `sieveBlockNode`, `RegisterProcessor`/`UnregisterProcessor`, `&CodeBlockProcessor{}` test convention.
- **Known risk carried forward:** the goldmark top-level prose byte-range helper (per-paragraph segmentation) is deferred from Stage A to Stage B.1 — Stage A intentionally uses coarse prose runs to keep the core spine robust and fully testable. Stage A wires nothing, so the running app is unaffected until Stage D.
