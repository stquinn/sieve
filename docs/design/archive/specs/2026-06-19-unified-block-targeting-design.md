> **STATUS: DONE** — shipped; D-r.7 resolveAiTarget/blockInsertPos live. Archived 2026-07-07.

# Unified Block Identity + AI Targeting — "they're all Sieve blocks, just different kinds"

**Status:** Approved design (2026-06-19). Branch `feature/refactor_editor_layout`.
**Plan:** [`docs/design/archive/plans/2026-06-17-block-document-model.md`](../plans/2026-06-17-block-document-model.md) — folds in as a new bite-sized task set under Stage D (it is the deferred AI-targeting rewire, now unblocked by D-r.4 id minting).
**Retires tech-debt:** `project_ai_targeting_blockref_defect` (Ask AI → `ref:doc`; legacy depth-0 `blockRef` wrap vs native prose).

## Why this exists

After the node-granular prose pivot (Stage D), prose is **native top-level TipTap nodes** carrying identity on `attrs.blockId`, while structured blocks are `sieve-*` nodes carrying identity on `attrs.id`. The AI targeting/insert layer predates this — it recognizes a block only when the node is `blockRef` or `sieve-*` and reads `attrs.id`. Two user-visible bugs follow:

1. **Ref chains point at `doc`.** A *text selection* in prose should reference the block(s) it spans, but `resolveAiTarget`'s selection branch (`ai-target.js:129`) returns `{kind:'selection'}` with **no block id**, so `buildAiContext` (`extensions.js:318`) falls through `t.blockRef || 'doc'` → `doc`. In the old model the id came from wrapping the selection in a `blockRef` anchor; native prose has no such wrap.
2. **Answers split the target block.** `aiInsertPos` (`ai-target.js:141`) walks for `blockRef`/`sieve-*` ancestors, finds none in native prose, and returns `selection.to` (the caret) → `insertContentAt(caret)` splits the paragraph instead of inserting a sibling after it.

Both have one root: **the targeting layer keys on the legacy block identity (`blockRef`/`sieve-*` + `attrs.id`), not on the new uniform fact that every block — prose or structured — is now a top-level (depth-1) node with an id.**

## Governing principle

A Sieve block is a **top-level (depth-1) node identified by an `id` attribute**, regardless of kind. Prose blocks (`native:true` in `block-kinds.js`) and structured blocks (`native:false`, `sieve-*`) differ only in how they render and serialize — **not** in how they are identified, targeted, or positioned. The targeting/insert layer addresses *the block*, never *the kind*.

## Locked decisions

1. **Identity:** unify the prose identity attribute `blockId` → `id`. Every block node — prose and `sieve-*` — carries `attrs.id`.
2. **Target model** keys off one discriminator — **is the enclosing top-level node a *flowing-text* block?** Flowing-text = `paragraph` or `heading` **only**; every other top-level node (blockquote, code block, list, table, image, hr, and all structured `sieve-*`) is a **unit**. Three outcomes (below): a selection highlights its text + refs every block it crosses; a bare caret in a unit targets that unit by id; a bare caret in flowing text → `doc`.
3. **Insert rule:** inline kinds insert at the caret; block kinds insert as a new sibling **after** the enclosing top-level block.
4. **DOC insert position:** even a doc-scoped answer inserts **after the caret's current top-level block** (never at the caret → never splits).

## Target resolution

`resolveAiTarget(editor, isMarkdownMode)` returns one of three shapes. Markdown mode is unchanged (selection → `selection`, else `document`). The discriminator is `isFlowingText(node) = node.type.name === 'paragraph' || node.type.name === 'heading'`, applied to the **top-level (depth-1)** node containing the caret. **Selection type matters:** a whole-node **NodeSelection** (clicking an image / hr / structured block) is a *unit* target, not the text branch; only a non-empty **TextSelection** takes the selection branch. The cases are evaluated in this order:

| # | Condition | `kind` | `ref` / id | `==` highlight |
|---|---|---|---|---|
| 1 | **NodeSelection** of any block (image, hr, structured `sieve-*`, …) | `block` | that node's `attrs.id` | no |
| 2 | Non-empty **TextSelection** | `selection` | id(s) of **every top-level block the selection crosses**, in document order, comma-joined into a ref chain (single block → its id) | yes — `==` applied to the selected words |
| 3 | Bare caret whose top-level node is a **unit** (blockquote, code, list, table, structured `sieve-*`) | `block` | that node's `attrs.id` | no |
| 4 | Bare caret in **flowing text** (`paragraph` / `heading`), empty area, or nothing selected | `document` | `doc` | no |

**The discriminator is node *character*, not prose-vs-structured.** A bare caret in a paragraph or heading → `doc` (old behaviour — flowing text a bare caret can't disambiguate). A bare caret anywhere else top-level (a list, a table, a code block, a structured block — all discrete units you can't partially select) → that unit by id. A selection always wins, regardless of what it sits in. The aiBlock **follow-up chaining** (`extensions.js:322` — chain a follow-up onto its AI block's own ref so Go assembles history) is preserved (an AI block is a unit).

### How a selection gets its ref chain (the bug-1 fix)

Each top-level block already has an `id` (minted in D-r.4). So instead of wrapping the selection in a `blockRef` anchor and re-resolving, the selection branch **iterates the top-level (depth-1) nodes the selection range covers** (`doc.nodesBetween(sel.from, sel.to)` filtered to depth 1, or a `$from`/`$to` index walk) and joins their distinct `attrs.id`s in document order into the ref chain. A selection inside one block → that one id; a selection dragged across three → all three. `applyTargetHighlight` (`extensions.js:358`) reduces to **just applying the `==` highlight mark** — the `wrapInBlockAnchor` call is dropped (the block is already addressable). The `blockRef` *node type* is not removed here (its retirement is Stage E); it simply stops being created for prose selections.

## Insert position

One helper replaces the scattered `sieveInsertPos = selection.to` defaults:

```
blockInsertPos(state, isInline):
  if isInline:                      return state.selection.to        // caret (e.g. smart-link)
  if state.selection.node:          return state.selection.to        // NodeSelection: already after the block
  return state.selection.$to.after(1)                                // after the last top-level block spanned
```

- `isInline` is read from the inserted node's schema (`schema.nodes['sieve-'+kind].isInline`) — smart-link is already `inline:true` (`smart-link-renderer.js:24`). No new registry flag.
- The `editor:insert-block` handler (`editor.js:794`) computes the position from the kind instead of consuming an ad-hoc `sieveInsertPos`. Block answers therefore land **after** the target block (selection's block, the structured block, or the caret's top-level block for a `doc` target) — never split.
- **Unaffected (kept as-is):** in-place conversion / extraction, where a native source node *becomes* a sieve block via an object `{from,to}` target (range replace, `editor.js:838`), and explicit-position pastes. These are replacements/explicit placements, not additive block inserts.

`aiInsertPos` is replaced by `blockInsertPos` for the AI path; the same helper is the single source for every additive block insert.

## Identity unification details

`blockId` → `id` is confined to the **PM node-attr layer**. The on-disk paired markers carry the id *value*, not the attr name, so the byte-stable round-trip is untouched.

- `prose-block.js`: the `BlockId` extension's `addGlobalAttributes` attribute key `blockId` → `id`; `parseHTML`/`renderHTML` still bind to **`data-id`** (a literal HTML `id=` is intentionally NOT emitted — avoids DOM duplicate-id collisions); the mint plugin reads/writes `node.attrs.id`; `identityAttr: 'id'`. `PROSE_NODE_TYPES` unchanged.
- `editor.js`: `topBlockTriple` (`:204`) collapses to one branch — both kinds read `node.attrs.id`; `renderBlocksIntoEditor` stamps the loaded id onto the native node's `id` attr; comments updated.
- `extensions.js`: `T.BlockId` handle unchanged (re-exported from `prose-block.js`).
- Downstream is already id-normalized: `topBlockTriple` emits `{id}`, so `block-sync.js`/`computeBlockSync` need no change.

**Caveat to verify in-app (WebKit gate):** the minting plugin and `renderBlocksIntoEditor` must not collide with any other extension's notion of an `id` attribute on native nodes; confirm no extension already injects an `id` global attribute and that no literal `id=` reaches the DOM.

## Out of scope (noted, not now)

- **`blockRef` node-type retirement** and any word-granularity (sub-block) ref resolution beyond the `==` marker — Stage E.
- **Structured-block granular content sync** — still the `doc-update` fallback (D-r.5 scope note).
- **Multi-block `==` semantics on disk** beyond what the existing HighlightMark serializer already does (`==`…`==` per run).

## Testing

**vitest (pure / real PM schema):**
- `resolveAiTarget`, selection: in one paragraph → `{kind:'selection', ref:<that block id>}` + `==`; dragged across two paragraphs → ref chain of both ids in order; across three → all three.
- `resolveAiTarget`, bare caret by node character: in a `paragraph`/`heading` → `document`; in a `bulletList`/`table`/`codeBlock`/`blockquote`/`image`/`horizontalRule` → `{kind:'block', ref:<its id>}`; on a `sieve-*` block → `{kind:'block', ref:<its id>}`; aiBlock follow-up → chained ref; empty doc → `document`.
- `blockInsertPos`: caret mid-paragraph, block kind → `$to.after(1)` (sibling, no split); selection across two blocks → after the **last** (`$to.after(1)`); NodeSelection of a block → `sel.to`; inline kind → `selection.to`.
- Identity: mint plugin fills `attrs.id` (empty-or-duplicate → mint); native Enter split → two unique `id`s; serialization round-trip byte-stable (markers unchanged).
- `applyTargetHighlight`: a selection applies the `==` mark and creates **no** `blockRef` node.

**In-app (WebKitGTK / CDP, throwaway note, deleted after):**
- Select words in a paragraph → Explain → answer lands **after** that block (not split), `ref` = that block's id (not `doc`), words show `==`.
- Selection dragged across two paragraphs → ref chain of both ids; answer after the second.
- Bare caret in a paragraph → Ask → `ref:doc`, answer after the caret's top-level block.
- Bare caret in a list / table / code block → ref = that unit's id, answer after it.
- No `nodeDOM`/`descAt` errors; reopen byte-stable.
