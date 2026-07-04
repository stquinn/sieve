# Editor Interaction Contract

**Normative.** Any interaction change MUST update this document in the same
change. Each cell is a testable behaviour; ✅-mark cells during a manual
regression pass. Source spec:
`docs/design/superpowers/specs/2026-07-04-editor-interaction-contract-design.md`.

## Key matrix

"consume ∅" = event consumed, nothing happens, focus stays in the editor.
"native" = TipTap/ProseMirror default; Sieve does not interject.

| Context | Tab | Shift+Tab | Enter | Shift+Enter | Mod+Enter | ArrowDown at end | ArrowUp at start | Home |
|---|---|---|---|---|---|---|---|---|
| Plain paragraph | consume ∅ | consume ∅ | native (split para) | native (soft break) | native | native | native | native |
| List item | native (indent) | native (outdent) | native | native (soft break) | native | native | native | native |
| Table cell | native (next cell; last cell appends row — adopted TipTap default) | native (prev cell; consume ∅ in first cell) | native | native (soft break) | native | native | native | native |
| Code block (sieve `code` AND native `codeBlock` — one policy for both) | indent 2 (multi-line: indent each selected line) | de-indent ≤2 per line | newline + auto-indent (copy previous line's leading whitespace) | **escape: insert ¶ after block** | native (core exitCode — same effect as escape; undocumented alias) | exit to next block, content unchanged | exit to previous block | 1st press: first non-ws char; 2nd: column 0 |
| Diagram (edit) | indent 2 (as code) | de-indent ≤2 (as code) | newline + auto-indent | **escape: insert ¶ after block** | **toggle to render mode** (cursor position preserved) | exit to next block | exit to previous block | as code |
| Diagram (render) | consume ∅ | consume ∅ | insert ¶ after (block is a caret stop) | **escape: insert ¶ after block** | **toggle to edit mode** (block selected OR render body focused — one function, two entry points) | pass to next block | pass to previous block | n/a |
| Log block | consume ∅ | consume ∅ | consume ∅ (read-only text) | **escape: insert ¶ after block** | **toggle raw↔explore** | exit to next block | exit to previous block | native |
| ai-block | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |
| web-clip | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |
| smart-image | consume ∅ | consume ∅ | insert ¶ after (caret stop) | **escape: insert ¶ after block** | native ∅ | pass | pass | n/a |

**Two chords, one meaning each (decided 2026-07-04):**

- **Shift+Enter = the universal block escape** — inside ANY sieve block (or
  with one selected), insert a new paragraph after the block and move the
  caret there. Free of clashes: HardBreak (the native Shift+Enter soft break)
  cannot exist inside `text*` blocks, and prose keeps it natively. Precedent:
  Jupyter's "Shift+Enter leaves the cell downward".
- **Mod+Enter = mode toggle**, a policy mechanism, not a special case: any
  kind with two view modes declares `modEnterTogglesMode: true` and provides
  an `onModEnter` hook. Current users: diagram (edit↔render, preserving the
  long-standing Ctrl+Enter habit), log (raw↔explore).

**Smart Home platform note:** the Home column applies to the `Home` key
(Linux/Windows; fn+Left on Mac) AND to Cmd+Left on macOS — the idiomatic Mac
line-start gesture (VS Code parity). Shift-selection variants stay native.

## Caret contract

1. No dead-ends: every position reachable by arrows alone; a trailing
   paragraph is guaranteed after a final structured block (trailing-node).
2. Entering an editable raw-text block from above: text caret on FIRST line,
   column preserved. From below: LAST line. Never a NodeSelection, never
   skipped.
3. Leaving a block never modifies its content (no phantom newlines).
4. Read-only blocks (web-clip, ai-block, diagram-render, smart-image) are a
   single caret stop: arrow onto → whole-block selection; arrow again → past
   it. Enter or Shift+Enter while selected inserts a paragraph after (this is
   how prose is added between two adjacent read-only blocks).
5. Click-to-own-selection (framework-uniform, every kind): a click anywhere in
   a block makes it the caret/selection owner — never silent nothing.
   - Click in editable text (a block's `contentDOM`) → text caret there.
   - Click on any non-editable region (a custom render area, the log Explore
     table, an image) → whole-block `NodeSelection` + editor focus, so keyboard
     chords (Mod+Enter mode toggle, arrows, escape) route to the block.
   - Interactive controls and the header/gutter chrome own their own clicks and
     do NOT move the document selection (the gutter handle drives its own
     block-selection/reorder).
   - A drag that leaves a text selection inside the block is preserved (copy);
     it does not collapse into a block selection.
   Owned by `shouldClaimBlockSelection` + the `mouseup` seam in
   `sieve-block-extension.js` — never per-renderer.
6. Typing always goes somewhere visible after entering a block.
7. Diagram edit↔render round-trip restores cursor position (block-start if
   content changed).

## Block insertion placement (decided 2026-07-04)

Additive block creation (toolbar insert, AI-block create, extract, smart-paste,
paste-slice, drop) places the new block **after the caret's top-level block —
never splitting it**. ONE uniform exception:

**An empty paragraph is a placement target, not an anchor.** If the caret's
block is a bare empty paragraph (type `paragraph`, empty or whitespace-only),
the new block **takes its index and the paragraph is consumed** — no orphan
blank line above the insertion. Empty headings/list items/table cells are NOT
consumed (their emptiness carries chosen structure). Sole-block documents keep
the paragraph — it becomes the paragraph after the new block.

Mechanism (no replace op, no backend emptiness-sniffing): at COMMIT time the
frontend deletes the paragraph as an ordinary tracked prose edit (the same
delete-block op a backspace emits), flushes the block-sync so Go's shadow
applies the delete first, then sends create-block at the freed index — two
existing primitives, ordered on one socket. Capture-time never consumes: a
cancelled dialog must not eat the blank line (known gap: the async image-upload
dialog path commits outside the editor and does not consume — acceptable).

## Copy matrix

| Selection | Result |
|---|---|
| Partial text inside any sieve block (PM content — code/diagram/log-raw — OR a non-PM region like the log Explore table) | **Uniform rule:** text/plain + text/html follow the selection (the DOM highlight, or the PM range as fallback); `sieve/slice` + `sieve/<kind>` carry the WHOLE block (only-meaningful-whole). NEVER deferred to native PM copy — a slice inside a `defining`/`code` block re-wraps the whole node, so native copied everything. Served by the copy handler's per-block loop + `domSelectionTextInside`. |
| Single whole sieve block (gutter / NodeSelection) | text/plain + text/html + `sieve/slice` + `sieve/<kind>` + renderer custom views |
| Gutter block-range | `sieve/slice` = ordered ContentEntry sets, one per block |
| Smart-image node selection | real bitmap to clipboard |

## Paste matrix

| Target | Content | Outcome |
|---|---|---|
| Prose | URL / HTML / image / matchable | silent smart conversion (Go FirstPasteMatch) — by design |
| Prose | plain text (no match) | local insert |
| Raw-text block (code/diagram-edit) | anything | literal text (policy `rawText`) |
| Anywhere | `sieve/slice` (>1) | Go paste-slice reconstructs blocks |
| Anywhere | ```` ```ai-block ```` fence | ai-block re-import |
| Log block | anything | consumed (read-only) |

## Deferred (recorded, not shipped)

- Bracket/quote auto-pairing in code blocks (`autoPair` policy flag) —
  deferred; must not fight PM input rules.
- Per-language indent width — uniform 2 until proven insufficient.
