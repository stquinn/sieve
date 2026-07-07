# Promote AI Block to Document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Promote to Document" context menu action to AI blocks that replaces the block with its question (as an H3 heading) and response (as rendered markdown prose).

**Architecture:** Two files change. The context menu renderer gains a `disabled` item state. `buildAiBlockItems` gains a new `promoteAiBlock` action that renders the question + response as markdown to HTML and uses TipTap's `insertContentAt` to replace the node in a single undoable transaction.

**Tech Stack:** Vanilla JS, TipTap 2 (markdown extension via `editor.storage.markdown.parser.md`), ProseMirror transactions via TipTap's command API, CSS custom properties for theming.

**Spec:** `docs/design/archive/2026-05-21-promote-to-document-design.md`

---

## File Map

| File | Change |
|------|--------|
| `frontend/src/static/sidebar.css` | Add `.ctx-item--disabled` rule after line 11 |
| `frontend/src/static/context-menu.js` | Add disabled support to renderer (lines 53–68); add `promoteAiBlock` function and menu item in `buildAiBlockItems` |

No new files. No Go changes.

---

## Task 1: Add `.ctx-item--disabled` CSS rule

**Files:**
- Modify: `frontend/src/static/sidebar.css:11`

- [ ] **Step 1: Add the disabled rule**

In `sidebar.css`, insert one line after `.ctx-item--active` (currently line 11):

```css
.ctx-item--active { background:var(--theme-border2); font-weight:700; }
.ctx-item--disabled { opacity:0.4; pointer-events:none; cursor:default; }
```

The full block after the change (lines 1–12):

```css
.ctx-item {
  display:flex;align-items:center;gap:8px;
  width:100%;background:transparent;border:none;text-align:left;
  padding:6px 12px;font-size:14px;color:var(--theme-text);
  cursor:pointer;transition:background 0.1s;
}
.ctx-item:hover { background:var(--theme-border2); }
.ctx-item--keep { color:var(--theme-accentPrimary); }
.ctx-item--trash { color:var(--theme-accentRed); }
.ctx-item--danger { color:var(--theme-accentRed); }
.ctx-item--active { background:var(--theme-border2); font-weight:700; }
.ctx-item--disabled { opacity:0.4; pointer-events:none; cursor:default; }
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/static/sidebar.css
git commit -m "feat(context-menu): add disabled state for menu items"
```

---

## Task 2: Add disabled support to the context menu renderer

**Files:**
- Modify: `frontend/src/static/context-menu.js:53–68`

The renderer's `else` branch (lines 52–69) currently builds every button without disabled awareness. We add two lines: the class append and the attribute set.

- [ ] **Step 1: Update the button renderer**

Replace the `else` branch in the `render` function. Find this exact block (lines 52–69):

```js
      } else {
        var btn = document.createElement('button')
        btn.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '')
        if (item.icon) {
          var wrap = document.createElement('span')
          wrap.innerHTML = item.icon
          btn.appendChild(wrap)
        }
        var lbl = document.createElement('span')
        lbl.textContent = item.label
        btn.appendChild(lbl)
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation()
          menu.remove()
          item.action()
        })
        menu.appendChild(btn)
      }
```

Replace with:

```js
      } else {
        var btn = document.createElement('button')
        btn.className = 'ctx-item' + (item.cls ? ' ' + item.cls : '') + (item.disabled ? ' ctx-item--disabled' : '')
        if (item.disabled) btn.setAttribute('disabled', '')
        if (item.icon) {
          var wrap = document.createElement('span')
          wrap.innerHTML = item.icon
          btn.appendChild(wrap)
        }
        var lbl = document.createElement('span')
        lbl.textContent = item.label
        btn.appendChild(lbl)
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation()
          menu.remove()
          item.action()
        })
        menu.appendChild(btn)
      }
```

The two added lines are:
- `+ (item.disabled ? ' ctx-item--disabled' : '')` appended to the className
- `if (item.disabled) btn.setAttribute('disabled', '')` — the native `disabled` attribute blocks click events even without pointer-events:none, so both layers are in effect

- [ ] **Step 2: Commit**

```bash
git add frontend/src/static/context-menu.js
git commit -m "feat(context-menu): support disabled items in renderer"
```

---

## Task 3: Add `promoteAiBlock` function and menu item

**Files:**
- Modify: `frontend/src/static/context-menu.js:244` (before `buildAiBlockItems`)
- Modify: `frontend/src/static/context-menu.js:277` (inside `buildAiBlockItems`, before the last divider)

- [ ] **Step 1: Add the promote icon to `IC`**

In the `IC` object at the top of `context-menu.js`, add a `promote` entry after `sparkle`:

Find:
```js
    sparkle:     svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'),
    info:        svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
```

Replace with:
```js
    sparkle:     svg('<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.937A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.582a.5.5 0 0 1 0 .962L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>'),
    promote:     svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>'),
    info:        svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
```

The `promote` icon is a standard upload/arrow-up glyph: an upward arrow pointing into a horizontal bar — visually "lift this content up into the document."

- [ ] **Step 2: Add the `promoteAiBlock` function**

Insert the function immediately before `buildAiBlockItems` (currently at line 244). Find:

```js
  // ── AI Block node ────────────────────────────────────────────────────────────
  function buildAiBlockItems(ctx) {
```

Replace with:

```js
  // ── AI Block node ────────────────────────────────────────────────────────────

  function promoteAiBlock(editor, getPos, n) {
    var question = (n.attrs.question || '').replace(/\n/g, ' ').trim()
    var response = n.attrs.response || ''
    var md = '### ' + question + '\n\n' + response
    var html = editor.storage.markdown.parser.md.render(md)
    var pos = getPos()
    editor.commands.insertContentAt({ from: pos, to: pos + n.nodeSize }, html)
  }

  function buildAiBlockItems(ctx) {
```

Notes on this function:
- `question` newlines are normalised to spaces so the whole question lands on one H3 line
- `editor.storage.markdown.parser.md` is the same markdown-it instance used to parse the document — it has GFM tables, fenced code, and all extensions active
- `insertContentAt` with `{ from, to }` replaces the range (the whole aiBlock node) in a single PM transaction — fully undoable with Cmd+Z
- Cursor position is unchanged because no explicit `setTextSelection` call is made after the insert

- [ ] **Step 3: Add the menu item to `buildAiBlockItems`**

Inside `buildAiBlockItems`, find the second divider + Retry/Replay block (lines 277–284):

```js
      { type: 'divider' },
      { icon: IC.refresh, label: isError ? 'Retry' : 'Replay', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-retry', {
          detail: { id: n.attrs.id, question: n.attrs.question, ref: n.attrs.ref, type: n.attrs.type }
        }))
      }},
    ]
```

Replace with:

```js
      { type: 'divider' },
      { icon: IC.promote, label: 'Promote to Document',
        disabled: n.attrs.status !== 'COMPLETE' || !n.attrs.response,
        action: function () { promoteAiBlock(editor, getPos, n) }
      },
      { type: 'divider' },
      { icon: IC.refresh, label: isError ? 'Retry' : 'Replay', action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-retry', {
          detail: { id: n.attrs.id, question: n.attrs.question, ref: n.attrs.ref, type: n.attrs.type }
        }))
      }},
    ]
```

The `disabled` condition: `n.attrs.status !== 'COMPLETE' || !n.attrs.response` — covers PENDING (no response yet), TIMEOUT (request failed), and any future status values that aren't COMPLETE.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/context-menu.js
git commit -m "feat(editor): add Promote to Document action for AI blocks"
```

---

## Task 4: Manual verification

Run the dev server:

```bash
wails dev
```

- [ ] **Check 1 — Disabled state on PENDING block**

  Open a note. If you don't have a PENDING block handy, you can test with a TIMEOUT block (right-click → Retry, then cancel quickly, or use a document with an existing PENDING block).

  Right-click any non-COMPLETE AI block. Expected: "Promote to Document" appears in the menu, visually greyed out (opacity ~40%), not clickable.

- [ ] **Check 2 — Enabled state on COMPLETE block**

  Right-click a COMPLETE AI block (one with a visible response). Expected: "Promote to Document" is fully opaque and clickable.

- [ ] **Check 3 — Basic promotion**

  Click "Promote to Document" on a COMPLETE block with a plain-text response. Expected:
  - The AI block is replaced by an H3 heading (the question text) followed by paragraph(s) of the response
  - No AI block visual remains
  - Cursor position is unchanged

- [ ] **Check 4 — Undo**

  Immediately after promotion, press Cmd+Z (or Ctrl+Z). Expected: the AI block is fully restored, indistinguishable from before.

- [ ] **Check 5 — Rich markdown in response**

  Test with a response that contains a table, a fenced code block, and a heading. Expected: all three are correctly rendered as TipTap nodes (the table is editable as a TipTap table, the code block is a TipTap codeBlock, the heading is a TipTap heading node — not raw text).

  To create a rich response for testing, you can manually insert an AI block via the clipboard (copy a `\`\`\`ai-block ... \`\`\`` block with a rich response and paste it into the editor).

- [ ] **Check 6 — Multiline question**

  Promote a block whose question contains a newline (if one exists in your filestore). Expected: the H3 heading contains the full question on a single line with newlines replaced by spaces.
