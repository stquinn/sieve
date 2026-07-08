# SelectionModel — one owner for selection, focus, and AI-target state

**Status:** Draft
**Tracked:** #31 (epic) — implemented in phase #29
**Date:** 2026-07-08

## Problem

Six frontend consumers answer the same question — *"what does the user have
selected/focused right now?"* — each with its own listeners and its own private
copy of the answer:

1. **Block styling / chrome** — focus class, drag-select preview tint,
   NodeSelection claim (`block-click-selection`, `sieve-block-extension`).
2. **Copy / cut / drag-drop** — PM selections, DOM selections inside read-only
   NodeView regions (`domSelectionBlockRange`), mixed prose+sieve selections.
3. **AI target resolution** — `resolveAiTarget` + the Ask pin
   (`pendingAskCtx`) + panel label + glow decoration + `==mark==` anchor.
4. **Focus capture/restore** — `captureFocusContext`/`restoreFocusContext`
   for Ask-panel jump-in/out.
5. **Paste context** — `caretInRawTextBlock` (caret-side only; the paste
   *content* pipeline is out of scope, see Non-goals).
6. **Ask panel label refresh** — `updateAskPanelLabelLive` on its own triggers.

Because there is no single owner, every improvement to one consumer silently
strands the others. The git record is the argument:

- `80e65c0` "Copy and PASTE and Node selection is an absolute mess"
- `e789cf4` drag-select preview tint (styling only)
- `90c2065`, `b564ada` mixed-selection copy (copy only)
- `3bd11c2` uniform block selection ownership + focus styling (click half kept
  AI targeting in sync; the drag-guard half did not)
- `6ee94bd` copy respects DOM highlight in read-only regions
  (`domSelectionBlockRange` — **copy got it; AI targeting never did**)
- `8c5ed6a`, `5b8468b`, `1727f11` Ask target cue / focus restore fixes

The 2026-07-08 AI-target review found the same pattern as live defects:
a pin (`pendingAskCtx`) cleared only on send, so it survives caret moves,
panel close, and note switches (F1); a pinned label never displayed (F2);
label/glow refresh blind to every non-PM selection change (F3); glow and send
target wired to different sources (F4); AI targeting blind to the exact
read-only-region selections copy learned to see in `6ee94bd` (F5).

## Decision

Introduce **one mechanism** — the same move the editor already made for
keyboard interaction with the InteractionPolicy extension (shared policy owns
the keys; per-renderer `handleKeyDown` forbidden). Apply it to selection:

> A single `selection-model.js` is the ONLY code that observes the raw
> selection/focus sources. It normalizes them into one canonical state and
> notifies registered listeners. Every consumer subscribes; no consumer reads
> `window.getSelection()`, `state.selection`, or `document.activeElement`
> directly. The prohibition is normative in
> `docs/editor-interaction-contract.md`.

## Architecture

### Canonical state

```js
{
  kind: 'caret' | 'text' | 'node' | 'dom-range' | 'none',
  // PM coordinates when the selection lives in ProseMirror; block id plus DOM
  // offsets when it lives in a read-only NodeView region (dom-range).
  range: { from, to } | null,
  blockId: '',            // enclosing/selected top-level block, when one exists
  blockIds: [],           // the ref chain: every top-level block crossed
  focusZone: 'editor' | 'block-inner' | 'ask' | 'markdown' | 'outside',
  generation: N,          // monotonic counter — staleness is finally detectable
}
```

### Inputs (the model's private listeners)

- PM selection changes (a ProseMirror plugin's `apply`/`onSelectionUpdate`).
- DOM `document.selectionchange` (read-only regions, markdown textarea).
- Focus/blur transitions (zone tracking).
- Block-chrome click/drag notifications (NodeSelection claims, drag-guard).

`domSelectionBlockRange` (from `6ee94bd`) moves into the model as the
`dom-range` normalizer — AI targeting, styling, and any future consumer
inherit read-only-region selections for free.

### Output — one contract, two access modes

The canonical state is exposed as a **`SelectionContext`**: an immutable
frozen snapshot, re-minted on every change, carrying coordinates, ids,
`focusZone`, `generation`, and derived context (block kind, snippet, label,
`docUuid`). It is inert, plain data — JSON-able values only, NEVER a live
ProseMirror node or TipTap object (full encapsulation: no PM type crosses the
Editor boundary; today's `resolveAiTarget` returning a PM `node` is a leak
this contract closes). Verbs (`restore`, highlight application) live on the
model, never on the context.

- **Push** — registered listeners, not DOM events: the Editor notifies its
  Holder (Tab) via typed callbacks; residents (Ask panel, chrome) register
  on the permanent Workspace (`workspace.onSelectionUpdate(fn)`), which
  republishes the active tab's stream and synthesizes an update on tab
  switch. Each callback receives the current frozen `SelectionContext`.
- **Pull** — `getSelectionContext()` returns the same current object,
  synchronously, for transient/imperative consumers executing at an
  arbitrary moment: menu-item handlers (which call the Editor's JS API via
  `getCurrentTab().getEditor()` under the App-Level Chords ownership rule),
  keyboard chords, context-menu actions, export, block inserts. This replaces today's ad-hoc reads (`currentUuid` guards,
  `data-uuid` DOM fallbacks, `domBlockId()` peeking).
- Because contexts are frozen snapshots, code holding one across an await
  can detect drift: `ctx.generation === getSelectionContext().generation`.
- The model is a facet of the per-tab **Editor object**
  (`2026-07-08-workspace-editor-component-model.md` — a PREREQUISITE of this spec, not an
  option): one Editor per tab, stable across mode flips, owning document,
  meta, mode, selection, and private mode-swapped input surfaces. The
  accessor is `editor.getSelectionContext()`. The Editor outlives mode switches, so its
  SelectionContext is never null — PM-specific fields are null in markdown
  mode. The model is born INSIDE the Editor boundary (component-model spec phase 3);
  it is not built module-level first — hosting it on the global bus would
  recreate the X-C coupling this pair of specs exists to end.

Consumers are pure readers:

- **Styling/chrome** derives focus class and drag tint from `kind`.
- **Copy/cut/drag-drop** serializes from the state.
- **AI targeting**: `resolveAiTarget(state, doc)` becomes a pure function —
  no `domBlockId()` DOM-peeking inside. Label and glow subscribe to the same
  event, so they can never disagree with the send target.
- **Focus capture/restore** reads/writes `focusZone` + state.

### The Ask panel is a stateless consumer (no pin)

There is no pin. `pendingAskCtx` existed only because the context-menu Ask
path handed the panel a target out-of-band (`precomputedCtx`), which then
needed an expiry policy. That side-channel is deleted: any "Ask about this
block" affordance must **assert the selection first** (NodeSelection on the
block — already the behaviour since `3bd11c2`), then open the panel. The
explicit intent is thereby in the selection stream like every other target.

The panel is a pure listener: registered via
`workspace.onSelectionUpdate`, it re-renders its label on every update
(including tab switches, which the Workspace synthesizes), derives the glow
from the same state, and at SEND reads the latest state. The event payload carries everything it needs to be
stateless — `docUuid`, `kind`, `blockId`/`blockIds`, `range`, and derived
context (block type, snippet label). Review findings F1–F4 are not fixed;
they become unrepresentable — there is no captured copy to go stale.

One load-bearing rule: when focus moves to the `ask` zone, the
document-selection component of the state PERSISTS (PM keeps its selection;
the model must not discard it on zone change). Select text → jump in → send
still targets the selection, and the label keeps saying so.

## Phases

> Sequencing: these phases begin at **phase 3 of the component-model spec** —
> the Editor shell and contract freeze come first; the model is born inside
> that boundary.

1. **Phase 1 — model + AI targeting.** Build `selection-model.js`, wire the
   four inputs, port AI targeting: `resolveAiTarget(state, doc)`, the
   stateless Ask panel (delete `pendingAskCtx` and the `precomputedCtx`
   side-channel; block affordances assert selection then open), label and
   glow as event subscribers. Subsumes the entire F1–F5 fix package. Vitest:
   the normalizers are pure functions; extend the existing
   `ai-target.test.js` fixture.
2. **Phase 2 — copy + block styling/chrome.** Port them; delete their private
   listeners (`domSelectionBlockRange` call sites collapse into the model).
3. **Phase 3 — focus capture/restore + enforcement.** Port
   capture/restoreFocusContext, purge every remaining raw listener, add the
   normative App-Selection section to the interaction contract, and adopt the
   grep-able convention: raw `getSelection()`/`activeElement` outside
   `selection-model.js` fails review.

## Non-goals

- The paste **content** pipeline (`FirstPasteMatch`, smart-paste, backend
  block creation) is untouched — it owns incoming content, not selection.
- PM's own selection semantics are unchanged (a blurred editor keeps its
  TextSelection; select → jump to Ask → send remains the core flow — the model
  just guarantees label/glow always tell the truth about it).
- No Go changes. The backend continues to receive a resolved `ref`.

## Rationale

- **Precedent works.** The InteractionPolicy extension ended the per-renderer
  keyboard whack-a-mole; this is the same shape for selection.
- **Statelessness beats invalidation.** The Ask panel holds no captured
  target, so the stale-capture class (F1/F3/F4, the original fixation report)
  is unrepresentable. The `generation` counter remains for the consumers that
  legitimately snapshot — focus capture/restore detects doc drift with a real
  signal instead of a re-resolve heuristic.
- **One normalizer** means the next `6ee94bd`-class fix lands once, for every
  consumer, forever.
