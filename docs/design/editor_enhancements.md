# Future Editor Enhancements

This document outlines potential Tiptap extensions and custom UI patterns to enhance the Stash writing and AI experience.

## Tiptap Plugin Candidates

### 1. Mentions & Cross-Linking (`@tiptap/extension-mention`)
- **Concept**: Use `[[` or `@` to search and link to other notes in the Library.
- **AI Integration**: AI could suggest relevant "Related Notes" to link to based on the current context.
- **Benefit**: Transforms Stash into a networked knowledge base.

### 2. Highlights (`@tiptap/extension-highlight`)
- **Concept**: Manual text highlighting with custom colors.
- **AI Integration**: AI could automatically highlight the most critical sentences in a long document or clipped article.

### 3. Details/Accordions (`@tiptap/extension-details`)
- **Concept**: Collapsible sections in the editor.
- **Benefit**: Hide technical data, long AI justifications, or "Thinking" blocks to reduce visual noise.

### 4. Typography (`@tiptap/extension-typography`)
- **Concept**: Automatic replacement of symbols (e.g., `->` to `→`).
- **Benefit**: Ensures clean, professional-looking notes without manual formatting.

---

## AI Block Interaction & UI Ideas

Developing the `AiBlock` gesture system further into a premium, interactive experience.

### 1. Gutter Controls
- **Folding**: Add `[-]` and `[+]` icons in the editor gutter specifically for `AiBlock` nodes.
- **Quick Actions**: Hovering the gutter next to an AI response could trigger "Regenerate," "Refine," or "Clear" buttons.

### 2. State Management (Collapse/Expand)
- **Default State**: Older AI responses in a thread could automatically collapse into a compact "summary" bar to keep the focus on the current conversation.
- **Double-Click to Expand**: Allow clicking any collapsed AI block to see the full "Thinking" process and result.

### 3. Block-Level "Grip"
- **Drag and Drop**: Give AI blocks a "handle" (grip) to move them around easier.
- **Pinning**: "Pin" an AI response so it stays visible even if the rest of the thread is cleared or archived.

### 4. Mode-Aware AI Blocks
- **Diff Mode**: For "Refine" tasks, the AI block could show a side-by-side diff of the changes it's suggesting before they are applied.

---

## Technical Considerations
- **Persistence**: Any "collapsed" or "hidden" state should ideally persist in the Markdown (possibly via custom frontmatter or block attributes).
- **Performance**: As many AI threads grow, ensuring the React NodeViews remain performant is key (use `memo` and stable callbacks).
