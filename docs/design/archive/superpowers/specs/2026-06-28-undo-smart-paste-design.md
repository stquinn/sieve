> **STATUS: DONE** — shipped; ActionUndoSmartPaste in ProseProcessor live. Archived 2026-07-07.

# Undo Smart Paste — design

**Date:** 2026-06-28
**Branch:** `feature/transform_operation_frameworkk`
**Status:** Approved (brainstorming), pending implementation plan.

## Context

"Embed in Document" is the prose `Transform` affordance — the universal sink that
flattens a structured block into the document. A prior change (`0d1b789`, kept by the
recent bugfix `5a59c45`) made it embed a code/diagram/log block as **plain de-indented
text** rather than its faithful markdown. That was an over-reach: it fused two
unrelated user intents into one verb.

- **Faithful embed** — "I'm done being clever with this block; make it markdown."
  A code block becomes a native ` ```java ` fence, a diagram a ` ```mermaid ` fence, a
  log a ` ```log ` fence. The block stops being a managed Sieve block and becomes a
  plain native fence. (Document load does **not** re-run detection — Sieve only
  recognises its own ` ```code `/` ```diagram ` YAML fences, never native ` ```java `/
  ` ```mermaid ` — so the dissolve is permanent.)
- **Undo smart paste** — the escape hatch for when the smart-paste pipeline
  over-grabbed text as code (brackets `{}<>[]` trip a language match) and the user
  actually wanted plain text.

This spec un-fuses them: "Embed in Document" returns to faithful markdown, and the
escape hatch becomes a separate, **framework-detected, framework-actioned** operation
— "Undo Smart Paste" — that flows through the same recognition→action pipeline as
Extract/Transform. The frontend stays dumb: it renders whatever the framework offers
and dispatches the operation; it does not decide whether undo applies.

## Non-goals

- Diagram → image rendering (a separate, larger feature).
- A per-kind `affordanceLabel(kind, action)` hook (backlog defect #2); the frontend
  maps the known action enum to its label for now.
- Auto-clearing the tag when a block is edited (explicitly chosen: persist, never
  auto-clear).

## Design

### 1. `ActionUndoSmartPaste` — a first-class Action

Add `block.ActionUndoSmartPaste Action = "undo-smart-paste"` alongside
`ActionPaste`/`ActionExtract`/`ActionTransform`. It is recognised, offered, and
actioned through the existing pipeline. Mechanically it is a replace-in-place
transformation (like `ActionTransform`): it replaces the smart-pasted block by id with
a prose block of raw text, preserving document position.

### 2. Detection (Go, in `ProseProcessor`)

`ProseProcessor.IsSupportedContent` already claims any sieve source for
`ActionTransform` (the universal sink). Extend it: when an entry's sieve view carries
`smartPaste == true` **and** that source kind exposes non-empty `RawContent()`, include
`ActionUndoSmartPaste` in the returned actions.

- A smart-pasted code block's prose offer → `{transform, undo-smart-paste}`.
- A hand-made / explicitly-inserted code block → `{transform}` only.

`DetectExtractions` composes this with no special-casing — it already iterates
processors and collects `SupportedActions`. The existing nested-source `asAdditive()`
demotion only touches `ActionTransform`; smart-pasted blocks are always top-level, so
undo is never nested and needs no interaction with that rule.

The `smartPaste` flag reaches detection because the frontend's framework view
(`sieveFrameworkEntry` → `sieveBlockAttrs`) serialises **all** node attrs, and
`smartPaste` is a declared sieve-node attr. The backend reads it via `SieveAttrs`.

### 3. Action (Go)

`ProseProcessor.Transform(entries, uuid, blockID, action)` already receives the action
— branch on it:

- `ActionTransform` → the source kind's `MarkdownRepresentation` ("Embed in Document").
- `ActionUndoSmartPaste` → `sourceAsPlainText(sourceProcessor.RawContent(block))`
  (de-indent each line, join with markdown hard breaks, drop blank lines — the existing
  `sourceAsPlainText` logic).

`EditorService.CreateBlockFromEntries` routes both `ActionTransform` and
`ActionUndoSmartPaste` to `transformInPlace` (replace-by-id). `transformInPlace` passes
the action through to `processor.Transform` so prose picks the right derivation. The
render-back is the existing `replace-block`.

### 4. Tagging (Go service)

- **Stamp:** `EditorService.HandlePaste` stamps `smartPaste: true` only when the match
  came from `FirstPasteMatch`'s **pass-2** (general detection / cross-kind upgrade) —
  not pass-1 self-kind round-trips, not explicit UI inserts. `FirstPasteMatch`
  therefore reports which pass produced the match (e.g. returns a `fromDetection bool`
  or a small result struct).
- **Persist:** `smartPaste` lives in the block's attrs and serialises to YAML. It
  round-trips on reload and is **never auto-cleared**.
- **Raw-text accessor:** a `RawContent() string` optional interface (type-asserted),
  implemented by code/diagram/log to return their `source`. Undo uses it to get the raw
  text uniformly; this also retires the backlog smell where `prose.Transform`
  hard-codes `code/diagram/log` by kind name. A tagged kind with empty `RawContent()`
  simply does not get the `undo-smart-paste` offer (detection gate in §2).

### 5. Frontend (dumb)

- `smartPaste` is declared as a sieve-node attr so it round-trips YAML→node→framework
  view (this is what carries it back to backend detection).
- The extract/affordance menu maps action `undo-smart-paste` → label "Undo Smart
  Paste". This is the only frontend behavioural touch; the menu otherwise renders
  offers exactly as today.
- The dispatch path (`sieve:extract` → WS `extract` `{operation, blockId, ...}` →
  `handleExtract` → `CreateBlockFromEntries`) is unchanged; `operation` is just
  `undo-smart-paste`.

### 6. Reverts

Revert `0d1b789` and the `5a59c45` prose `Transform` branch so the `ActionTransform`
path again returns `MarkdownRepresentation` for code/diagram/log. **Keep**
`sourceAsPlainText` — it moves to the `ActionUndoSmartPaste` branch.

## Data flow

```
Smart paste (pass-2 detection)  ──► block created with smartPaste:true (YAML + node attr)
                                          │
right-click / affordance detect  ──► /api/detect-extractions (entries incl. framework view w/ smartPaste)
                                          │
ProseProcessor.IsSupportedContent  ──► {transform, undo-smart-paste}   (undo only if smartPaste && RawContent≠"")
                                          │
menu renders offers  ──► "Embed in Document"  +  "Undo Smart Paste"
                                          │  (user picks Undo)
sieve:extract {operation:"undo-smart-paste", blockId}  ──► handleExtract ──► CreateBlockFromEntries
                                          │
ActionUndoSmartPaste ──► transformInPlace ──► prose.Transform(action=undo-smart-paste)
                                          │     └► sourceAsPlainText(sourceProc.RawContent(block))
ReplaceBlock(blockId, prose)  ──► replace-block render-back ──► editor shows de-indented prose
```

## Testing

**Go**
- `FirstPasteMatch` reports the matching pass (self-kind vs general detection).
- `HandlePaste` stamps `smartPaste` on pass-2 only — not on a self-kind round-trip
  paste, not on explicit creation.
- `ProseProcessor.IsSupportedContent` offers `undo-smart-paste` **iff** an entry's
  sieve view has `smartPaste:true` and the kind's `RawContent()` is non-empty; a
  hand-made block offers only `transform`.
- `prose.Transform` with `ActionTransform` for code returns the fenced
  `MarkdownRepresentation` (update the existing
  `TestProseProcessor_Transform_codeSourceEmbedsAsSafePlainText` expectation).
- `prose.Transform` with `ActionUndoSmartPaste` returns de-indented hard-broken prose
  (move the goldmark "no `<pre>`, hard breaks present, source preserved" assertions
  here).
- `CreateBlockFromEntries` routes `ActionUndoSmartPaste` to replace-in-place.
- `RawContent()` returns `source` for code/diagram/log.

**vitest**
- The affordance menu shows "Undo Smart Paste" when the offer includes
  `undo-smart-paste`, and not otherwise.

## Open items folded in

- "Embed in Document" stays offered on every structured kind (universal sink) — now
  honest, since it produces faithful markdown.
- The undo offer lives in `ProseProcessor` (the kind that owns the result), consistent
  with the per-processor `IsSupportedContent` pattern — not special-cased in the
  registry composer.
