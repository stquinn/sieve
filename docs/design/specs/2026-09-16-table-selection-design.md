# Table Selection — Making a Cell Range Visible

Tracked: #147.

## Problem

Tables are stock TipTap (`Table`/`TableRow`/`TableHeader`/`TableCell`, registered in
`frontend/src/static/lens/document-editor/surfaces/wysiwyg-surface.js`), and
prosemirror-tables' `CellSelection` has always worked inside them: dragging across cells,
Shift+click and Shift+Arrow each build one, and each marks every cell of the rectangle with
the class `selectedCell`.

`selectedCell` appeared nowhere in the app's CSS. The selection therefore existed and could
not be seen — so the feedback loop a spreadsheet lives on, *I can see what I am about to act
on*, was absent, and the table toolbar's Delete Row / Delete Column read as "do something to
some row, somewhere".

Selecting a whole row or column also had no verb: the only route was dragging from the first
cell to the last, invisibly.

## Decision

Keep prosemirror-tables' selection model exactly as shipped. Add the skin it never had, and
one verb per axis built on the stock `setCellSelection` command.

**Styles first, no grips.** Row/column grips or a header strip are the affordance a
spreadsheet has, but they are a large, permanently-visible addition to a document surface,
and the defect reported is that the selection *cannot be seen*. Correct styling plus a
discoverable verb is the smaller change that addresses it; grips remain available as a
follow-up with the evidence to justify them.

## Architecture

**The skin is an overlay, not a background** — `frontend/src/static/editor.css`, §Tables.
`.tiptap table th, .tiptap table td { position: relative }` plus
`.selectedCell::after { inset: 0; background: var(--theme-selectionBg) }` and accent borders
on the selected cells. A `background` on the class would composite with the header row's and
the even rows' own backgrounds — the same selection would read as two different ones
depending on which row it crossed. The overlay washes over both alike, and existing theme
tokens carry it, so no theme gains a token.

`.tiptap.ProseMirror-hideselection *::selection { background: transparent }` joins it: a
`CellSelection` is invisible to the browser (`visible: false`), and ProseMirror flags the
surface expecting exactly this rule. Without it the native highlight paints straight through
the overlay. A `NodeSelection` raises the same flag, so the rules are scoped to the editor
root and exempt `input`/`textarea` — a node view's own form controls (a log block's filter
field) keep their caret and highlight while a block is selected by its chrome handle.

**A row or a column is a rectangle** —
`frontend/src/static/lens/document-editor/surfaces/table-grid.js`. `TableGrid` maps a table
node to its grid of document positions: each slot names the cell covering it, so a cell with
`colspan`/`rowspan` occupies several. `rowRangeAt(cellPos)` and `columnRangeAt(cellPos)`
answer `{ anchorCell, headCell }` — `setCellSelection`'s own words. Reading a range off a
row node's children instead would be wrong for any table with a merge in it: a rowspan puts
a cell in rows whose child list does not hold it.

The class holds no ProseMirror — it reads `attrs.colspan`, `attrs.rowspan` and `nodeSize`
off the node it is handed — so it is a unit testable without an editor, and it lives in
`surfaces/` beside the rest of the table machinery.

**The selection outlives the gesture that opens a menu over it** —
`frontend/src/static/lens/document-editor/surfaces/cell-selection-guard.js`, wired at the
wysiwyg surface's `editorProps.handleDOMEvents.mousedown`, whose handlers ProseMirror
consults ahead of every plugin's. A right-click inside a `contenteditable` is a
caret-placing gesture: the browser moves the DOM selection and ProseMirror reads it back, so
a `CellSelection` collapses to a `TextSelection` before any entry of the menu built over it
runs. prosemirror-tables does not defend against it — its own mouse handling returns on the
first line for any button but the primary one. `CellSelectionGuard` refuses the gesture when
it lands on a cell the selection covers, and claims nothing outside it, which is what a
spreadsheet does.

Containment is read from the DOM, not recomputed: the guard asks whether the clicked element
sits inside a cell carrying `selectedCell` — prosemirror-tables' own decoration, and the one
the skin paints. The cells it keeps are therefore exactly the cells the user can see are
selected, and no second derivation of the rectangle can disagree with the vendor's.

**A table is given no drag handle** — `lens/document-editor/block-chrome.js`. Gutter chrome
is built for every top-level node, and a table is one, so a table had a drag handle whose
reveal rules were written for a prose row; a table's DOM satisfies them only for some
pointer positions, which reads as a grab cursor flickering in and out over a surface whose
pointer gestures mean cell selection. The number and the rail stay; the handle is not built.

**The verbs are menu entries** — `lens/document-editor/context-menu.js`. Select Row and
Select Column lead the existing Row and Column submenus, gated on the caret being in a
cell, and run `editor.chain().focus().setCellSelection(range).run()`. Nothing else in the
section changes: the stock verbs already act on the caret's row or column, and now name one
the user can see.

## What this does not do

- **No grips or header strip.** See the decision above.
- **No Mod+A escalation** (cell → table → document). It lands in the shared interaction
  policy and the contract's key matrix — a different blast radius; filed as #153.
- **No skin of its own for a `NodeSelection` on a whole table.** The editor-wide
  `.ProseMirror-selectednode` outline already marks one; a table-scoped rule would be a
  second way of saying the same thing.
- **No rebinding of Backspace/Delete.** TipTap's Table extension deletes the whole table
  when the selection covers every cell, which Select Row reaches in one click on a
  single-row table. Keys belong to the shared interaction policy, which this change does
  not open; the behaviour is recorded in the contract and pinned by a test instead.
- **No dragging a table by a handle.** Suppressing the handle takes that with it. It barely
  worked — the handle could not be summoned reliably — and a table is moved by cut and
  paste; a table-specific reveal rule was rejected as a grab affordance sitting next to a
  selection skin that means something else.
- **No column resizing.** `resizable: false` stays: a width has no GFM representation.
- **No change to the on-disk or wire representation.** A selection is ephemeral UI state and
  nothing about it serializes. No Go change, no protocol change.
- **No table block kind**, no merge/split redesign, and nothing in the markdown surface,
  where a table is raw text.

## Behaviour of record

`docs/editor-interaction-contract.md` §Table selection is normative: the gestures that build
a selection, what it looks like, and that Backspace/Delete over one clears cell *content*
and leaves the structure — except over a selection covering every cell, where TipTap's own
binding deletes the table.
