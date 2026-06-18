# Sieve Block Document Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot Sieve from "markdown is the model" to "blocks are the model" — a uniform, ordered, addressable block tree where markdown is a storage serialization produced by one backend spine, delivered as a staged cutover (Go-testable core first).

**Architecture:** A new ordered `BlockDoc` tree of `DocBlock`s replaces the flat `markdown + map[id]*SieveBlock` pair. A single backend serialization spine (`ParseBlockDoc` / `SerializeBlockDoc`) round-trips the tree against markdown, retiring the `InjectBlocks` byte-splice (markdown_parser.go:321) and, later, the JS document-level serializer. Prose travels as markdown content per block; ProseMirror stays confined to the frontend; the Store seam owns persistence. Migration is a one-time internal cutover (NOT strangler) — no backward-compat shims; intermediate stages need only compile + pass tests, and the app is runnable end-to-end again from Stage D.

**Tech Stack:** Wails v2 + Go + chi + HTMX; goldmark (markdown AST), `gopkg.in/yaml.v3`, the existing `sieve/fencedblock` literal-style YAML machinery; TipTap/ProseMirror (frontend only). No React. No new npm deps.

**Spec:** [`docs/superpowers/specs/2026-06-17-block-document-model-design.md`](../specs/2026-06-17-block-document-model-design.md)

---

## Progress / handoff log

- **Stage A — COMPLETE** (2026-06-17). All four tasks (A1–A4) implemented via TDD; checkboxes ticked below. New files: `sieve/block_document.go`, `sieve/block_document_test.go`. `go test ./sieve/ -run BlockDoc` green; full `go test ./...` green (no regressions, nothing wired into the app yet). Commits: `Block model: DocBlock/BlockDoc types…` → `…round-trip stability test (mixed doc incl column-row)`.
- **Stage B — COMPLETE** (2026-06-17). Tasks B.1–B.4 implemented and passing, including stacked alias marker support for merged prose blocks on serialize/deserialize to ensure referential survival across reopens.
- **Stages C–F — ATTEMPTED BIG-BANG, REVERTED** (2026-06-17). An attempt implemented C–F as a single uncommitted big-bang cutover *without* the plan's mandated TDD / just-in-time bite-sizing / runnable checkpoints. It produced thousands of runtime errors across multiple subsystems (per-keystroke block creation via `ensureSieveBlockAnchorsAndIds` re-wrapping a trailing bare paragraph; `requestAnimationFrame(syncSieveChrome)` firing after EditorView destroy → `nodeDOM` null `descAt`; PM decoration/view desync → `Index N out of range`; `ws timeout: flush` on document switch; doc loading with an unwrapped trailing paragraph). Reproduced deterministically via headless-Chrome CDP against the dev server (typing `abc` grew the doc 8→11 top-level blocks). **Reverted** to the committed Stage A/B baseline (`8c72ca6`). The full attempt is preserved on branch **`wip/block-model-cf-attempt1`** (commit `0293f26`). Salvageable-for-reference Go pieces: `BlockDoc.CreateBlock/UpdateBlockContentAndAttrs/MoveBlock`, the `block-op` WS envelope (`ws_handler.go` + `EditorService.HandleBlockOp`), and `sieve/block_index.go` (+ test). The rotten core is the frontend per-keystroke observer in `editor.js` (+467/−22, zero tests) — do NOT cherry-pick it; redo with TDD.
- **NEXT: Stage C — REDO per plan.** Bite-size C just-in-time; TDD each task; keep the app runnable. Repro fixture for the legacy `[!block]…[!block-end]` blockRef + `ai-block` case saved at `/tmp/sieve-repro-blockref.md` (re-home into `sieve/testdata/` when starting).

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

- [x] **Step 1: Create the types and kind constants.**

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

- [x] **Step 2: Verify it compiles.**

Run: `go build ./sieve/`
Expected: no output (success). No name collisions (`DocBlock`/`BlockDoc`/`KindProse` are new).

- [x] **Step 3: Commit.**

```bash
git add sieve/block_document.go
git commit -m "Block model: DocBlock/BlockDoc types + kind constants"
```

### Task A2: `SerializeBlockDoc` (registry-free fence serialization)

**Files:**
- Modify: `sieve/block_document.go`
- Create: `sieve/block_document_test.go`

- [x] **Step 1: Write the failing test.**

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

- [x] **Step 2: Run it to confirm it fails.**

Run: `go test ./sieve/ -run TestSerializeBlockDoc_ProseAndFence -v`
Expected: FAIL — `undefined: SerializeBlockDoc`.

- [x] **Step 3: Implement `SerializeBlockDoc` + `serializeFencedBlock`.** Add to `sieve/block_document.go` (and add `"strings"` and `"sieve/sieve/fencedblock"` to imports):

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

- [x] **Step 4: Run the test to confirm it passes.**

Run: `go test ./sieve/ -run TestSerializeBlockDoc_ProseAndFence -v`
Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add sieve/block_document.go sieve/block_document_test.go
git commit -m "Block spine: SerializeBlockDoc (registry-free fence serialization)"
```

### Task A3: `ParseBlockDoc` (top-level segmentation)

**Files:**
- Modify: `sieve/block_document.go`, `sieve/block_document_test.go`

- [x] **Step 1: Write the failing test.** Parsing recognizes a fence only if a block-mode processor is registered for its kind (the existing goldmark gate), so register the real `CodeBlockProcessor` exactly as `markdown_parser_test.go:77` does.

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

- [x] **Step 2: Run it to confirm it fails.**

Run: `go test ./sieve/ -run TestParseBlockDoc_ProseAndFence -v`
Expected: FAIL — `undefined: ParseBlockDoc`.

- [x] **Step 3: Implement `ParseBlockDoc`.** Add to `sieve/block_document.go` (add `"github.com/yuin/goldmark/text"` to imports; `mdParser`, `sieveBlockNode` are already in-package from `markdown_parser.go`):

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

- [x] **Step 4: Run the test to confirm it passes.**

Run: `go test ./sieve/ -run TestParseBlockDoc_ProseAndFence -v`
Expected: PASS.

- [x] **Step 5: Commit.**

```bash
git add sieve/block_document.go sieve/block_document_test.go
git commit -m "Block spine: ParseBlockDoc (top-level prose/fence segmentation)"
```

### Task A4: Round-trip stability (incl. a `column-row` fence)

**Files:**
- Modify: `sieve/block_document_test.go`

- [x] **Step 1: Write the round-trip test.** Build a mixed doc programmatically (so we never hand-write YAML), serialize → parse → serialize, and assert byte-stability + structure. `column-row` is exercised as an opaque structured block (Stage A scope).

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

- [x] **Step 2: Run it.**

Run: `go test ./sieve/ -run TestBlockDoc_RoundTripStable -v`
Expected: PASS. If it fails on the `column-row` block, confirm the parse gate sees a registered block-mode processor for `column-row` (the test registers one).

- [x] **Step 3: Run the whole stage + full suite (no regressions).**

Run: `go test ./sieve/ -run BlockDoc -v && go test ./...`
Expected: Stage A tests PASS; the pre-existing suite stays green (Stage A wires nothing).

- [x] **Step 4: Commit.**

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

### Bite-sized (2026-06-17)

**Segmentation tactic decided during bite-sizing:** the deferred "goldmark top-level byte-range helper" is NOT used. Empirically, goldmark `Lines()` excludes a fenced code block's ``` fences and panics on inline nodes, so AST spans corrupt regular code blocks inside prose. Instead, per-paragraph segmentation uses a **fence-aware blank-line splitter** (`splitProseRun`) over each prose run (the spine already isolates prose runs between Sieve fences via byte cursor). ``` / `~~~` regions are atomic. **Accepted fidelity cost:** blank-line-separated content (loose lists, multi-para list items) splits into separate prose blocks — each still byte-verbatim; tight lists stay one block.

- [x] **B.1** `splitProseRun` (fence-aware) + `ParseBlockDoc` emits one prose `DocBlock` per paragraph; update round-trip test for per-paragraph counts. Tests: `TestSplitProseRun*`, `TestParseBlockDoc_PerParagraph`.
- [x] **B.2** `sieve/handle_anchor.go`: `stripHandles(md) (clean, []handleAt{handle,offset})` + `attachHandles(BlockDoc) string`; `ParseBlockDocWithHandles` / `SerializeBlockDocWithHandles`; marker = own-line `<!--s:HANDLE-->` (regex `^\s*<!--s:([\w-]+)-->\s*$`), paired to the block whose clean-byte start equals the marker's next-line offset. Bijection round-trip tests (handles preserved; isolated edit keeps handle).
- [x] **B.3** `DocBlock.Aliases []string`; `splitHandles(head) (head, tail)` (head keeps id+aliases, tail mints `GenerateBlockID("prose")`); `mergeHandles(head, tail) head` (head unions tail's id+aliases into Aliases). Pure funcs, table-tested incl. undo-stability (split→merge restores exact set).
- [x] **B.4** `gcRefs(refs, resolvable) []string` (drop non-resolving outgoing refs) + `gcAliases(doc)` drops aliases nothing in the doc references. Pure transforms, tested. (Wiring to a live ref-producer lands in Stage E/F; here they are proven as pure functions per spec §7.)

---

## Stage C — Wire protocol (block ops over WS) (roadmap)

**Goal:** replace document-level save with block ops; introduce the Sieve-native envelope and the prose transaction observer.

**Dependencies:** Stages A–B. **Exit criteria:** `ShadowDocument` flush goes through `SerializeBlockDoc` (retiring `InjectBlocks` at editor_service.go:134 and :675); `create/update/delete/reorder/move` ops round-trip; prose edits emit debounced `update-block {uuid, blockId, content}`.

**Files & interfaces (bite-size when starting):**
- `sieve/editor_service.go` — replace `InjectBlocks(s.Markdown, s.Blocks)` with the spine over a `BlockDoc`; `ShadowDocument` holds a `BlockDoc` (or a thin adapter during the cutover).
- WS handler (verify current path via `ws_handler.go` / `sse.go`) — block-op message schema `{op, uuid, blockId, kind, content, attrs, index}`.
- `frontend/src/static/editor.js` — transaction observer: map changed range → owning block handle → debounced `update-block`; detect split (`create-block` + mint) / merge (`delete-block` + union).

**Task outline:** C.1 spine into flush (Go); C.2 block-op schema + handler (Go, table-tested); C.3 transaction observer (JS, manual `wails dev` protocol); C.4 split/merge → ops (JS + Go handle rules).

### Bite-sized (2026-06-17, redo)

**Lesson from the reverted attempt:** the JS observer was the rotten core (per-keystroke whole-tree diff, random ID minting, doc-mutation inside `onUpdate`, rAF-after-destroy). Build and prove the backend contract in Go FIRST, keep the JS thin, and TDD every Go task. Do NOT cherry-pick `editor.js` from `wip/block-model-cf-attempt1`.

- [x] **C.2a** `sieve/block_op.go`: `BlockOp` type + `(*BlockDoc).ApplyOp` — pure create/update/delete/move transforms (top-level + nested), table-tested. Commit `fd25ae9`.
- [x] **C.1** Flush spine: `ShadowDocument` holds an authoritative `BlockDoc`; `contentForSave` goes through `SerializeBlockDocWithHandles`; `InjectBlocks` retired (both callers migrated, function deleted). `Blocks` map is now a derived view (Attrs aliased). Disk-direct job-update path migrated too. Existing tests migrated to the new model. Commit `97ee848`. **Plus** a fixture round-trip test on the user's real blockRef+ai-block doc (no content loss, stable serialization) — commit after `cf21072`.
- [x] **C.2b** `EditorService.HandleBlockOp(uuid, op)` applies an op to the open `ShadowDocument`'s Doc + re-debounces. TDD against a live `EditorService` + in-memory store. Commit `cf21072`.
- [x] **C.2c** WS routing: `ws_handler.go` decodes `{type:"block-op", op:{…}}` → `HandleBlockOp` with an error envelope; wire-contract decode test pins the JSON field names. Commit `cf21072`.

**Go side of Stage C is complete and tested.** The app still round-trips through the existing `doc-update` path (full markdown → Go reparses to Doc → serializes Doc on save), which keeps it runnable. Nothing in the frontend emits block-ops yet.

- [ ] **C.3 / C.4 — coupled to Stage D, do together.** The thin JS observer (changed range → owning block handle → debounced `update-block`; Enter→`create-block`+mint; Backspace→`delete-block`+alias-union) needs the editor to carry block identity, which only exists once Stage D renders from the block list with `sieve-block-anchor` wrappers. Doing C.3/C.4 before D is what forced the reverted attempt's fragile per-keystroke whole-tree re-wrapper. **Next chunk: Stage D native rendering + the thin observer, verified via the CDP harness (`/tmp/cdp_probe.mjs`): typing N chars must emit `update-block` ops and NOT change the top-level block count.**

---

## Stage D — Native frontend (roadmap) — **app runnable end-to-end again from here**

**Goal:** frontend renders from the block list; `BlockAnchor` transparent `contentDOM` container (blockRef successor); retire the JS document-level serializer (keep per-block inline markdown↔PM only).

**Dependencies:** Stage C. **Exit criteria:** open/edit/save a real note end-to-end through block ops; free-flow prose typing + cross-paragraph selection intact (regression vs editor-layout Stage 1); per-kind render modes (atoms vs transparent PM nodes) correct.

**Files & interfaces (bite-size when starting):**
- `frontend/src/static/block-anchor-view.js` — transparent container NodeView with real `contentDOM` (PM selection traverses).
- `frontend/src/static/editor.js` — drive NodeViews from the block list; remove the document-level `tiptap-markdown` serialize path; keep per-block inline conversion.

**Task outline:** D.1 BlockAnchor view; D.2 block-list → editor render; D.3 remove document-level JS serializer; D.4 end-to-end manual protocol + selection/copy-paste regression (reuse editor-layout Stage 1 protocols).

### Bite-sized (2026-06-18, redo)

**Anti-patterns that broke the reverted attempt — forbidden here:**
- ❌ Mutating the doc inside `onUpdate` (the per-keystroke `ensureSieveBlockAnchorsAndIds` re-wrapper minted IDs every keystroke → "new line per char"). Block identity must come from the LOADED structure, fixed at load, not patched on every transaction.
- ❌ Whole-tree re-diff on every keystroke. The observer maps only the *changed range* to its owning anchor.
- ❌ `requestAnimationFrame`/`setTimeout` callbacks that call `view.nodeDOM`/`view.state` without a `view.isDestroyed`/docView guard (caused the `nodeDOM → descAt null` flood on tab-switch).

**Verification gate (every task):** the headless CDP harness (`/tmp/cdp_probe2.mjs`) must show: editor mounts, **zero** console errors on load, and after typing N chars the **top-level block count is unchanged** (prose edits never create blocks). A note must be open — see the open-note helper note below.

**Ordering keeps the app runnable** (it currently works via the doc-update bridge; each task is additive until D.3):

- [x] **D.1** `block-anchor-renderer.js` (fresh): transparent `contentDOM` container for prose — `content:'block+'`, `defining:true`, not atom, not draggable; `parseHTML` for `div[data-type="sieve-block-anchor"]`; NodeView `update` returns true only for same type. Registered via `registerSieveRenderer('block-anchor', …)`; script tag after `diagram-renderer.js`. Additive. **Verified via CDP** (`/tmp/cdp_d1.mjs`): registers in `getSieveNodes`, schema accepts it, zero console errors. Commit `0a4d607`.
- [x] **D.2** Render from the block list. Server: `editor_handler` sends `blocks` ([]FrontendBlock) in WYSIWYG load (`sieve/frontend_block.go` `BlockDocToFrontendBlocks`, TDD `frontend_block_test.go`). Client: pure `buildBlocksHTML(blocks, mdRender)` in new `block-render.js` (TDD `frontend/test/block-render.test.js`, 7 cases) builds document HTML (prose → `<div data-type=sieve-block-anchor data-id> <rendered-markdown> </div>`; structured → its `serialisedForm` fence → per-kind fence rule → `data-*` div). `mountWysiwyg(el, uuid, body, blocks)` renders it via the DOMParser-replace path (the proven syncMd pattern) instead of `setContent` — bypasses the markdownit re-parse, reuses each node's `parseHTML`, NO manual ProseMirror JSON. Added a transparent `markdownSerialize` hook to `createSieveNode`; block-anchor supplies one that emits prose children + re-prepends `<!--s:ID-->` handle markers (byte-matching `SerializeBlockDocWithHandles`) so doc-update round-trips. **Gate (manual eyeball — CDP harness unavailable in this env):** real note renders all blocks; code + smart-image round-trip losslessly to disk; stable on edit (no per-keystroke block churn); markdown toggle intact. Handle-less prose renders with empty `data-id` (identity minting deferred to D.4, per design). `go test ./sieve/` + vitest 29/29 green.
- [x] **D.3** Thin observer (replaces doc-update as the *primary* path). `onUpdate` no longer serializes the whole doc per keystroke — it only marks dirty + arms a debounce; the debounced `syncDocument` diffs top-level blocks (`block-sync.js` pure `computeBlockSync`, TDD 7 cases) and emits granular `block-op {uuid, op:{update-block, blockId, content}}` for changed PROSE anchors. **Deliberate deviation:** `doc-update` is KEPT as a fallback (not removed) for cases granular ops can't yet express — no-id prose (identity minting is D.4), a top-level structure change (split/merge — D.4), or a structured-block edit (Go's structured update-block contract is parsed `Attrs`, which the client can't faithfully build from the fence string). This keeps fresh notes lossless and the app runnable; full `doc-update` removal lands once D.4 mints prose ids. `flushSave`/tab-switch/mode-toggle flush the pending sync via `docSyncFlush`; markdown mode keeps its raw `doc-update`. **Also fixed a latent D.1 bug uncovered here:** block-anchor inherits `serialisedForm` from `BASE_ATTRS`, so `isSieveNode()` routed it to block-chrome's Strategy B, which repopulated a `.block-chrome-host` *inside* the editable anchor every frame; lacking `ignoreMutation`, ProseMirror reconciled those chrome writes and recreated the NodeView in a tight loop (~100% CPU, 141k creations idle, severe typing lag — worse in the WebKitGTK app than Chrome). Added the `ignoreMutation: m => !contentDOM.contains(m.target)` guard every other content-bearing sieve block already carries; loop dead (creations now == prose-block count, flat while idle/typing). **Gate (manual eyeball — CDP unavailable):** typing snappy, anchor count stable, save round-trips; `go test ./sieve/` + vitest 36/36 green.
- [ ] **D.4** Split (Enter at block boundary) → `create-block` + minted handle; merge (Backspace at block start) → `delete-block` + alias-union. Pure handle math already exists in Go (`splitHandles`/`mergeHandles`); JS emits ops, identity assigned at the boundary event only. Gate: Enter adds exactly one block, Backspace removes exactly one, undo stable.
- [ ] **D.5** Regression sweep via CDP: free-flow prose typing, cross-paragraph selection, copy/paste of a sieve block, tab-switch (no `nodeDOM`/`descAt` errors), reopen.

**Open-note helper (for the CDP gate):** the editor mounts on `#tiptap-mount[data-uuid]` via `initEditor` → `GET /api/editor/load?uuid=`. A fresh headless session has no active tab, so the harness must first open a note (create one through the app's note API or click a real note item) before `window.__tiptap` exists. Capture the chosen uuid + open sequence in the harness so D.1–D.5 gates are reproducible.

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
