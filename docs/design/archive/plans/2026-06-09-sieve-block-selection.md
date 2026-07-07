# Sieve Block Selection & Copy Implementation Plan

> **STATUS: SUPERSEDED** — atom:false/makeWidget architecture never built; problem solved by caretStop + the interaction-policy extension instead. Archived 2026-07-07.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix mouse/keyboard selection and Cmd+C copy across sieve block boundaries by removing `atom: true` and `contentEditable="false"` from block wrappers.

**Architecture:** `atom: false` becomes a framework invariant in `sieve-block-extension.js`. Display-only renderers migrate from `makeNodeView → makeWidget` (returns a DOM element; framework owns the NodeView lifecycle). Editable blocks (code, diagram) get only their outer `contentEditable="false"` removed — their complex `destroy`/`selectNode` lifecycle is left for a follow-on migration. All selection hacks (`_sieveDragSel`, mousemove/mouseup listeners, `.sieve-in-selection`) are deleted.

**Tech Stack:** TipTap 2 / ProseMirror, vanilla JS ES modules, no build step.

**Spec:** `docs/design/archive/2026-06-09-sieve-block-selection-design.md`

---

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/static/sieve-block-extension.js` | Framework: atom:false, defaultStopEvent, makeWidget support, delete hacks |
| `frontend/src/static/web-clip-renderer.js` | makeWidget migration |
| `frontend/src/static/ai-block-renderer.js` | makeWidget migration |
| `frontend/src/static/smart-card-renderer.js` | makeWidget migration |
| `frontend/src/static/smart-link-renderer.js` | makeWidget migration (inline block) |
| `frontend/src/static/smart-image-renderer.js` | makeWidget migration (top-level fn pattern) |
| `frontend/src/static/code-renderer.js` | Remove outer contentEditable only |
| `frontend/src/static/diagram-renderer.js` | Remove outer contentEditable only |
| `frontend/src/static/editor.js` | Delete onSelectionUpdate sieve-in-selection block |
| `frontend/src/static/editor.css` | Delete .sieve-in-selection rule |
| `docs/how-to-sieve-block-framework.md` | Update renderer template and nodeConfig table |

---

## Task 1: Framework — sieve-block-extension.js

**Files:** Modify `frontend/src/static/sieve-block-extension.js`

- [ ] **Step 1: Add `defaultStopEvent` after `DEFAULT_NODE_CONFIG`**

Find line 63 (`var DEFAULT_NODE_CONFIG = ...`) and replace it with:

```js
var DEFAULT_NODE_CONFIG = { selectable: true, draggable: true, group: 'block', inline: false, content: '' }

function defaultStopEvent(event) {
  if (event.metaKey || event.ctrlKey) return false
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
       'Home','End','PageUp','PageDown'].includes(event.key)) return false
  return ['keydown','keyup','keypress','input','cut','paste'].includes(event.type)
}
```

- [ ] **Step 2: Harden `createSieveNode` schema — atom:false + content**

Find (lines 74–80):
```js
    return Node.create({
      name:       nodeName,
      group:      cfg.group,
      inline:     cfg.inline,
      atom:       cfg.atom,
      selectable: cfg.selectable,
      draggable:  cfg.draggable,
```

Replace with:
```js
    return Node.create({
      name:       nodeName,
      group:      cfg.group,
      inline:     cfg.inline,
      atom:       false,
      selectable: cfg.selectable,
      draggable:  cfg.draggable,
      content:    cfg.content || '',
```

- [ ] **Step 3: Replace `addNodeView()` with framework-owned implementation**

Find the entire `addNodeView()` block (lines 94–306, from `addNodeView() {` through the closing `},`). Replace it with:

```js
      addNodeView() {
        return function ({ node, editor, getPos }) {

          // ── New path: makeWidget (display-only renderers) ─────────────────
          if (renderer.makeWidget) {
            var wrapper = document.createElement(tag)

            function buildContent(attrs) {
              wrapper.innerHTML = ''
              wrapper.appendChild(renderer.makeWidget(attrs, editor))
            }

            buildContent(node.attrs)

            wrapper.addEventListener('contextmenu', function (e) {
              e.preventDefault()
              e.stopPropagation()
              var currentNode = (typeof getPos === 'function') ? editor.state.doc.nodeAt(getPos()) : node
              var n = currentNode || node
              var IC = window.SieveIcons || {}

              var items = renderer.buildContextMenuItems
                ? renderer.buildContextMenuItems({ node: n, editor: editor, getPos: getPos })
                : []

              var aiBase = renderer.buildAiCtx ? renderer.buildAiCtx(n) : {}
              var kindLabel = n.attrs.kind
                ? n.attrs.kind.charAt(0).toUpperCase() + n.attrs.kind.slice(1).replace(/-/g, ' ')
                : 'Block'
              var aiCtx = {
                content:      '',
                blockRef:     n.attrs.id || 'doc',
                history:      '',
                contextLabel: (aiBase && aiBase.contextLabel) || kindLabel,
                imageIds:     (aiBase && aiBase.imageIds) || [],
              }
              items = items.concat([
                { type: 'divider' },
                { icon: IC.sparkle, label: 'Ask AI…', action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: aiCtx } }))
                }},
                { icon: IC.info, label: 'Explain', action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-explain', { detail: { precomputedCtx: aiCtx } }))
                }},
              ])

              items = items.concat([
                { type: 'divider' },
                { icon: IC.trash, label: 'Delete', action: function () {
                  if (typeof getPos === 'function') {
                    var pos = getPos()
                    editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
                  }
                }},
              ])

              var status = n.attrs.status || 'PENDING'
              var isStale = (status === 'PENDING' || status === 'DISPATCHED') && isJobStale(n.attrs.createdAt, n.attrs.id)
              var isError = status === 'ERROR' || status === 'TIMEOUT'
              if (isStale || isError || status === 'COMPLETE') {
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC.refresh, label: (isStale || isError) ? 'Retry' : 'Replay',
                    action: function () {
                      document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
                    }
                  },
                ])
              }

              if (n.attrs.supportsEmbedding && status === 'COMPLETE') {
                items = items.concat([
                  { type: 'divider' },
                  { icon: IC.promote, label: 'Embed in document',
                    action: function () {
                      document.dispatchEvent(new CustomEvent('sieve:promote-block', {
                        detail: { id: n.attrs.id }
                      }))
                    }
                  },
                ])
              }

              document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
                detail: { x: e.clientX, y: e.clientY, context: { type: 'sieveBlock', items: items } },
              }))

              var entries = null
              var extractSourceLabel = ''

              var closestImg = e.target.tagName === 'IMG' ? e.target
                : (e.target.closest ? e.target.closest('img') : null)
              if (closestImg && closestImg.src && wrapper.contains(closestImg)) {
                entries = [{ mimeType: 'text/uri-list', content: closestImg.src }]
                extractSourceLabel = 'image'
              }

              var closestA = e.target.tagName === 'A' ? e.target
                : (e.target.closest ? e.target.closest('a') : null)
              if (!entries && closestA && closestA.href && wrapper.contains(closestA)) {
                entries = [{ mimeType: 'text/uri-list', content: closestA.href }]
                extractSourceLabel = 'link'
              }

              if (!entries) {
                var textContent = ''
                var closestPre = e.target.closest && e.target.closest('pre')
                if (closestPre && wrapper.contains(closestPre)) {
                  var lang = ''
                  var codeEl = closestPre.querySelector('code') || closestPre
                  ;(codeEl.className || '').split(' ').forEach(function (cls) {
                    if (cls.indexOf('language-') === 0) lang = cls.slice(9)
                  })
                  textContent = '```' + lang + '\n' + codeEl.textContent + '\n```'
                  extractSourceLabel = lang === 'mermaid' ? 'diagram' : 'code'
                }

                if (!textContent) {
                  extractSourceLabel = n.attrs.kind || 'text'
                  if (n.attrs.kind === 'code' || n.attrs.kind === 'diagram') {
                    var lang = n.attrs.language || (n.attrs.kind === 'diagram' ? 'mermaid' : '')
                    textContent = '```' + lang + '\n' + (n.attrs.source || '') + '\n```'
                  } else if (n.attrs.serialisedForm) {
                    textContent = n.attrs.serialisedForm
                  } else {
                    textContent = extractTextFromDOM(wrapper)
                  }
                }

                if (textContent) {
                  entries = [{ mimeType: 'text/plain', content: textContent }]
                }
              }

              if (entries) {
                fetch('/api/detect-extractions', {
                  method: 'POST',
                  body: JSON.stringify({ sourceKind: n.attrs.kind, entries: entries }),
                  headers: { 'Content-Type': 'application/json' }
                }).then(function (res) { return res.json() }).then(function (candidates) {
                  if (!candidates || candidates.length === 0) return
                  if (!window.SieveContextMenu || !window.SieveContextMenu.appendItems) return

                  var extraItems = [
                    { type: 'divider' },
                    { type: 'header', label: 'EXTRACT FROM ' + extractSourceLabel.toUpperCase().replace('-', ' ') }
                  ]
                  candidates.forEach(function (c) {
                    var icon = IC[c.kind] || IC.code
                    var r = renderers[c.kind]
                    var prettyKind = (r && typeof r.getFriendlyName === 'function')
                      ? r.getFriendlyName()
                      : c.kind.split('-').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1) }).join(' ')

                    var defaultAction = function (context) {
                      document.dispatchEvent(new CustomEvent('sieve:extract', {
                        detail: { blockId: n.attrs.id, targetKind: c.kind, sourceNode: n, entries: entries, context: context || {} }
                      }))
                    }

                    if (r && typeof r.getExtractionMenuItems === 'function') {
                      var items = r.getExtractionMenuItems(n, entries, defaultAction)
                      if (items && items.length) {
                        items.forEach(function(item) { extraItems.push(item) })
                        return
                      }
                    }

                    extraItems.push({
                      icon: icon,
                      label: 'Extract as ' + prettyKind,
                      action: function () { defaultAction({}) }
                    })
                  })
                  window.SieveContextMenu.appendItems(extraItems)
                }).catch(function() {})
              }
            })

            return {
              dom: wrapper,
              contentDOM: null,
              update: function (updatedNode) {
                if (updatedNode.type.name !== nodeName) return false
                if (renderer.updateWidget) {
                  renderer.updateWidget(wrapper.firstChild, updatedNode.attrs, editor)
                } else {
                  buildContent(updatedNode.attrs)
                }
                return true
              },
              ignoreMutation: function () { return true },
              stopEvent: renderer.stopEvent
                ? function (e) { return renderer.stopEvent(e) }
                : defaultStopEvent,
            }
          }

          // ── Fallback path: makeNodeView (editable blocks during transition) ─
          var view = renderer.makeNodeView(node, editor)
          if (view.dom) {
            view.dom.addEventListener('contextmenu', function (e) {
              e.preventDefault()
              e.stopPropagation()
              var currentNode = (typeof getPos === 'function') ? editor.state.doc.nodeAt(getPos()) : node
              var n = currentNode || node
              var IC = window.SieveIcons || {}

              var items = renderer.buildContextMenuItems
                ? renderer.buildContextMenuItems({ node: n, editor: editor, getPos: getPos })
                : []

              var aiBase = renderer.buildAiCtx ? renderer.buildAiCtx(n) : {}
              var kindLabel = n.attrs.kind
                ? n.attrs.kind.charAt(0).toUpperCase() + n.attrs.kind.slice(1).replace(/-/g, ' ')
                : 'Block'
              var aiCtx = {
                content: '', blockRef: n.attrs.id || 'doc', history: '',
                contextLabel: (aiBase && aiBase.contextLabel) || kindLabel,
                imageIds: (aiBase && aiBase.imageIds) || [],
              }
              items = items.concat([
                { type: 'divider' },
                { icon: IC.sparkle, label: 'Ask AI…', action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: aiCtx } }))
                }},
                { icon: IC.info, label: 'Explain', action: function () {
                  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
                  else editor.commands.focus()
                  document.dispatchEvent(new CustomEvent('sieve:ai-explain', { detail: { precomputedCtx: aiCtx } }))
                }},
              ])
              items = items.concat([
                { type: 'divider' },
                { icon: IC.trash, label: 'Delete', action: function () {
                  if (typeof getPos === 'function') {
                    var pos = getPos()
                    editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
                  }
                }},
              ])
              var status = n.attrs.status || 'PENDING'
              var isStale = (status === 'PENDING' || status === 'DISPATCHED') && isJobStale(n.attrs.createdAt, n.attrs.id)
              var isError = status === 'ERROR' || status === 'TIMEOUT'
              if (isStale || isError || status === 'COMPLETE') {
                items = items.concat([{ type: 'divider' },
                  { icon: IC.refresh, label: (isStale || isError) ? 'Retry' : 'Replay',
                    action: function () { document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } })) }
                  }])
              }
              if (n.attrs.supportsEmbedding && status === 'COMPLETE') {
                items = items.concat([{ type: 'divider' },
                  { icon: IC.promote, label: 'Embed in document',
                    action: function () { document.dispatchEvent(new CustomEvent('sieve:promote-block', { detail: { id: n.attrs.id } })) }
                  }])
              }
              document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
                detail: { x: e.clientX, y: e.clientY, context: { type: 'sieveBlock', items: items } },
              }))
            })
          }
          return view
        }
      },
```

- [ ] **Step 4: Delete the mousemove selection hack**

In `addNodeView`, delete the `mousemove` listener block that currently follows the `contextmenu` handler. It starts with:
```js
            // Extend the ProseMirror selection through this block during a mouse drag.
```
and ends before `}` then `return view`. Delete those ~25 lines entirely.

- [ ] **Step 5: Delete the `mouseup` re-apply block at the bottom of the file**

Find and delete this entire block (lines ~467–484):
```js
  // Re-apply the sieve-inclusive selection after ProseMirror's mouseup handler resets it.
  document.addEventListener('mouseup', function () {
    var hint = T._sieveDragSel
    if (!hint) return
    T._sieveDragSel = null
    setTimeout(function () {
      try {
        var ed = hint.editor
        var tr = ed.state.tr.setSelection(
          T.TextSelection.create(ed.state.doc, hint.anchor, hint.head)
        )
        ed.view.dispatch(tr)
      } catch (_) {}
    }, 0)
  })
```

- [ ] **Step 6: Compile check**

```bash
go build -tags webkit2_41 ./...
```
Expected: exits 0, no output.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/static/sieve-block-extension.js
git commit -m "refactor(blocks): atom:false framework invariant + makeWidget NodeView path"
```

---

## Task 2: Migrate web-clip-renderer.js

**Files:** Modify `frontend/src/static/web-clip-renderer.js`

- [ ] **Step 1: Remove `atom: true` from `nodeConfig`**

Find:
```js
    nodeConfig: {
      atom: true,
      selectable: false,
      draggable: false,
    },
```
Replace with:
```js
    nodeConfig: {
      selectable: false,
      draggable: false,
    },
```

- [ ] **Step 2: Rename `makeNodeView` → `makeWidget`, change signature, remove `contentEditable`**

Find:
```js
    makeNodeView: function (node, editor) {

      var dom = document.createElement('div')
      dom.className = 'web-clip-block'
      dom.contentEditable = 'false'
      dom.setAttribute('draggable', 'false')
      dom.setAttribute('data-id', node.attrs.id || '')
```
Replace with:
```js
    makeWidget: function (attrs, editor) {

      var dom = document.createElement('div')
      dom.className = 'web-clip-block'
      dom.setAttribute('draggable', 'false')
      dom.setAttribute('data-id', attrs.id || '')
```

- [ ] **Step 3: Update `render` function signature and body**

Find:
```js
      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-id', n.attrs.id || '')
        
        var outerBadge = document.createElement('span')
        outerBadge.className = 'web-clip-block__badge'
        outerBadge.textContent = 'WEB CLIP'
        dom.appendChild(outerBadge)

        var attrs = n.attrs
        var status = attrs.status || 'PENDING'
```
Replace with:
```js
      function render(a) {
        dom.innerHTML = ''
        dom.setAttribute('data-id', a.id || '')

        var outerBadge = document.createElement('span')
        outerBadge.className = 'web-clip-block__badge'
        outerBadge.textContent = 'WEB CLIP'
        dom.appendChild(outerBadge)

        var status = a.status || 'PENDING'
```

- [ ] **Step 4: Replace remaining `attrs.X` references inside `render` with `a.X`**

Inside `render`, find every `attrs.` reference and change to `a.`. The `attrs` local was removed in Step 3. Affected lines include `attrs.source`, `attrs.createdAt`, `attrs.id`, `attrs.mode`, `attrs.title`, `attrs.content`, `attrs.error`, `attrs.completedAt`. Also update `modeLabel` and `completeModeLabel` to use `a.mode`.

Example (`PENDING` branch):
```js
        var stale = isStale(a.createdAt, a.id)
        // ...
        var modeLabel = a.mode === 'summarise' ? 'Summarising' : 'Fetching'
        // ...
        '<span class="web-clip-block__label">' + modeLabel.replace('ing', '') + ' — ' + a.source + '</span>'
```

- [ ] **Step 5: Update the initial `render()` call**

Find:
```js
      render(node)
```
Replace with:
```js
      render(attrs)
```

- [ ] **Step 6: Remove the NodeView return object; return `dom` and add `updateWidget`**

Find:
```js
      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-web-clip') return false
          render(updatedNode)
          return true
        },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
      }
    },
```
Replace with:
```js
      return dom
    },

    updateWidget: function (dom, attrs, editor) {
      // Re-use the render closure isn't available here, so delegate to a full rebuild.
      // The framework calls makeWidget again via buildContent when updateWidget is absent;
      // this explicit version avoids destroying/recreating the DOM element on every WS update.
      // (For web-clip, full rebuild is acceptable — no user-editable state inside the block.)
    },
```

Actually, because `render` closes over `dom` (a local variable inside `makeWidget`), `updateWidget` cannot call it. Remove `updateWidget` entirely and let the framework fall back to `buildContent` (which calls `makeWidget` again). Replace the above with simply:

```js
      return dom
    },
```

- [ ] **Step 7: Smoke test**

Run `wails dev`. Open a document containing a web-clip block.
- Mouse-drag a selection starting before the block and ending after it — confirm selection spans the block without fighting
- Cmd+C → paste into a text editor — confirm the fenced markdown fence appears
- Right-click the block — confirm context menu appears with all items
- Block re-renders correctly after a retry (or observe a COMPLETE block displays title/content)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/static/web-clip-renderer.js
git commit -m "refactor(web-clip): migrate to makeWidget interface"
```

---

## Task 3: Migrate ai-block-renderer.js

**Files:** Modify `frontend/src/static/ai-block-renderer.js`

The pattern is identical to Task 2. Read the file first, then apply the same four changes:

- [ ] **Step 1: Remove `atom: true` from `nodeConfig`**

Find `nodeConfig: { atom: true, selectable: false, draggable: false }` (line 27).
Replace with `nodeConfig: { selectable: false, draggable: false }`.

- [ ] **Step 2: Rename `makeNodeView` → `makeWidget`, change signature `(node, editor)` → `(attrs, editor)`, remove `dom.contentEditable = 'false'`**

Find (line ~50):
```js
    makeNodeView: function (node, editor) {
```
Replace with:
```js
    makeWidget: function (attrs, editor) {
```

Find and delete the line:
```js
      dom.contentEditable = 'false'
```

- [ ] **Step 3: Update render function**

Read the `render` function. It either takes `(n)` and accesses `n.attrs` or already takes `(attrs)`. Look at the first line of `render`:

- If it is `function render(n) {` with `n.attrs.X` usage: rename parameter to `a`, delete any `var attrs = n.attrs` line, replace all `n.attrs.X` and `attrs.X` with `a.X`.
- If it already is `function render(attrs) {`: check only that the initial call `render(node)` → `render(attrs)` is updated (the parameter was already renamed).

Find the initial call to render at the end of the DOM setup — change `render(node)` → `render(attrs)`.

- [ ] **Step 4: Remove the NodeView return object; return `dom`**

Find the `return { dom: dom, contentDOM: null, update: ..., ignoreMutation: ..., stopEvent: ... }` block and replace with:
```js
      return dom
    },
```

- [ ] **Step 5: Smoke test**

Run `wails dev`. Open a document with an AI block (Ask AI or Explain).
- Selection drag across the block works
- Context menu works
- If a job is running, spinner → content transition still works

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/ai-block-renderer.js
git commit -m "refactor(ai-block): migrate to makeWidget interface"
```

---

## Task 4: Migrate smart-card-renderer.js

**Files:** Modify `frontend/src/static/smart-card-renderer.js`

Same pattern as Tasks 2–3.

- [ ] **Step 1: Remove `atom: true` from `nodeConfig`**

Find `nodeConfig: { atom: true, selectable: false, draggable: false }` (line 16).
Replace with `nodeConfig: { selectable: false, draggable: false }`.

- [ ] **Step 2: Rename `makeNodeView` → `makeWidget`, change signature, remove `dom.contentEditable = 'false'`**

Line 42: `makeNodeView: function (node, editor) {` → `makeWidget: function (attrs, editor) {`
Line 45: delete `dom.contentEditable = 'false'`

- [ ] **Step 3: Update render function — change `render(n)` to `render(a)` and fix all `n.attrs.X` / `attrs.X` → `a.X` refs inside it**

Find the render function definition. Change its parameter from `(n)` to `(a)`, delete any `var attrs = n.attrs` line, replace all `n.attrs.` and `attrs.` references with `a.`.

Change the initial call from `render(node)` → `render(attrs)`.

- [ ] **Step 4: Remove NodeView return object; return `dom`**

Replace `return { dom: dom, contentDOM: null, update: ..., ignoreMutation: ..., stopEvent: ... }` with:
```js
      return dom
    },
```

- [ ] **Step 5: Smoke test + commit**

```bash
# wails dev: verify smart card renders, selection works, context menu works
git add frontend/src/static/smart-card-renderer.js
git commit -m "refactor(smart-card): migrate to makeWidget interface"
```

---

## Task 5: Migrate smart-link-renderer.js

**Files:** Modify `frontend/src/static/smart-link-renderer.js`

Smart-link is an **inline** block (`group: "inline"`, `inline: true`). The pattern is the same but note it uses `<span>` not `<div>` for its DOM element.

- [ ] **Step 1: Remove `atom: true` from `nodeConfig`**

Find `nodeConfig: { atom: true, selectable: true, draggable: false, inline: true, group: "inline" }` (line 17).
Replace with `nodeConfig: { selectable: true, draggable: false, inline: true, group: "inline" }`.

- [ ] **Step 2: Rename `makeNodeView` → `makeWidget`, change signature, remove `contentEditable = 'false'` if present**

Line 35: `makeNodeView: function (node, editor) {` → `makeWidget: function (attrs, editor) {`

Check if `dom.contentEditable = 'false'` exists in this file — delete it if so.

- [ ] **Step 3: Update render function and initial call**

Same pattern as Tasks 2–4. Rename parameter `(n)` → `(a)`, fix `n.attrs.X` → `a.X`, fix initial call `render(node)` → `render(attrs)`.

- [ ] **Step 4: Remove NodeView return; return `dom`**

```js
      return dom
    },
```

- [ ] **Step 5: Smoke test + commit**

```bash
# wails dev: hover a smart link, verify pill renders, click opens URL
git add frontend/src/static/smart-link-renderer.js
git commit -m "refactor(smart-link): migrate to makeWidget interface"
```

---

## Task 6: Migrate smart-image-renderer.js

**Files:** Modify `frontend/src/static/smart-image-renderer.js`

This file has an unusual structure: `makeNodeView` is a **module-level function** (not a method), referenced as `makeNodeView: makeNodeView` on the renderer object. The renderer also has `atom: true` on a separate property (line 138), not inside `nodeConfig`.

- [ ] **Step 1: Read the file**

```bash
cat -n frontend/src/static/smart-image-renderer.js
```

Understand the structure before editing. Note the location of:
- The module-level `function makeNodeView(node, editor) {` (line 22)
- `dom.contentEditable = 'false'` (line 29)
- The `update` / `ignoreMutation` NodeView return (lines 119–137)
- `atom: true` on the renderer object (line 138)
- `makeNodeView: makeNodeView` (line 161)

- [ ] **Step 2: Rename the module-level function and change its signature**

Find:
```js
  function makeNodeView(node, editor) {
```
Replace with:
```js
  function makeWidget(attrs, editor) {
```

- [ ] **Step 3: Remove `dom.contentEditable = 'false'` (line 29)**

Delete that line.

- [ ] **Step 4: Update any `node.attrs.X` references inside the function to `attrs.X`**

Read the function body — wherever it accesses `node.attrs`, change to `attrs`. Also fix any `var a = node.attrs` or similar.

Update the initial render call at the end of the function from `render(node)` → `render(attrs)` and the render function itself if it accesses `node.attrs`.

- [ ] **Step 5: Remove NodeView return; return `dom`**

Replace the `return { dom: dom, contentDOM: null, update: ..., ignoreMutation: ... }` block with:
```js
    return dom
  }
```

- [ ] **Step 6: Remove `atom: true` from the renderer object and update the `makeNodeView` reference**

Find the renderer object definition. It will have:
```js
    atom: true,
    // ...
    makeNodeView: makeNodeView,
```

Change to:
```js
    makeWidget: makeWidget,
```
(Delete the `atom: true` line entirely.)

- [ ] **Step 7: Smoke test + commit**

```bash
# wails dev: verify smart image block renders, selection works
git add frontend/src/static/smart-image-renderer.js
git commit -m "refactor(smart-image): migrate to makeWidget interface"
```

---

## Task 7: Remove outer contentEditable from code-renderer.js

The code block is an editable block with a complex NodeView (`destroy`, `selectNode`, timer state). We do **not** migrate it to `makeWidget` in this plan. We remove only the outer `dom.contentEditable = 'false'` so selection can pass through the block boundary. The inner `header.contentEditable = 'false'` and `gutter.contentEditable = 'false'` remain — they protect non-edit sub-elements and don't affect cross-block selection.

**Files:** Modify `frontend/src/static/code-renderer.js`

- [ ] **Step 1: Remove `atom: true` from nodeConfig**

Find (around line 23):
```js
      atom:       true,
```
Delete that line.

- [ ] **Step 2: Remove the outer `dom.contentEditable = 'false'`**

Find (line 51):
```js
      dom.contentEditable = 'false'
```
Delete that line. Leave `header.contentEditable = 'false'` (line 56) and `gutter.contentEditable = 'false'` (line 68) in place.

- [ ] **Step 3: Smoke test**

```bash
# wails dev
```
- Create a code block, type in it — editing still works
- Selection drag from outside → across code block → outside — confirm it no longer fights
- Right-click context menu works
- Language detection fires after typing

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/code-renderer.js
git commit -m "fix(code-block): remove outer contentEditable=false to allow cross-block selection"
```

---

## Task 8: Remove outer contentEditable from diagram-renderer.js

Same minimal change as Task 7.

**Files:** Modify `frontend/src/static/diagram-renderer.js`

- [ ] **Step 1: Remove `atom: true`**

Find (around line 142):
```js
      atom:       true,
```
Delete that line.

- [ ] **Step 2: Remove `dom.contentEditable = 'false'`**

Find (line 173):
```js
      dom.contentEditable = 'false'
```
Delete that line. Leave `header.contentEditable = 'false'` and `gutter.contentEditable = 'false'` in place.

- [ ] **Step 3: Smoke test**

```bash
# wails dev
```
- Diagram block renders and mermaid SVG displays correctly
- Editing the diagram source re-renders the SVG
- Selection drag across diagram block works
- Context menu works

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/diagram-renderer.js
git commit -m "fix(diagram-block): remove outer contentEditable=false to allow cross-block selection"
```

---

## Task 9: Clean up editor.js, editor.css, and remove makeNodeView fallback

**Files:**
- Modify `frontend/src/static/editor.js`
- Modify `frontend/src/static/editor.css`
- Modify `frontend/src/static/sieve-block-extension.js`

- [ ] **Step 1: Delete `.sieve-in-selection` logic from `editor.js`**

Find the `onSelectionUpdate` callback (lines 176–191). It currently contains:

```js
      onSelectionUpdate: function (p) {
        var view = p.editor.view
        var sel  = p.editor.state.selection
        view.dom.querySelectorAll('.sieve-in-selection').forEach(function (el) {
          el.classList.remove('sieve-in-selection')
        })
        if (sel && sel.from !== sel.to) {
          p.editor.state.doc.nodesBetween(sel.from, sel.to, function (node) {
            if (!node.isAtom) return true
            var id = node.attrs && node.attrs.id
            if (!id) return true
            var el = view.dom.querySelector('[data-id="' + id + '"]')
            if (el) el.classList.add('sieve-in-selection')
          })
        }
      },
```

Replace with:
```js
      onSelectionUpdate: function (_p) {},
```

- [ ] **Step 2: Delete `.sieve-in-selection` rule from `editor.css`**

Find and delete (lines 115–120):
```css
/* Range-selection highlight for sieve atom blocks (::selection doesn't apply to contentEditable=false) */
.sieve-in-selection {
  outline: 2px solid var(--theme-selectionBg) !important;
  outline-offset: -1px;
  background: color-mix(in srgb, var(--theme-selectionBg) 30%, transparent) !important;
}
```

- [ ] **Step 3: Add a `console.warn` to the `makeNodeView` fallback in `sieve-block-extension.js`**

The fallback path added in Task 1 keeps code/diagram working. Add a warning so it's visible during development:

Find the start of the fallback block:
```js
          // ── Fallback path: makeNodeView (editable blocks during transition) ─
          var view = renderer.makeNodeView(node, editor)
```

Replace with:
```js
          // ── Fallback path: makeNodeView (code/diagram — pending full migration) ─
          console.warn('[sieve] renderer "' + kind + '" still uses makeNodeView — migrate to makeWidget in a follow-on PR')
          var view = renderer.makeNodeView(node, editor)
```

The fallback stays in the codebase. The `console.warn` makes it visible in DevTools as a reminder.

- [ ] **Step 4: Compile check + full smoke test**

```bash
go build -tags webkit2_41 ./...
```

Run `wails dev`. Test all block kinds:
- Web clip: select across, copy, context menu, retry ✓
- AI block: select across, copy, context menu ✓
- Smart card: select across, context menu ✓
- Smart link: inline rendering, context menu ✓
- Smart image: rendering, context menu ✓
- Code block: type in textarea, language detection, select across block ✓
- Diagram block: edit source, SVG re-render, select across block ✓

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor.js frontend/src/static/editor.css frontend/src/static/sieve-block-extension.js
git commit -m "chore(blocks): remove sieve-in-selection hack, warn on makeNodeView fallback"
```

---

## Task 10: Update docs

**Files:** Modify `docs/how-to-sieve-block-framework.md`

- [ ] **Step 1: Update `nodeConfig` table**

Find the table row for `nodeConfig` in Part 3 Reference. Remove the `atom` row. Add a `content` row:

```markdown
| `content` | `''` | ProseMirror content model. `''` (default) = leaf node. `'text*'` = stores text children. `'block*'` = stores block children (for future interactive blocks). |
```

- [ ] **Step 2: Update the renderer template in Part 2 Step 2**

Find `makeNodeView: function (node, editor) {` in the template. Replace with `makeWidget: function (attrs, editor) {`.

Remove `dom.contentEditable = 'false'` from the template.

Remove the NodeView return object:
```js
      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) { ... },
        ignoreMutation: function () { return true },
        stopEvent: function (event) { ... },
      }
```

Replace with:
```js
      return dom
    },
```

- [ ] **Step 3: Update the silent failure modes table**

Remove the row for `contentDOM set to a DOM element instead of null`.

Add a row:
```markdown
| `makeWidget` not renamed from `makeNodeView` | Block uses fallback path; `console.warn` fires; no functional breakage but migration is incomplete |
```

Update the `atom: false in nodeConfig` row to:
```markdown
| `atom` set in `nodeConfig` | Silently ignored — `atom` is now a framework invariant (always `false`). Remove it from nodeConfig. |
```

- [ ] **Step 4: Commit**

```bash
git add docs/how-to-sieve-block-framework.md
git commit -m "docs: update renderer guide for makeWidget interface and atom:false invariant"
```
