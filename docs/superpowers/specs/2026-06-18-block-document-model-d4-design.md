# D.4 Design — Split/Merge + Shadow-as-Source Identity

Status: **approved (build all-as-one)** — 2026-06-18
Branch: `feature/refactor_editor_layout`
Plan: `docs/superpowers/plans/2026-06-17-block-document-model.md` (Stage D, task D.4)

## Context

After D.2/D.3 the document is block-structured: the WYSIWYG editor renders from
the server's block list, and edits sync via granular `block-op`s with a
`doc-update` fallback. Prose identity is carried by `<!--s:ID-->` handle markers.

Two gaps remain:
1. **Handle-less prose has no granular sync.** Fresh notes (no on-disk markers)
   start with empty prose ids on BOTH the editor and the Go shadow, so the
   observer falls back to whole-document `doc-update`.
2. **Editor structure drifts from the model.** `sieve-block-anchor` is
   `content: 'block+'`, so pressing Enter adds a *second paragraph inside the
   same anchor*. But Go segments prose **one block per blank-line-separated
   paragraph** (`segmentBlockDoc`/`splitProseRun`), so one anchor must map to
   one prose block. Enter must split the anchor, not nest a paragraph.

D.4 closes both, retiring `doc-update` as the primary WYSIWYG path.

## Design rationale: why a prose block is one paragraph, not an arbitrary grouping

PM does not force per-paragraph blocks (`content:'block+'` already allows many
children). The **storage round-trip** forces it. A handle is a single
`<!--s:ID-->` marker with **no closing delimiter**; it binds to the one block
immediately below it. Markdown's only prose boundary is the blank line, so the
largest unit a single marker can label AND Go can re-derive on reload is one
paragraph. Grouping N paragraphs under one anchor would evaporate on round-trip
(save → N blank-line paragraphs → reload → N blocks) unless storage gained
wrapping delimiters — i.e. `[!block]…[!block-end]`, the exact heavyweight
mechanism the pivot is removing (Stage E). Per-paragraph blocks also give one
stable diff unit per edit and one handle per referenceable thing. Structured
blocks escape this because a fence is a self-delimiting markdown unit (identity
in the YAML). **Identity is only as fine-grained as plain markdown can
reconstruct, which is the paragraph.**

## 1. Identity — the shadow is the single source of truth

- **Mint on open.** `EditorService.Open` (or a mint step it calls) assigns a
  fresh `GenerateBlockID(KindProse)` handle to every prose `DocBlock` whose ID is
  empty, in the shadow's `Doc`. In-memory only; persisted on the next save via
  the existing `SerializeBlockDocWithHandles` (which writes `<!--s:ID-->`). Open
  must be idempotent — re-open returns the existing shadow with ids intact.
- **Load through the shadow.** `handleEditorLoad` ensures the shadow is open
  (idempotent `Open`) and returns the **shadow's** blocks (projected via
  `BlockDocToFrontendBlocks`) instead of an independent disk parse. Editor and
  shadow now share identity, so every prose anchor renders with a real `data-id`
  and the block-sync cache is seeded with real ids.

## 2. Sync — turn the observer into a full diff (retires doc-update for WYSIWYG)

Extend the pure `computeBlockSync` (`block-sync.js`) from "update-or-fallback"
into an id-keyed diff over the top-level block set:

- id in `curr` but not `prev` → `create-block {blockId, kind, content, index}`
- id in `prev` but not `curr` → `delete-block {blockId}`
- id in both, content or aliases changed → `update-block {blockId, kind, content, aliases?}`
- order-only change (same id set, different order) → **no op** (drag-reorder keeps
  its own `move` op path; the diff compares by id-map, order-independent)

The per-block triple gains `aliases`. Empty-id remains only a defensive fallback
that should no longer trigger now that all prose has ids. This makes the observer
correctly emit ops for split, merge, paste, and multi-block delete — not just
typing. Structured-block content changes still defer (their update-block carries
parsed `Attrs`, built Go-side via the dedicated `block-update` path).

## 3. Editor behavior — split/merge keymap (the boundary events)

- **Enter** inside a block-anchor → split into two sibling anchors (preserves
  one-paragraph-per-block). The new **tail** anchor gets a freshly minted
  client-side id (matching Go's `pr-xxxx` scheme via one shared JS generator);
  the **head** keeps its id and aliases. Mirrors Go `splitHandles` (head
  untouched, tail mints one fresh handle).
- **Backspace** at the start of an anchor → merge it into the previous anchor.
  Survivor keeps its id; the removed anchor's id + aliases **union** into the
  survivor's `aliases` attr. Mirrors Go `mergeHandles` (every existing ref to the
  removed block still resolves, zero referrer rewriting).

These are normal user-command transactions — mutating the doc inside a command is
fine; the Stage D anti-pattern is mutating inside `onUpdate`. The debounced
observer then emits the precise create/delete/update ops from the resulting diff.
Keep the keymap thin (structural edit + mint only); all op derivation stays in
the TDD'd pure diff.

## 4. Testing

- **Go (TDD):** Open mints handle-less prose; load returns shadow blocks with
  ids; edit → flush → save persists `<!--s:ID-->` markers for newly-minted prose.
- **JS (TDD, vitest):** extended `computeBlockSync` — create on added id, delete
  on removed id, update on content/alias change, no-op on order-only change,
  defensive fallback only on empty id.
- **Manual eyeball (CDP unavailable in this env):** Enter adds exactly one block,
  Backspace removes exactly one, undo stable; fresh-note typing emits `block-op`
  (not `doc-update`); reopen round-trips.

## 5. Risks & mitigations

- **Open/load lifecycle change** (load now ensures-open): keep `Open` idempotent;
  WS disconnect still closes the shadow. Verify no double-open / premature close
  on tab switch.
- **Client id format** must match Go's `pr-xxxx`: centralize one JS id generator;
  ids only need to be unique within the open doc (Go owns cross-doc guarantees).
- **Keymap is PM-coupled and eyeball-only**: keep pure diff logic in `block-sync.js`
  (TDD), keep the keymap command minimal.
- **Observer vs keymap coordination**: the keymap only edits + mints; it does NOT
  emit ops directly. The single debounced observer derives all ops from doc state,
  so there is one sync path and no double-emit. The keymap-minted tail id is set
  in the transaction, so the diff sees a real new id (create-block), not an empty
  one.

## Gate (from the plan)

Enter adds exactly one block, Backspace removes exactly one, undo stable; granular
ops fire on fresh notes; save round-trips.
