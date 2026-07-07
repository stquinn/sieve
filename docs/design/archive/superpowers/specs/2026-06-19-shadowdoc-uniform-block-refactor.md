> **STATUS: DONE** — shipped; ONE SieveBlock type with Attrs payload live in sieve/block/. Archived 2026-07-07.

# ShadowDoc → uniform block model — "everything is a block, addressed by id"

**Status:** Design direction captured 2026-06-19 (user-locked principles below; one
open naming decision). Branch `feature/refactor_editor_layout`. **Not yet planned
task-by-task** — bite-size via superpowers:writing-plans before executing.
**Plan it belongs under:** [`docs/superpowers/plans/2026-06-17-block-document-model.md`](../plans/2026-06-17-block-document-model.md)
(this is the cleanup the post-D-r.7 arc exposed; sequence it before/with Stage E).

## Why this exists

D-r.7 made AI targeting address blocks by id uniformly (prose + structured). That
exposed the Go side still living in the *old* world: `ShadowDocument` carries a
`Markdown string` and a `Blocks map[string]*SieveBlock` that **excludes prose**
(`editor_service.go` `syncBlocksView`: `if b.Kind != KindProse`). So a prose ref
chain (`pr-1,pr-2`) resolved to nothing — fixed by a **stopgap** (commit "Go
stopgap: AI ref chains resolve prose blocks (getBlock seam)") that added
`ShadowDocument.getBlock(id)` and snapshots the block tree into the AI job. The
stopgap is the *first brick*; this spec is the rest.

## Governing principle (user, 2026-06-19)

> "Everything is a block — there is no discrimination except at render and
> serialisation time."

The block tree is the single source of truth. A block is addressed by `id`,
regardless of kind. Kind is consulted **only** when turning a block into something
external: rendering (frontend NodeView vs native node) or serialising (fence vs
paired prose markers) or building AI context (provider vs raw content). Lookup,
addressing, lifecycle, and wiring must NOT branch on kind.

## Locked decisions

1. **`getBlock(id)` is the sole accessor.** Callers never poke a map or reach into
   attrs directly. `ShadowDocument.getBlock(id) (*<Block>, bool)` resolves "from
   wherever it needs to" (the tree today; could grow to markdown-mode parsing,
   lazy loads, etc.) — the resolution strategy is the method's private business.
2. **Retire `Blocks map[string]*SieveBlock`.** It is the structured-only legacy
   view. Every reader (`BuildContextForID` ✅ done, `expandAIBlockRefs` ✅ done,
   lifecycle/`applyJobUpdate`, `HandleBlockOp`, `FrontendBlocks`, job dispatch, …)
   moves to `getBlock` / tree walks. Then delete the map + `syncBlocksView`.
3. **Kill the `Markdown string` attribute.** "Markdown is the model" is dead.
   Whole-doc markdown is *derived on demand* by serialising the tree
   (`SerializeBlockDocWithHandles`) when a consumer truly needs a blob (save,
   markdown-mode, a `doc`-scoped AI ask). No stored `Markdown` field that drifts
   (it already drifts: D-r.5 stopped prose `doc-update`, so a prose-only session's
   `Markdown` is stale — a latent bug for `id=="doc"` asks).
4. **Rename `BlockDoc`.** The user dislikes the name. **OPEN** — pick during
   planning. Candidates: `Document`, `Doc`, `BlockTree`, `Tree`, `Notebook`.
   (`Document` collides with the existing storage `Document`; check before
   choosing.) `DocBlock` (the node) may want a paired rename too (e.g. `Block`).
5. **No brittle attribute access.** `block.Attrs["ref"].(string)` everywhere is
   fragile. Prefer typed accessors / small helpers on the block type (e.g.
   `b.Ref()`, `b.StringAttr("source")`) so a typo or shape change is a compile
   error, not a silent empty string. Scope of this vs. a bigger typing effort is a
   planning decision.

## Blast radius (audit before planning)

`grep -rn "\.Blocks\[" sieve/` and `grep -rn "shadow.Markdown\|\.Markdown\b" sieve/`
— every hit is a migration site. Known: `context_provider.go` (done),
`ai_block_processor.go` (done), `editor_service.go` (`syncBlocksView`, job
dispatch, `applyJobUpdate`, lifecycle, `FrontendBlocks`), `block_op.go`
(`HandleBlockOp`/`ApplyOp`), and the markdown-mode / save paths. Each step must
keep the app runnable + tests green (no big-bang — cf. the reverted C–F attempt).

## Folded-in follow-up: chain-active bracket on native prose (frontend)

Separate but adjacent (same "uniform block" theme). The persistent AI-chain
bracket (`block-ref-active`, the curved left rail) renders only on structured
blocks — its CSS is gated on `.block-node`/`.image-block`/`.code-block-wrapper`/
`.sieve-block--*`. Native prose carries `block-with-chrome`, so the class is added
(by `ai-block-renderer.js` `applyChain`, which correctly splits the comma ref
chain) but paints nothing. **Fix:** drive the persistent bracket through the SAME
`.block-chrome-rail` the ephemeral `block-ai-target` glow uses
(`ai-target-decoration.js` + `editor.css:2628`), so prose and structured share one
visual language (per `project_block_anchor_lineage`: extend the same language, not
a parallel one). Verify by eye in WebKitGTK. Evidence the gap is real:
`<p class="block-with-chrome">` + `block-ref-active` → `border-left: 0 none`,
`::after content: none`.

## Out of scope

- The frontend prose-id minting (tech-debt B-A) — orthogonal; keep deferred.
- `blockRef` node-type retirement + `[!block]` parser — Stage E.
- Containers / `Children` population — Stage E.

## Testing posture

Go: TDD each migration (the `getBlock` resolution, the derived-markdown helper,
each migrated reader). vitest stays the committed JS suite. In-app CDP gates stay
throwaway (Playwright harness is the planned durable home — `project_testing_strategy`).
