# Design: Promote AI Block to Document

**Date:** 2026-05-21  
**Branch:** feature/ai-block-rewrite  
**Status:** Approved — ready for implementation

---

## Context

This is Phase 4 of the AI block fenced YAML migration (see `docs/spec-ai-block-fenced-migration.md`). All earlier phases are complete. This is the last remaining piece.

AI blocks are scratchpad artifacts — a question asked and an answer received. When the response contains content worth keeping as first-class document prose, the user promotes it. This is a deliberate, explicit act.

---

## What It Does

Right-click an AI block → **"Promote to Document"**:

1. The block's `question` attr becomes an H3 heading
2. The block's `response` attr is rendered as full markdown (tables, headings, code blocks, lists — all preserved as proper TipTap nodes)
3. The aiBlock node is replaced in-place by that content
4. The document is left exactly as if the user had typed that content there manually
5. The cursor position is unchanged
6. The action is undoable with Cmd+Z

The question becomes a heading because promotion is lossy — once the structured block is gone, the question provides the only contextual anchor for the content.

---

## Availability

"Promote to Document" appears in the aiBlock context menu always, but is **disabled** (not hidden) when the block has no response — i.e., when `status !== 'COMPLETE'` or `attrs.response` is falsy.

This follows the existing app convention: unavailable actions are greyed out in place, not removed from the menu.

---

## Implementation

### Files changed

| File | Change |
|------|--------|
| `frontend/src/static/context-menu.js` | Add disabled item support to renderer; add Promote item to `buildAiBlockItems` |
| `frontend/src/static/editor.css` | Add `.ctx-item--disabled` style rule |

No new files. No Go changes. No new extensions.

---

### 1. Disabled state in the context menu renderer

The item schema gains an optional `disabled` boolean. The renderer applies it:

```js
var btn = document.createElement('button')
btn.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '') + (item.disabled ? ' ctx-item--disabled' : '')
if (item.disabled) btn.setAttribute('disabled', '')
// existing click handler is added regardless — the disabled attr prevents clicks natively
```

CSS (in `editor.css`):

```css
.ctx-item--disabled {
  opacity: 0.4;
  pointer-events: none;
  cursor: default;
}
```

---

### 2. The promote action (in `context-menu.js`)

```js
function promoteAiBlock(editor, getPos, n) {
  var question = (n.attrs.question || '').replace(/\n/g, ' ').trim()
  var response = n.attrs.response || ''
  var md = '### ' + question + '\n\n' + response
  var html = editor.storage.markdown.parser.md.render(md)
  var pos = getPos()
  editor.commands.insertContentAt({ from: pos, to: pos + n.nodeSize }, html)
}
```

**Why HTML round-trip is safe here:**  
`editor.storage.markdown.parser.md` is the same markdown-it instance used to parse the document. Its output is standard HTML (`<h3>`, `<table>`, `<pre><code>`, `<ul>`, etc.). TipTap's `insertContentAt` parses that HTML through the editor's own schema — each extension's `parseHTML` rules run, producing proper TipTap nodes (heading, table, codeBlock, bulletList, etc.). AI responses contain only standard markdown; they will never contain ai-block fences or smart-link syntax, so no custom Sieve node types are at risk.

The `{from, to}` range form of `insertContentAt` replaces exactly the aiBlock node. One transaction, one undo step.

---

### 3. Menu item in `buildAiBlockItems`

```js
{ icon: IC.sparkle,
  label: 'Promote to Document',
  disabled: n.attrs.status !== 'COMPLETE' || !n.attrs.response,
  action: function () { promoteAiBlock(editor, getPos, n) }
}
```

Placed after the divider, before Retry/Replay — so the full aiBlock menu reads:

```
Copy
Cut
Delete
────
Ask AI...
Explain
────
Promote to Document   ← new (disabled when PENDING/TIMEOUT)
────
Retry / Replay
```

---

## Edge Cases

| Case | Behaviour |
|------|-----------|
| `status === 'PENDING'` | Item disabled; no response to promote |
| `status === 'TIMEOUT'` | Item disabled; no response to promote |
| `question` is empty | H3 heading is empty — valid, user can delete it |
| `response` contains `---` | Safe — YAML block scalar handled at parse time; markdown-it renders `---` as `<hr>` which TipTap maps to a horizontal rule node |
| `response` contains nested headings | Safe — markdown-it renders them; TipTap parses to proper heading nodes |
| `response` contains tables | Safe — markdown-it GFM tables → `<table>` HTML → TipTap table nodes |
| `response` contains fenced code | Safe — renders to `<pre><code>` → TipTap codeBlock node |
| Undo | Single PM transaction; Cmd+Z fully restores the aiBlock |

---

## Out of Scope

- **Chain context preservation** — each AI block carries a `ref` pointing to other blocks it was asked in context of. On promotion this relationship is lost. Acceptable: the H3 heading anchors the content, and the block's position in the document places it naturally near whatever it was contextually adjacent to. Resolving the chain to prose is deferred.
- Configurable heading level (H3 is fixed for this iteration)
- "Promote question only" or "Promote response only" variants
- Confirmation dialog (undo covers recovery)
