# Editor Interaction Contract

**Normative.** Any interaction change MUST update this document in the same
change. Each cell is a testable behaviour; ✅-mark cells during a manual
regression pass. Source spec:
`docs/design/archive/specs/2026-07-04-editor-interaction-contract-design.md`.

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
| Partial text inside any sieve block (PM content — code/diagram/log-raw — OR a non-PM region like the log Explore table or the ai-block question title) | **Uniform rule:** text/plain + text/html follow the selection (the DOM highlight, or the PM range as fallback); `sieve/slice` + `sieve/<kind>` carry the WHOLE block (only-meaningful-whole). NEVER deferred to native PM copy — a slice inside a `defining`/`code` block re-wraps the whole node, so native copied everything. Served by the copy handler's per-block loop + `domSelectionTextInside`. **A highlight in a block's READ-ONLY region** (contentEditable=false DOM PM cannot track — the ai-block question title, the log Explore table) leaves PM's own selection on whatever block last held the caret; the handler re-targets the visited range onto the highlighted block via `domSelectionBlockRange`, so copy serves the block the user highlighted, not the stale one. |
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

## App-Level Chords

**Ownership rule (NORMATIVE).** The native menu (`main.go` `buildMenu`) is the
**single owner** of every app-level chord. A menu item declares the accelerator
and, in its callback, dispatches a `sieve:*` `CustomEvent` (or runs an
`htmx.ajax` call); the frontend listener turns that event into behaviour. This
is the only reliable ownership on both platforms — on macOS native menu
accelerators intercept chords **before** the webview, so any editor/DOM keydown
binding on the same chord is silently shadowed; on Linux GTK the webview sees
keys first. Owning them in the menu makes the resolution identical everywhere.

Consequences:

- The TipTap editor keymap (`extensions.js`) may bind **only caret-contextual
  chords the menu does not claim** (currently `Mod+E` Explain and `Mod+Shift+A`
  Ask — no menu item exists for either).
- **Document-level DOM `keydown` shortcut listeners are FORBIDDEN.** Insertion
  and app gestures ride the menu → event path, never a global `keydown`.
- Never bind the same chord in two places, even to the same action — the menu
  wins on Mac and the duplicate is dead weight.
- **Transitional exception (P2.B; removed by P2.C's chord-transport
  migration):** ONE quarantined document-level `keydown` listener in
  `editor.js` transports `Mod+S` / `Mod+J` **in markdown mode only**. The
  raw-markdown surface (`shell/surfaces/markdown-surface.js`) handles no
  app-level chords (it replaced the old textarea-local Mod+S/Mod+J handlers —
  the same duplicate-binding exception, previously element-scoped and
  unrecorded); in the dev browser no native menu exists to own these rows.
  Ownership is unchanged — the menu rows below stay authoritative in the app;
  the listener guards on mode so the WYSIWYG PM path never double-fires.

### Menu accelerator table

| Chord | Menu item | Action / dispatched event |
|---|---|---|
| Mod+N | File › New Note | `htmx.ajax` POST `/api/note/new` |
| Mod+S | File › Save | `sieve:save` |
| Mod+W | File › Close Tab | `htmx.ajax` POST `/api/tabs/close/{id}` |
| (menu-click only) | File › Export › Clipboard (Markdown) | `sieve:export-markdown` |
| Mod+Shift+O | File › Open Library… | `window.sieveSelectLibrary()` |
| Mod+, | File › Settings/Preferences | open settings dialog |
| Mod+Q | File › Quit (non-Mac) | `wailsruntime.Quit` |
| Mod+\\ | View › Toggle Sidebar | `htmx.ajax` POST `/api/session/sidebar/toggle` |
| Mod+Shift+I | View › Toggle Meta Panel | `htmx.ajax` POST `/api/session/meta/toggle` |
| Mod+Shift+P | View › Toggle Prompts | `htmx.ajax` POST `/api/session/prompts/toggle` |
| (menu-click only) | View › Toggle Line Numbers | `htmx.ajax` POST `/api/session/linenumbers/toggle` |
| Mod+Shift+M | View › Toggle Editor Mode | `sieve:toggle-mode` |
| Mod+F | View › Toggle Search | `sieve:toggle-search` |
| Mod+Shift+F | View › Sidebar Search | `window.sieveSidebarSearch()` |
| Mod+J | View › Toggle AI Blocks | `sieve:toggle-ai-blocks` |
| Mod+P | View › Quick Switcher | open quick-switcher dialog |
| Mod+Shift+T | View › Show Toolbar | `htmx.ajax` POST `/api/session/toolbar/toggle` |
| Mod+Alt+M | Tools › Smart Metadata | `window.SieveAI.smartMetadata()` |
| Mod+Shift+E | Tools › Smart File | `window.SieveAI.smartFile()` |
| Mod+Shift+Return | Tools › Keep & Smart File | `window.SieveAI.keepAndSmartFile()` |
| Mod+Shift+W | Tools › Insert WebClip | `sieve:insert-webclip` |
| Mod+Shift+L | Tools › Insert URL Card | `sieve:insert-url-card` |
| Mod+Shift+D | Tools › Insert Diagram | `sieve:insert-diagram` |
| Mod+/ | Help › Shortcuts | open help dialog |

Editor-owned caret chords (NOT in the menu, bound in `extensions.js`):
`Mod+E` = Explain block, `Mod+Shift+A` = Ask AI block.

## Deferred (recorded, not shipped)

- Bracket/quote auto-pairing in code blocks (`autoPair` policy flag) —
  deferred; must not fight PM input rules.
- Per-language indent width — uniform 2 until proven insufficient.
