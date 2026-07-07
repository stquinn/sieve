> **STATUS: DONE** — shipped; interaction-policy.js live; normative contract lives on as docs/editor-interaction-contract.md. Archived 2026-07-07.

# Editor Interaction Contract (Design)

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plan
**Companion spec:** `2026-07-04-api-contract-single-source-of-truth-design.md`

## Problem

The Sieve block functionality has matured, but the editor *feel* has become inconsistent. Confirmed defects (not hypothetical):

1. Tab inserts 4 spaces in prose but 2 in code/diagram blocks.
2. Shift+Tab in prose falls through to the browser and moves focus out of the editor.
3. Pasting a URL into prose silently becomes a smart-card; the same paste into a code block stays literal text (asymmetry is by design, but nowhere written down).
4. Copying a partial text selection from inside a sieve block yields plain text with no block identity (also correct by design — but undocumented, so it reads as a bug).
5. The diagram block's Ctrl+Enter works via two different mechanisms depending on mode (PM plugin in edit mode, DOM listener on the render body in render mode).
6. Tab in a table cell inserts 4 spaces instead of moving to the next cell (user-confirmed 2026-07-04): the root `editorProps.handleKeyDown` carves out only `listItem` and consumes Tab before TipTap Table's `goToNextCell` keymap can run.

**Root cause:** Tab/Enter/caret handling is implemented per-block-renderer (`code-renderer.js`, `diagram-renderer.js` each carry their own `handleKeyDown` plugin), while copy and paste-detection already flow through one shared pipeline. Half the code follows the uniform-mechanism principle; half doesn't. Every new block kind drifts a little further.

## Goals

1. A **normative interaction contract** — a written spec of what every key and clipboard gesture does in every context. It is the arbiter of "correct", the manual regression checklist, and later the Playwright checklist.
2. **One shared mechanism** — block renderers *declare* interaction policy; a single plugin applies it. Per-renderer keydown plugins are deleted.
3. Fix the five defects as **conformance** to the contract, not as spot-patches.
4. Make the code-like editing surface feel like a code editor while remaining part of the editor pane.
5. Caret behaviour that is consistent, predictable, and never dead-ends.

## Non-Goals

- No CodeMirror/Monaco embed for code blocks (breaks "part of the editor pane": separate undo stack, focus island, heavy dependency).
- No change to the smart-paste *matching* pipeline (Go `FirstPasteMatch` stays as-is).
- No new affordance UI (chrome/rails/doc-map are parked under TECH-DEBT U-A pending the holistic layout re-brainstorm).

## Decisions (settled during brainstorm)

| Question | Decision |
|---|---|
| Tab in plain paragraph | **No-op: consumed, nothing inserted.** Focus never escapes the editor. |
| Tab in lists / tables | **Native TipTap behaviour, untouched** (indent/outdent list items; Tab/Shift+Tab move to next/previous table cell). Sieve does not interject. The policy plugin consumes Tab only when nothing structural claims it. Table edges to pin in the contract doc: Tab in the *last* cell (TipTap default appends a row — adopt or override explicitly), Shift+Tab in the *first* cell (must stay consumed, never a focus escape). |
| Indent width in raw-text blocks (code/diagram/log) | **Uniform 2 spaces.** Shift+Tab de-indents up to 2. |
| Smart paste into prose | **Silent conversion stays** (status quo blessed). |
| Paste into raw-text blocks | **Literal text** (status quo blessed; `caretInRawTextBlock` becomes a policy flag). |
| Partial-selection copy from a sieve block | **Plain text is correct.** Whole-block selection (gutter / NodeSelection) is how you copy *the block* (full sieve MIME set). |
| Code-like editing surface | **Stay PM-native**; close the feel gap with editor affordances (below). |

## The Contract Document

`docs/editor-interaction-contract.md` (written as part of implementation, seeded from the tables below) is **normative**. It contains:

1. **Key matrix** — context × key → behaviour, for contexts {plain paragraph, list item, table cell, code block, diagram (edit), diagram (render), log block, ai-block, web-clip, smart-image} × keys {Tab, Shift+Tab, Enter, Shift+Enter, Mod+Enter, Backspace, Delete, Arrow keys at boundaries, Home/End}.
2. **Copy matrix** — selection type (partial text / whole single block / gutter block-range / cross-block text) → MIME set produced.
3. **Paste matrix** — target context × content type (plain text, URL, HTML, image, `sieve/slice`, ai-block fence) → outcome.
4. **Caret contract** (below).

## Mechanism: Policy Declarations + One Shared Plugin

Block renderers stop registering their own `handleKeyDown` plugins. Instead, each renderer's registration (the existing all-blocks behaviour registry — prose included, never special-cased) declares an **interaction policy**, e.g.:

```js
interactionPolicy: {
  rawText: true,          // literal paste, Tab indents
  indentWidth: 2,
  enterInsertsNewline: true,
  autoIndentOnEnter: true,
  modEnterTogglesMode: true,   // diagram only
}
```

A single new module `frontend/src/static/editor/interaction-policy.js` exports one ProseMirror plugin that resolves the caret's context to a policy and applies it uniformly.

**Ordering is load-bearing (verified failure mode):** the plugin must run *after* native extension keymaps — defer first, consume last. Today's root `editorProps.handleKeyDown` runs *before* all extension keymaps and carves out only `listItem`, which is why Tab in a table cell inserts 4 spaces (TipTap Table's `goToNextCell` keymap never runs) and Shift+Tab in prose escapes to the browser. The policy plugin therefore registers as a low-priority plugin (not `editorProps`), so list indent, table cell navigation, and any future structural keymap win by construction; the plain-paragraph no-op is the last-resort backstop, never a shadow.

Consequences:

- The Tab/Enter `handleKeyDown` code in `code-renderer.js` and `diagram-renderer.js` is **deleted**.
- The root `handleKeyDown` Tab branch in `editor.js` (4-space insert) is **deleted**; the policy plugin consumes Tab/Shift+Tab in plain paragraphs as no-ops.
- Diagram's two Ctrl+Enter paths converge: the render-body DOM listener remains as an *entry point* (focus is outside the contentDOM in render mode) but calls the same policy function the plugin uses.
- The next block kind gets correct interaction behaviour by declaring a policy, not by writing key handlers.

Policy resolution is pure JS → unit-testable with vitest.

## Code-Like Editing Surface ("textarea feel" — measured)

**Measured state:** there is *no* `<textarea>` in code-like blocks. Code, diagram, and log blocks edit through a ProseMirror `pre>code` contentDOM (`code: true` nodes) with decoration-based syntax highlighting. The "textarea + overlay" header comments in `code-renderer.js` and `diagram-renderer.js` are stale documentation from a prior implementation and must be corrected. The only real textarea is whole-document markdown mode (`editor.js`), which is breakglass and out of scope.

The surface *feels* like a bare textarea because it lacks code-editor affordances. Staying PM-native already provides integration (shared undo history, single selection model, caret flows in/out of blocks); the gap is closed via the policy plugin:

- **Auto-indent on Enter** — new line copies the previous line's leading whitespace (`autoIndentOnEnter`).
- **Block indent/de-indent** — Tab/Shift+Tab on a multi-line selection indents/de-indents all selected lines by `indentWidth`, not replaces the selection.
- **Home** — first press goes to first non-whitespace character, second to column 0.
- **Auto-pairing** of brackets/quotes — *stretch*, behind a policy flag; ship only if it doesn't fight PM input rules.

## Caret Contract

Caret control is a first-class part of the contract, not an implementation detail:

1. **No dead-ends** — every document position is reachable by arrow keys alone; the caret can always leave any block upward and downward. The trailing-node guarantee + unified Enter-escape decision (block-cursor affordance defect, B+A) is *encoded here* as contract clauses; its implementation status is verified during planning, not re-designed.
2. **Boundary behaviour is uniform across block kinds.** Editable code-like blocks (code, diagram-edit, log) are just text to the caret:
   - ArrowDown from the block above enters the **first line as a text caret** (never a NodeSelection, never skipped), preserving the horizontal column; ArrowUp from below enters the last line symmetrically.
   - ArrowDown on the **last line exits to the next block** (or the guaranteed trailing paragraph) **without modifying content** — leaving never inserts a newline; ArrowUp from the first line symmetrically.
   - **Enter at the end of a raw-text block always inserts a newline inside the block** — it never auto-escapes (trailing newlines are legitimate code content; "sometimes Enter escapes" is the inconsistency being eliminated).
3. **Read-only blocks (web-clip, ai-block, diagram-render, smart-image) are a single caret stop.** Arrowing onto one selects the whole block (the selection ring *is* the caret at that position); arrowing again moves past it. Never skipped invisibly, never a trap.
4. **Escape is one uniform gesture, not per-block magic.** Mod+Enter inserts a paragraph after the current block and moves the caret there — identical for every block kind. When a read-only block is NodeSelected, plain Enter does the same (this is also how prose is inserted between two adjacent read-only blocks). The trailing-node guarantee ensures a landing place after a final block. This standardises the prior piecemeal "attempts" (trailing-node + unified Enter-escape, B+A) as contract law.
5. **Click placement is predictable** — clicking anywhere in a block's body places a text caret at that point; clicking chrome (header/gutter) selects the block (NodeSelection), never silently focuses nothing.
6. **The caret is always visible** — entering a block never leaves focus in a state where typing goes nowhere.
7. **Mode flips preserve position** — diagram edit↔render round-trips restore the caret to where it was (or block-start if content changed).

The contract doc's key matrix includes an "Arrow keys at boundaries" column so every block kind has an explicit, testable answer.

## Conformance Changes (the defects, fixed by the mechanism)

| Defect | Resolution |
|---|---|
| Tab 4 vs 2 spaces | Prose Tab branch deleted (no-op policy); raw-text blocks uniform `indentWidth: 2` |
| Shift+Tab focus escape | Consumed as no-op in plain paragraphs; de-indents in raw-text blocks; native in lists |
| Paste asymmetry | Blessed + documented in paste matrix; `caretInRawTextBlock` becomes the `rawText` policy flag |
| Partial-copy metadata loss | Blessed + documented in copy matrix |
| Diagram Ctrl+Enter split | Both entry points route through one policy function |
| Tab in table cell inserts 4 spaces | Root `editorProps` Tab branch deleted; policy plugin runs after native keymaps, so Table's Tab/Shift+Tab cell navigation wins by construction |
| (stale docs) | `code-renderer.js` / `diagram-renderer.js` header comments corrected to describe the contentDOM implementation |

## Testing

- **vitest** — policy resolution, indent/de-indent text transforms, auto-indent logic (pure JS).
- **Contract doc as manual checklist** — each matrix row is a checkable behaviour; used for regression passes until the planned Playwright browser harness lands, at which point the matrices become its test inventory.
- **UI validation** — drive the wails dev server via headless Chrome for smoke checks of Tab/Enter/caret paths; verify caret/perf feel in the real WebKitGTK app (WebKit exposes contentEditable costs Blink hides).

## Keeping It Current (CLAUDE.md update — required outcome)

Once the contract lands, `CLAUDE.md` gains a rule block:

- New block kinds **must** declare an `interactionPolicy`; per-renderer `handleKeyDown` plugins are forbidden.
- Any interaction change **must** update `docs/editor-interaction-contract.md` in the same change — the contract doc is normative, not descriptive.
- Keyboard/clipboard/caret behaviour changes are validated against the contract matrices before merge.

## Implementation Phases (sketch — detail in the plan)

1. Write `docs/editor-interaction-contract.md` (normative matrices seeded from this spec).
2. `interaction-policy.js` plugin + policy declarations; delete per-renderer key handlers; conformance fixes fall out.
3. Code-editor affordances (auto-indent, block indent, Home behaviour).
4. Caret-contract conformance (verify B+A status; fix boundary/click/mode-flip gaps).
5. CLAUDE.md upkeep rules.
