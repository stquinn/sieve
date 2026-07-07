# Implementation Plan: Sieve Block Selection, Copy, and Paste Refactoring

> **STATUS: DONE** — shipped; sieve/slice clipboard + /api/editor/paste-slice live. Archived 2026-07-07.

Date: 2026-06-11
Status: Approved / In Execution

## Context & Problem Statement
The Sieve editor utilizes a combination of native ProseMirror/TipTap nodes and custom Sieve blocks (fenced blocks).
Prior to this refactoring, the Sieve block selection, copy, and paste experiences were erratic:
1. **Selection Inconsistencies:** 
   - Non-interactive Sieve blocks (like AI Actions) were set to `selectable: true` and `draggable: true`.
   - Interactive Sieve blocks (like Code and Diagram renderers) were set to `selectable: false` and `draggable: false` to prevent mouse clicks inside their textareas from triggering ProseMirror `NodeSelection` outlines.
   - This schema inconsistency caused ProseMirror's selection ranges to become disjointed. Selecting a sequence of blocks would often fail to include the Sieve blocks or would copy only fragments of their plain text instead of their structured content.
2. **Visual Outlines:**
   - Text selection dragging across blocks applied the `.ProseMirror-selectednode` outline class to Sieve blocks via a custom `SelectionHighlight` plugin. This resulted in unexpected and erratic blue outlines on blocks that were merely part of a range selection.
3. **Clipboard Serialization:**
   - The copy event was fully hijacked by custom JS logic that completely bypassed ProseMirror's native serializer. This made copying mixtures of prose and Sieve blocks unreliable, often producing fenced YAML in some cases or bare code in others.

---

## Design Decisions & Solutions

### 1. Unify Node Schema Selection
We will configure all Sieve block types in the ProseMirror schema with `selectable: true` and `draggable: true`. This restores a clean selection hierarchy across the document.

### 2. Isolate Editor Input via `stopEvent` NodeView Hook
To prevent clicks, typing, and focus events inside textareas/inputs from triggering ProseMirror selection updates (which would deselect the block or move the editor cursor), we wrap the NodeView's `stopEvent` centrally inside `sieve-block-extension.js`:
- Keyboard shortcuts with modifier keys (e.g. `Ctrl+C`, `Ctrl+V`, `Ctrl+S`, `Ctrl+E`) will **not** be stopped, allowing them to propagate to the main editor and trigger standard shortcuts.
- Events originating from the drag handles or block gutters (`.block-chrome-host` or `.drag-handle`) will **not** be stopped, allowing ProseMirror to handle dragging and selection.
- All other input/interaction events targeting interactive form elements (`TEXTAREA`, `INPUT`, `BUTTON`, `A`, `SELECT`, `OPTION`, `.CodeMirror`, `.cm-editor`) will return `true` to cleanly shield them from ProseMirror.

### 3. Refine Copy Serialization
Rather than bypassing ProseMirror, we intercept the copy event at the editor level (`editor.js`) and perform a high-fidelity serialization:
1. **HTML:** Use ProseMirror's native `clipboardSerializer` on the selection slice to generate a clean HTML representation.
2. **Text:** Use the editor's markdown serializer to generate clean Markdown text for the selected range.
3. **Namespaced Formats:** Append `sieve/<KIND>` (for a single Sieve block) or `sieve/slice` (containing the JSON array of selected blocks) to the clipboard. The structured representations are loaded directly from the `serialisedForm` base attribute populated by the Go backend.

### 4. Selection Styles Clean-up
We will modify:
- `.ProseMirror-selectednode` to represent an active focused `NodeSelection` (outlined border).
- `.block-in-selection` to represent a Sieve block that is part of a range selection. This is styled with a background selection tint matching standard browser text selection (`var(--theme-selectionBg)`), creating a cohesive and consistent selection highlight across the document.

---

## Proposed Technical Changes

1. **`sieve-block-extension.js`**: Wrap `stopEvent` in the returned NodeView structure to handle central event routing.
2. **`code-renderer.js` / `diagram-renderer.js`**: Remove node-level `selectable: false` and `draggable: false` config overrides.
3. **`extensions.js`**: Modify the `SelectionHighlight` extension so it decorates Sieve blocks with `block-in-selection` instead of `ProseMirror-selectednode`.
4. **`editor.js`**: Implement the refined `copy` event and simplify the `paste` event to leverage native parsing in Phase 1.
5. **`editor.css`**: Define the styling rules for `.block-in-selection` using selection background tints instead of outlines.
