# Feature Backlog

Ideas captured for post-stable-base implementation. Not yet fully specced — enough detail to pick up and design from.

---

## AI Block as a First-Class UI Element

*Vague at this stage — needs further design thinking. Capturing the intent.*

The current AI block is visually a coloured region with a label. The idea is to make it a much richer interactive element — something you can do things *to*, not just read.

**Direction**: Right-clicking an AI block (or hovering to reveal a handle) opens a context menu or inline panel with a set of actions that depend on what the block contains. Examples:
- Delete block
- Collapse / expand
- Re-run (re-ask the same question with updated context)
- Copy content as plain text
- "Accept" — promotes the AI content into the document body, removing the block wrapper (related to the silent Rewrite concept)
- "Reject" — deletes the block with one click
- Pin — marks the block as something to keep even if the document is trimmed
- Branch — opens the block's content as a new buffer

**The bigger idea**: AI blocks are not just output — they are *moments of reasoning* embedded in the document. The UX should reflect that they are objects you interact with over time, not just text you scroll past. A note might contain AI blocks from weeks ago that are still relevant, still contestable, still useful as context.

**Needs**: A design session to map out what actions make sense, what the block states are (active, archived, pinned, silent), and how they interact with the gutter and version history. Probably deserves its own spec.

---

## Version View

Currently versions are listed in the Meta Panel as a restore-only operation. This feature is about actually *viewing* what changed.

**Desired experience**: Select two versions from the history list and see a side-by-side or inline diff — what was added, removed, or changed. Optionally restore individual sections rather than the whole document.

**Technical notes**:
- Versions are already stored and retrievable via `GetDocumentVersion`
- Diff can be computed in Go (standard `diff` library) and rendered as annotated Markdown
- In the HTMX world this is a natural `hx-get="/meta/{uuid}/diff?from={v1}&to={v2}"` returning an HTML diff fragment
- Could live in the Meta Panel history tab or open as a full-width overlay

**Open question**: Is the target a read-only diff view, or can you cherry-pick sections to restore? Start with read-only.

---

## Right-Click to Delete AI Block

Currently no obvious way to remove an `AiBlock` without selecting around it and deleting manually. A right-click context menu on the block is the natural gesture.

**Desired experience**: Right-click anywhere inside an `AiBlock` → context menu with "Delete block" (and potentially "Copy content", "Collapse"). One click removes the block and its content entirely.

**Technical notes**:
- In TipTap a context menu on a node can be triggered via the `contextmenu` DOM event on the node view's wrapper element
- The delete action is a standard ProseMirror `deleteSelection` or a custom `deleteAiBlock` command
- ai blocks can be chained - think a backwards linked list of blocks - Is the chain broken or patched?
- Post-migration: the context menu can be a native Wails context menu (see `POST-MIGRATION-FEATURES.md`) passing the block's position to a Go handler, which returns the delete command

**Small but high-value** — AI blocks accumulate quickly and the friction of removing them shapes how freely people use the feature.

---

## Rewrite by AI

Select a passage of text, trigger a command, the AI rewrites it in place. The rewritten content replaces the selection but is wrapped in a "silent" `AiBlock` — visually indistinguishable from normal text in reading mode, but the metadata records that it was AI-generated.

**Desired experience**:
- Select text → shortcut or context menu → "Rewrite"
- Brief in-place spinner, then the selection is replaced with the AI's version
- No coloured border, no badge, no visual interruption — reads as normal content
- The `AiBlock` metadata is there if you look for it (gutter indicator? right-click reveals it)

**The "silent" wrapper design principle**: the document looks human-written but the machine record is preserved. Important for personal integrity ("did I write this?") and future features (e.g. stats on AI vs human content, or filtering it out).

**Technical notes**:
- Needs a new `AiBlock` display mode: `silent` (no visual chrome in View mode, shows subtle gutter marker only)
- Prompt: pass the selected text + surrounding context + a brief instruction ("rewrite this more concisely / formally / clearly" — style could be a parameter)
- The original text should be stored as a version attribute on the block so you can revert to it
- Post-migration: `POST /api/rewrite` with `{uuid, selection_start, selection_end, style}`

**Open question**: Should rewrite offer style options (concise, formal, expand) or just a generic "rewrite"? Probably start generic, add styles later.

---

## Formatting Bar

A contextual toolbar for rich text operations — appears when needed, hidden when not. Particularly important for tables, which are difficult to work with in TipTap without UI affordances.

**Desired experience**:
- **Text selection**: a small floating bubble appears above the selection with Bold, Italic, Code, Link, and "Rewrite by AI"
- **Table cursor**: when the cursor is inside a table, a persistent bar appears above the table with column/row add/delete controls and alignment toggles
- **Never cluttered**: no always-visible toolbar. The bar is triggered by context, not by default.

**Technical notes**:
- TipTap's `BubbleMenu` extension handles the floating-on-selection case cleanly — it's already designed for this
- Table toolbar is a separate `FloatingMenu` that activates on the `isActive('table')` condition
- Both are vanilla JS in the post-migration editor island — no React dependency
- Table operations use TipTap's built-in table commands (`addColumnAfter`, `deleteRow`, etc.)

**Priority within this feature**: Table controls first — tables are the most painful thing to edit without a toolbar. Text formatting bubble second (Bold/Italic most users do with keyboard shortcuts anyway).

---

## Gutter — Better Use of the Left Margin

The gutter (the left margin strip of the editor) is currently unused space. It's prime real estate for non-intrusive controls and indicators that would otherwise clutter the document body.

**Ideas for the gutter** (to be prioritised and specced individually):

### Fold / Collapse AI Blocks
- A small chevron in the gutter next to any `AiBlock` — click to collapse the block to a single summary line, click again to expand
- Especially useful for long Explain/Ask responses that you want to keep but not read every time
- The "silent" Rewrite blocks (above) would show a subtle gutter dot to indicate AI content without visual interruption in the body

### Section Folding
- Chevron next to any heading — collapses everything under it until the next same-level heading
- Standard in code editors, surprisingly rare in note apps
- Purely a view-layer operation — does not affect the stored Markdown

### Paragraph-Level Actions
- Hover a paragraph → a faint `+` or `⋮` appears in the gutter → click for block-level actions: move up/down, duplicate, delete, convert to heading/list
- Replaces the need for drag handles in the document body (which fight with text selection)

### AI Content Indicator
- Any paragraph or block generated or modified by AI shows a subtle left-border accent in the gutter (not in the document body)
- Makes AI provenance visible at a glance without interrupting reading

### Comment / Annotation Anchors
- Click in the gutter next to a paragraph to add a private note/annotation that doesn't appear in the document body or exported Markdown
- Stored in document metadata, not inline

**Implementation note**: The gutter in TipTap is typically implemented as a `NodeView` decoration or a `Decoration.widget` positioned absolutely relative to the editor container. It requires knowing the vertical position of each block, which TipTap's `view.coordsAtPos()` provides. This is a moderate implementation effort but high visual payoff — it's the thing that separates a proper writing tool from a text area.

**Suggested first gutter feature**: AI block fold/collapse — small scope, immediately useful, establishes the gutter as a concept in the codebase.
