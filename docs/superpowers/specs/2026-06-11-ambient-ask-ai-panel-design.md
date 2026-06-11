# Ambient, Context-Aware Ask AI Panel — Design

**Date:** 2026-06-11
**Branch:** `feature/refactor_editor_layout`
**Status:** Design — pending review

---

## 1. Problem

Today "Ask AI" is a positioned, transient dialog: you take an explicit action
(right-click → Ask AI, toolbar, shortcut), the dialog opens *positioned over the
thing you acted on*, and the target is frozen at the moment you opened it.

We want Ask AI to be a **first-class, always-on panel** (toggleable like the meta
panel) that is **continuously context-aware**. As focus and selection move through
the document, the panel's target updates live. You can still right-click a specific
block to ask about *that* block explicitly, but you can also drift around the
document and hit `Ctrl+Shift+A` to jump into the panel with the target already set
to whatever the caret is on.

The uncommitted work on this branch is a first prototype of this direction:
`getAiTargetLabel` (a read-only label tracker), `updateAskPanelLabelLive` (fires on
selection/transaction/focusin), a pin button replacing the close button, and a
send-time (rather than open-time) context build. This spec consolidates that
prototype into a clean architecture.

---

## 2. Goals & Non-Goals

**Goals**
- Ask AI is a persistent, pinnable panel, not a positioned dialog.
- The target tracks caret/focus/selection **live**, with no document mutation.
- Both the panel **label** and an on-document **glow** reflect the live target, and
  are guaranteed to agree.
- Explicit right-click → Ask AI still works and **overrides** ambient tracking.
- The blockRef/`==` highlight commit happens **only at SEND**, and only for the one
  target kind that needs it.

**Non-Goals (dropped scope)**
- **Native code blocks / tables as a distinct target kind are dropped.** They are
  the only thing that fits none of the four target kinds cleanly. To ask about a
  native code block, Convert it to a Smart Code block (existing context-menu
  affordance) — then it is a Sieve Block and asking works. Caret in a native node
  with no conversion falls back to `Document` (or `Selection` if text is selected),
  never an error.

---

## 3. Target Taxonomy

There are exactly **four** things you can ask about. `resolveAiTarget` always
returns exactly one of them.

| Kind | What it is | Has a stable `id` already? | What SEND does |
|------|-----------|----------------------------|----------------|
| `sieveBlock` | any `sieve-*` atom node (incl. `sieve-ai-block`) | yes (`attrs.id`) | nothing — reference the id |
| `anchor` | an existing `blockRef` (a previously-committed `==` highlight target) | yes (`attrs.id`) | nothing — reference the id |
| `selection` | a live text selection with no anchor yet | no | **mints a new anchor** — wrap in `blockRef` + apply `==` + generate id |
| `document` | the fallback: caret resolves to none of the above | n/a (`blockRef: 'doc'`) | nothing — whole-document context |

**Key consequence:** of the four, only `selection` mutates the document — and only at
SEND. `sieveBlock` and `anchor` are pure references to something that already exists;
`document` is the implicit whole-doc context. This is *why* `selection` is special:
it is the act of **minting** an anchor; the others merely **point at** one.

**Sub-cases that fold in (not new kinds):**
- **Follow-up** = the `sieveBlock` case where the block is `sieve-ai-block`. The
  resolver labels it "Follow-up" but it is mechanically a Sieve Block reference.
- **Document** is defined by exclusion, not as an error state.

---

## 4. Architecture

### 4.1 One pure resolver — the spine

```
resolveAiTarget(editor, isMarkdownMode) → { kind, id?, range?, label }
    // kind:  'sieveBlock' | 'anchor' | 'selection' | 'document'
    // id:    present for sieveBlock / anchor
    // range: present for selection / sieveBlock / anchor (for the glow)
    // label: the friendly label, from describeTarget (§4.2)
    // READ-ONLY. Performs no mutation, ever. Safe to call on every caret move.
```

This absorbs the tree traversal currently **duplicated** between:
- `buildAiContext` (extensions.js:393 `labelFor`, plus the wrap/markup commit), and
- `getAiTargetLabel` (extensions.js:527 `labelFor`, a byte-for-byte copy).

After this change there is **one** traversal. Three consumers, structurally unable
to disagree:

| Consumer | Uses |
|----------|------|
| live panel label | `'Ask About ' + descriptor.label` (or `'Ask Follow-up'`) |
| live glow | `setMeta(aiTargetKey, { range: descriptor.range })` |
| commit (SEND only) | takes the descriptor; mutates **only** if `kind === 'selection'` |

### 4.2 One label source — `describeTarget`

A single helper (folded into the resolver) is the sole producer of the friendly
name. No more parallel label generators.

| Kind | Label |
|------|-------|
| `sieveBlock` | `renderer.buildAiCtx(node).contextLabel \|\| titleCase(node.attrs.kind)` — the **same** name the context menu and commit path already use. "JavaScript Block" comes free if the code renderer surfaces its language in `buildAiCtx`. `sieve-ai-block` → "Follow-up". |
| `anchor` | the anchored / highlighted word(s) — anchors resolve to highlighted-word granularity (see block-anchor-lineage). |
| `selection` | the quoted selection text, truncated. Markdown mode reads the textarea substring; rich mode reads `doc.textBetween`. |
| `document` | `"Document"` |

`renderer.buildAiCtx(node)` is **pure** (sieve-block-extension.js:144 — reads
`node.attrs` only), so it is safe to call on every caret move.

**Selection label format:** quoted, original case preserved, trailing ellipsis on a
word boundary at ~20 chars. `Ask About "product"`, `Ask About "the quarterly reve…"`.
(CSS may uppercase the chip for display; the underlying text keeps real case.)

### 4.3 One ephemeral glow — its own tiny plugin

A new `AiTargetDecoration` ProseMirror plugin, **separate** from `blockChrome`:

```
AiTargetDecoration:
  state:  { range: {from,to} | null }
  set via: tr.setMeta(aiTargetKey, { range })   // or { range: null } to clear
  props.decorations: one Decoration.node(from, to, { class: 'block-ai-target' })
```

**Why its own plugin, not folded into `blockChromeKey`:** block-chrome owns gutter +
drag + multi-block selection, with its own lifecycle. AI targeting is a different
concern driven by the panel being open. ProseMirror composes decorations from
multiple plugins onto the same node for free, so there is no collision. Critically,
block-chrome deliberately **suppresses** hover glows while a selection is active
(the `has-selection` toggle, block-chrome.js:462) — the AI glow must *not* be
suppressed that way, because the target frequently **is** the selection.

**What is shared is the CSS vocabulary, not the state machine.** `block-ai-target`
extends the chrome rail/gutter accent (same colour family, lights the same rail), so
it reads as the same visual language — honoring the block-anchor-lineage principle
(extend the one visual vocabulary, don't fork a parallel one).

**Glow treatment per kind:**
- `selection`, `sieveBlock` → ephemeral `block-ai-target` decoration (nothing
  committed exists to show).
- `anchor` → the anchor **already carries its own `==` mark**; "targeting an anchor"
  means lighting *that existing anchor* up, not painting a competing glow over it.
  The anchor's own visual *is* the target indicator.
- `document` → no glow (the whole doc is the implicit target).

> **Open design choice (visual reach), to settle during implementation:** does the
> glow light the gutter chrome only (rail + line-number), the block body (tint /
> outline), or both (rail as anchor + faint body wash)? Current lean: **both** —
> unmistakable when the target jumps, yet visually distinct from a text selection.

### 4.4 Commit at SEND

On SEND, `doAsk` resolves the target one final time and:
- `kind === 'selection'` → run the existing `buildAiContext` mutation (wrap in
  `blockRef` + `==` mark + mint id), then **clear** the glow
  (`setMeta(aiTargetKey, { range: null })`). Ephemeral glow out, committed `==` in —
  they never co-exist, so there is no double-paint to reconcile.
- `kind` is `sieveBlock` / `anchor` / `document` → no mutation; build context from
  the existing id (or `'doc'`) and run the job. Clear the glow.

### 4.5 Focus toggle & return selection

`Ctrl+Shift+A` is a **focus toggle**, modelled on `Ctrl+Enter` flipping a diagram
block's mode — you jump in and out of the Ask box as you see fit. Focus and panel
visibility are **separate axes**: the pin controls whether the panel stays visible;
`Ctrl+Shift+A` only bounces focus.

State: a module-level `returnSelection` (a saved editor selection).

- **Jump IN** (`Ctrl+Shift+A` while the editor is focused, or any open of the box):
  capture `currentEditor.state.selection` into `returnSelection`, then focus the Ask
  textarea. While focus is in the textarea the editor is blurred, so no
  `selectionUpdate` fires and the label/glow naturally **hold** on the captured
  target — the implicit "freeze while composing."
- **Jump OUT** (`Ctrl+Shift+A` while the textarea is focused): focus the editor and
  **explicitly restore** `returnSelection` (`setTextSelection` / `setNodeSelection`).
  Do **not** rely on ProseMirror's implicit blur-retention — restore deliberately so
  it survives the panel having taken selection. If the panel is unpinned, it may also
  hide; if pinned, it stays visible and ambient tracking resumes.
- **SEND**: after `runAiJob`, focus the editor and restore `returnSelection`. For the
  `selection`-mint case the wrap transaction shifts positions, so `returnSelection`
  is **mapped through that transaction** (`tr.mapping`) — you land back inside the
  freshly-minted anchor, exactly where you were.

This makes the round-trip exact and explicit rather than dependent on PM blur quirks.

---

## 5. Data Flow

### Ambient phase (panel open, no explicit target pinned)
```
selectionUpdate / transaction / focusin
   → resolveAiTarget(editor, mode)          [read-only]
   → label  = 'Ask About ' + descriptor.label
   → glow   = setMeta(aiTargetKey, { range: descriptor.range })
   (document is never mutated)
```

### Explicit override (right-click → Ask AI, or a Sieve block's own Ask AI)
```
surface fires sieve:ai-ask with detail.precomputedCtx
   → panel pins that target; ambient tracking PAUSES
   → label + glow reflect the pinned target until dismissed/sent
```

### Focus toggle (`Ctrl+Shift+A`)
```
editor focused  → save returnSelection; focus Ask textarea   (label/glow freeze)
textarea focused → focus editor; restore returnSelection      (ambient resumes)
   (independent of pin/visibility — focus axis only)
```

### SEND
```
doAsk → resolveAiTarget once more (or use pinned precomputedCtx)
   → if kind === 'selection': buildAiContext mutates (mint anchor);
        map returnSelection through tr.mapping
   → else: reference existing id / 'doc'
   → runAiJob(...)
   → clear glow, clear pin
   → focus editor; restore (mapped) returnSelection
```

### The "moved the caret without realising" case
Continuous projection **is** the safety mechanism — there is no freeze and no "are
you sure?" modal:
- Type in the panel → editor blurred, no events fire, glow holds on the last block
  (decorations render regardless of focus).
- Click back into the doc and nudge the caret → `selectionUpdate` fires → the glow
  **visibly jumps** to the new block and the label retitles, in the same instant.
- Return to the panel → glow is already on the new target; you cannot not notice it
  moved. Label and glow agree because both read the one `resolveAiTarget`.

---

## 6. Invariants

1. **No document mutation before SEND.** Ambient tracking is strictly read-only.
2. **Only `selection` mutates, and only at SEND.** The other three targets are pure
   references / whole-doc context.
3. **Label and glow never disagree** — both derive from one `resolveAiTarget`.
4. **Continuous projection, not freeze** — a moved caret is self-evident in both
   label and glow.
5. **Explicit `precomputedCtx` pins and pauses** live tracking until dismissed.
6. **The single seam holds** — every surface still fires `sieve:ai-ask` /
   `sieve:ai-explain`; the editor.js handlers remain the one business-logic seam
   (ai-ask-explain-seam). Ambient tracking is *additive* — a reactive view alongside
   the seam, not a replacement.
7. **Focus is a toggle, restored exactly** — jumping out of the Ask box (via
   `Ctrl+Shift+A` or SEND) always returns the caret to the captured `returnSelection`,
   mapped through any mint transaction. Focus and panel visibility are independent.

---

## 7. Component Changes

| File | Change |
|------|--------|
| `extensions.js` | Add `resolveAiTarget` (pure) + `describeTarget`. Refactor `buildAiContext` to call `resolveAiTarget` then commit only for `kind==='selection'`. Delete the duplicated `labelFor` in `getAiTargetLabel`; re-express `getAiTargetLabel` as `resolveAiTarget(...).label`. Remove `codeBlock`/`table` as target kinds. |
| `block-chrome.js` *(or new `ai-target-decoration.js`)* | New `AiTargetDecoration` plugin: `{range}` state, `aiTargetKey` meta setter, single `Decoration.node({class:'block-ai-target'})`. |
| `editor.js` | `updateAskPanelLabelLive` → also dispatch `setMeta(aiTargetKey, ...)` for the glow. Guard: skip live updates while a `precomputedCtx` is pinned. `doAsk` → resolve once, mutate only for `selection`, clear glow + pin on send. Add `returnSelection` capture/restore (§4.5); make `Ctrl+Shift+A` a focus toggle (in/out), independent of the pin. SEND restores the mapped `returnSelection`. |
| `editor.css` | `.block-ai-target` glow, sharing the chrome rail/gutter vocabulary. Frozen-vs-live label affordance (optional). |
| Sieve renderers (as needed) | Ensure `buildAiCtx` surfaces a good `contextLabel` (e.g. code block → its language) so "Ask About JavaScript Block" works. |

---

## 8. Edge Cases

- **Caret in a native code block / table** → `Document` (or `Selection` if text is
  selected). Convert-to-Smart is the on-ramp; no error.
- **Markdown mode** → no inline targets; `selection` (textarea substring) or
  `Document` only. Glow is rich-mode only.
- **Panel pinned + explicit ctx arrives** → explicit wins; ambient resumes when the
  explicit target is dismissed.
- **Anchor already highlighted, user re-asks** → reference the existing id; no second
  mutation (matches today's "skip already-highlighted target" guard,
  editor.js:1422).
- **Send with empty target / empty doc** → `Document`.

---

## 9. Testing

- `resolveAiTarget` unit cases: caret in each of the four target kinds returns the
  right `{kind,id?,range?,label}` with **zero** document mutation (assert
  `doc` unchanged / no transaction dispatched).
- Label parity: `resolveAiTarget(...).label` equals the context-menu / commit-path
  label for the same node (no divergence).
- Glow lifecycle: open panel → glow appears on target; move caret → glow follows;
  SEND on a selection → glow replaced by committed `==`; SEND on a sieveBlock/anchor
  → glow clears, no new mutation.
- Pin/override: explicit `precomputedCtx` freezes label+glow; ambient resumes after
  dismiss.
- Native code block fallback → `Document`, no error.
- Focus toggle round-trip: editor → `Ctrl+Shift+A` → textarea → `Ctrl+Shift+A` →
  caret back exactly where it was. SEND lands you back at the (mapped) same spot.
- Toggle out while pinned → panel stays visible, focus + caret return to editor,
  ambient tracking resumes. Toggle out while unpinned → panel may hide.

---

## 10. Cross-References

- ai-ask-explain-seam — the single business-logic seam this design preserves.
- block-anchor-lineage — anchors resolve to highlighted-word granularity; the glow
  must extend the *same* visual language, not a parallel one.
- context-menu-architecture — surfaces fire events; no surface owns AI business logic.
- `block-chrome.js` — the existing decoration-driven per-block visual-state engine
  the glow plugs into.
