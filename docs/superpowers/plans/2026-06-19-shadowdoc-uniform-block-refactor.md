# ShadowDoc uniform-block refactor (B-C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development per task; commit per task. Steps are checkboxes.

**Goal:** Collapse the Go block model to ONE in-memory type (`SieveBlock`) addressed by id, held directly on `ShadowDocument.Blocks []SieveBlock`. Prose is just `Kind:"prose"` with its body in `Attrs["content"]`. Delete every parallel/derived structure.

**Architecture (user-ratified 2026-06-19):**
- `SieveBlock { ID, Kind string; Attrs map[string]any; Aliases []string }` — the sole node. No `Content` field, no `Children`.
- Payload lives in `Attrs` for every kind (prose→`content`, code→`source`, ai→`response`, web→`content`). Typed accessors (`b.Content()`, `b.Source()`, …) front the map (spec #5).
- `ShadowDocument.Blocks []SieveBlock` — ordered, flat. No `Doc`/`BlockDoc` wrapper, no `Blocks map`, no `Markdown` field.
- `FrontendBlock` stays the wire DTO; processors keep taking `*SieveBlock`.
- Containers/`Children` are **Stage E** — a future `Node` interface (`ID()/Kind()/walk`) over `SieveBlock` + a `Container` type promoted from `ColumnRow`. Out of scope here.

**Tech Stack:** Go, goldmark, gopkg.in/yaml. Tests: `go test ./sieve/`.

## Global Constraints
- App runnable + `go build ./...` clean + `go test ./sieve/` green after EVERY task. No big-bang (cf. reverted C–F).
- No Co-Authored-By trailer.
- `getBlock(id)`/tree walks are the only accessor — no `Blocks[...]` map poking.
- vitest stays green (87) — JS untouched except the folded-in B-D bracket (last task).

---

## Task order (each = one commit)

### Task 1 — Typed accessors (additive, no behavior change)
Add to `DocBlock` (renamed later): `Content() string`, `Source() string`, `Ref() string`, `Status() string`, `StringAttr(key) string`. TDD: `block_accessors_test.go`. Nothing calls them yet.

### Task 2a — Migrate `Blocks map` readers → `findBlock`/tree (map still populated)
Sites in `editor_service.go`: `resetStuckDispatched`(390), `HandleBlockUpdate`(695,730), `DispatchJobIfNeeded`(758), `applyJobUpdate`(805), `RunJob`(871), `PromoteBlock`(961,997), `EnterWysiwyg` log(511). Each `shadow.Blocks[id]` → `shadow.Doc.findBlock(id)`. Keep `syncBlocksView` running (harmless). Green.

### Task 2b — Delete the `Blocks map` + `syncBlocksView`
Remove the field, the method, all `syncBlocksView()` calls, the `getBlock` map fallback, `JobContext.Shadow.Blocks`, `RunJob` `blocksCopy`. Migrate `editor_service_test.go` map references → `findBlock`. Green.

### Task 3 — Derive markdown on demand; remove `Markdown` field
Add `func (s ShadowDocument) deriveMarkdown() (string, error)` = serialize tree. WYSIWYG drift-reads → derive: `BuildContextForID` id=="doc"(context_provider:70), `BlockAnchorProvider.BuildContext`(block_anchor:25), `RunJob` markdown(887). Markdown MODE keeps its raw text in a new `mdModeBuffer` (only written/read in markdown mode): `setMarkdown`, `contentForSave`, `EnterMarkdown`, `EnterWysiwyg.reparseDoc`, `PromoteBlock` md-path. Delete `Markdown`. Green.

### Task 4 — Prose body → `Attrs["content"]`; drop `DocBlock.Content`
Parser (`scanProseRegion`/`newDocBlock`/`splitHandles`/`mergeHandles`), serializer (`serializeProseBlock`, `SerializeBlockDoc` prose branch), `BlockDocToFrontendBlocks`, `BuildContextForID` prose branch, `ApplyOp` update-block, all read/write `b.Content()`/`Attrs["content"]`. Remove `Content` field. Migrate tests. Green.

### Task 5 — Remove `Children`; flatten tree funcs; drop `ParentID`
Remove `Children` from the node. Flatten `findBlockIn`/`removeBlock` (no recursion), `mintProseIDs`, `gcAliasesBlocks`/`collectHandles`. `ApplyOp` create/move drop the `ParentID` branch (error if `op.ParentID != ""`). Delete speculative nested tests (`block_op_test` nested, `handle_gc` nested). `KindColumn*` constants stay. Green.

### Task 6a — Collapse `BlockDoc` → `[]DocBlock`
Pure funcs operate on slices: `ParseBlockDocWithHandles`/`SerializeBlockDocWithHandles`/`gcAliases`/`BlockDocToFrontendBlocks` take/return `[]DocBlock`; `ApplyOp`/`findBlock` become free funcs / `ShadowDocument` methods. `ShadowDocument.Doc BlockDoc` → `Blocks []DocBlock`. Delete `type BlockDoc`. Green.

### Task 6b — Rename `DocBlock` → `SieveBlock` (merge the two types)
Add `Aliases` to old `SieveBlock` (now identical to `DocBlock`). Replace `DocBlock`→`SieveBlock` package-wide; delete the duplicate decl; `newDocBlock`→`newSieveBlock`. Green. **Retire tech-debt B-C.**

### Task 7 — (folded B-D) chain-active bracket on native prose
Drive `block-ref-active` through the same `.block-chrome-rail` the ephemeral `block-ai-target` glow uses (`ai-target-decoration.js` + `editor.css:2628`) so prose matches structured. Verify by eye in WebKitGTK. vitest green.

---
*Plan authored 2026-06-19 against spec `2026-06-19-shadowdoc-uniform-block-refactor.md`. Naming/`Children`/`Markdown` decisions ratified in-session.*
