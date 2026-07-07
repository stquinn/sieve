# Ambient Context-Aware Ask AI Panel — Implementation Plan

> **STATUS: DONE** — shipped; resolveAiTarget, persistent #ask-panel, and Ctrl+Shift+A toggleAskFocus all live. Archived 2026-07-07.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Ask AI dialog into a persistent, context-aware panel whose target (Sieve block / anchor / selection / document) tracks the caret live with zero document mutation, commits an anchor only at SEND, and lets `Ctrl+Shift+A` bounce focus in/out restoring the caret.

**Architecture:** One pure read-only resolver (`resolveAiTarget`) is the single source of truth for the target's kind, range, and label. Three consumers — the live panel label, an ephemeral glow decoration plugin, and the (now read-only) `buildAiContext` job-payload builder — all derive from it and cannot disagree. The only mutation (minting a `blockRef` anchor + `==` highlight) happens at SEND, via the existing `applyTargetHighlight`, and only for the `selection` kind.

**Tech Stack:** Vanilla JS (TipTap 2 / ProseMirror), vitest + happy-dom for unit tests (new, dev-only), Go (`go build` compile check), `wails dev` for manual UI verification.

**Spec:** `docs/superpowers/specs/2026-06-11-ambient-ask-ai-panel-design.md`

**Testing note:** This plan unit-tests the *pure logic* (`resolveAiTarget` / `describeTarget`). The *UI rendering* (glow, focus, live label) is verified manually in `wails dev` here and will get real browser-driven coverage in the separate Playwright harness spec (deliberately out of scope).

---

## File Structure

| File | Responsibility | New/Modify |
|------|---------------|------------|
| `frontend/package.json` | Add `vitest` + `happy-dom` devDeps and a `test` script | Modify |
| `frontend/vitest.config.js` | Vitest config (happy-dom env, test glob) | Create |
| `frontend/test/helpers/editor-fixture.js` | Build a ProseMirror `EditorState` with a minimal Sieve-shaped schema + selection helpers | Create |
| `frontend/test/ai-target.test.js` | Unit tests for `resolveAiTarget` / `describeTarget` | Create |
| `frontend/src/static/ai-target.js` | **NEW** pure module: `resolveAiTarget`, `describeTarget`, `quoteSnippet`, `titleCase`. No TipTap-construction deps → loadable in Node. | Create |
| `frontend/src/static/sieve-block-extension.js` | Expose `T.getSieveBlockLabel(node)` from the renderer registry | Modify |
| `frontend/src/static/extensions.js` | `buildAiContext` → read-only, delegates to `resolveAiTarget`, drops native code/table targeting; `getAiTargetLabel` → thin delegate | Modify |
| `frontend/src/static/ai-target-decoration.js` | **NEW** glow plugin: `{range}` state, `aiTargetKey` meta setter, one `Decoration.node({class:'block-ai-target'})` | Create |
| `frontend/src/static/editor.js` | Live glow dispatch; precomputed-pin guard; focus toggle + `returnSelection`; defer mint to SEND in `doAsk` | Modify |
| `frontend/src/static/editor.css` | `.block-ai-target` glow, sharing chrome rail vocabulary | Modify |
| `frontend/src/index.html` | Load `ai-target.js` + `ai-target-decoration.js`; register `T.AiTargetDecoration` | Modify |

---

## Task 1: Vitest tooling + ProseMirror fixture harness

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/vitest.config.js`
- Create: `frontend/test/helpers/editor-fixture.js`
- Create: `frontend/test/smoke.test.js`

- [ ] **Step 1: Add devDeps + test script to `package.json`**

In `frontend/package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```
Add to `"devDependencies"` (keep alphabetical-ish):
```json
"happy-dom": "^15.11.6",
"vitest": "^2.1.8"
```

- [ ] **Step 2: Install**

Run: `cd frontend && npm install`
Expected: `node_modules/.bin/vitest` exists.

- [ ] **Step 3: Create `frontend/vitest.config.js`**

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.js'],
  },
})
```

- [ ] **Step 4: Create the fixture harness `frontend/test/helpers/editor-fixture.js`**

Builds a minimal ProseMirror schema mirroring the node *names* the resolver inspects (`blockRef`, `sieve-*`, `codeBlock`, `table`) plus prose nodes, and helpers to place a selection. `@tiptap/pm` is already a dependency.

```js
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'

// Minimal schema: enough node NAMES for resolveAiTarget's type checks.
// sieve-* atoms carry id/kind/serialisedForm like real Sieve blocks.
export const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: { group: 'inline' },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', ['code', 0]] },
    table: { group: 'block', content: 'paragraph+', toDOM: () => ['table', ['tbody', 0]] },
    // blockRef = anchor: wraps a block, carries an id
    blockRef: {
      group: 'block', content: 'block+',
      attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-id': n.attrs.id, class: 'block-ref' }, 0],
    },
    // a generic sieve atom (e.g. sieve-code), and the ai-block follow-up atom
    'sieve-code': sieveAtom('code'),
    'sieve-ai-block': sieveAtom('ai-block'),
  },
  marks: {
    highlight: { toDOM: () => ['mark', 0], parseDOM: [{ tag: 'mark' }] },
  },
})

function sieveAtom(kind) {
  return {
    group: 'block', atom: true, selectable: true,
    attrs: { id: { default: '' }, kind: { default: kind }, serialisedForm: { default: '' }, ref: { default: '' } },
    toDOM: (n) => ['div', { 'data-id': n.attrs.id, 'data-type': 'sieve-' + n.attrs.kind }],
  }
}

const n = schema.nodes
const t = (s) => schema.text(s)

// Build a doc + place a TextSelection inside the block at `blockIndex`
// at character offset `charOffset` (collapsed caret). Returns { editor }.
export function docWithCaret(nodes, blockIndex, charOffset) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  // position of blockIndex's content start:
  let pos = 1 // after doc open
  for (let i = 0; i < blockIndex; i++) pos += nodes[i].nodeSize
  const sel = TextSelection.create(state.doc, pos + 1 + (charOffset || 0))
  state = state.apply(state.tr.setSelection(sel))
  return { editor: { state }, schema }
}

// Build a doc with a TextSelection spanning [from,to] (absolute doc positions).
export function docWithRange(nodes, from, to) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
  return { editor: { state }, schema }
}

// Build a doc with a NodeSelection on the block at `blockIndex`.
export function docWithNodeSelection(nodes, blockIndex) {
  const doc = n.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  let pos = 1
  for (let i = 0; i < blockIndex; i++) pos += nodes[i].nodeSize
  state = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, pos - 1)))
  return { editor: { state }, schema }
}

// Convenience node builders for tests
export const build = {
  p: (text) => n.paragraph.create(null, text ? t(text) : null),
  code: (text) => n.codeBlock.create(null, text ? t(text) : null),
  sieveCode: (id) => n['sieve-code'].create({ id, kind: 'code', serialisedForm: '' }),
  aiBlock: (id, ref) => n['sieve-ai-block'].create({ id, kind: 'ai-block', serialisedForm: '', ref: ref || '' }),
  anchor: (id, inner) => n.blockRef.create({ id }, inner),
}
```

- [ ] **Step 5: Smoke test `frontend/test/smoke.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { docWithCaret, build } from './helpers/editor-fixture.js'

describe('fixture harness', () => {
  it('builds a doc with a caret', () => {
    const { editor } = docWithCaret([build.p('hello')], 0, 1)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.selection.empty).toBe(true)
  })
})
```

- [ ] **Step 6: Run the smoke test**

Run: `cd frontend && npm test`
Expected: PASS, 1 test.

- [ ] **Step 7: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.js frontend/test/
git commit -m "test: add vitest + happy-dom harness with ProseMirror fixtures"
```

---

## Task 2: `resolveAiTarget` — target kind + range (pure)

**Files:**
- Create: `frontend/src/static/ai-target.js`
- Test: `frontend/test/ai-target.test.js`

- [ ] **Step 1: Write failing tests for the four kinds**

Create `frontend/test/ai-target.test.js`:
```js
import { describe, it, expect, beforeEach } from 'vitest'
import { docWithCaret, docWithRange, build } from './helpers/editor-fixture.js'

let resolveAiTarget
beforeEach(async () => {
  // ai-target.js is a non-module IIFE that attaches to window.TipTap.
  global.window.TipTap = global.window.TipTap || {}
  // Stub the sieve label lookup (real impl lives in sieve-block-extension.js).
  window.TipTap.getSieveBlockLabel = (node) => (node.attrs.kind === 'code' ? 'Code Block' : 'Block')
  await import('../src/static/ai-target.js')
  resolveAiTarget = window.TipTap.resolveAiTarget
})

describe('resolveAiTarget — kinds', () => {
  it('caret in plain paragraph → document', () => {
    const { editor } = docWithCaret([build.p('just text')], 0, 2)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })

  it('text selection in a paragraph → selection with range', () => {
    // doc: <p>hello</p>; select "hel" = positions 1..4
    const { editor } = docWithRange([build.p('hello')], 1, 4)
    const t = resolveAiTarget(editor, false)
    expect(t.kind).toBe('selection')
    expect(t.range).toEqual({ from: 1, to: 4 })
  })

  it('caret inside a sieve block → sieveBlock with id + node range', () => {
    const { editor } = docWithCaret([build.p('x'), build.aiBlock('ai-1')], 0, 0)
    // move selection onto the atom via NodeSelection helper instead:
    const ns = docWithRange([build.p('x'), build.sieveCode('c-1')], 4, 4) // caret just before atom
    const t = resolveAiTarget(ns.editor, false)
    expect(t.kind).toBe('sieveBlock')
    expect(t.id).toBe('c-1')
    expect(t.range).toBeTruthy()
  })

  it('caret inside an existing anchor (blockRef) → anchor with id', () => {
    const { editor } = docWithCaret([build.anchor('blk-9', [build.p('inside')])], 0, 1)
    const t = resolveAiTarget(editor, false)
    expect(t.kind).toBe('anchor')
    expect(t.id).toBe('blk-9')
  })

  it('native code block is NOT a target → document (dropped scope)', () => {
    const { editor } = docWithCaret([build.code('const x = 1')], 0, 2)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })

  it('performs no mutation (doc identity unchanged)', () => {
    const { editor } = docWithRange([build.p('hello')], 1, 4)
    const before = editor.state.doc
    resolveAiTarget(editor, false)
    expect(editor.state.doc).toBe(before)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && npx vitest run test/ai-target.test.js`
Expected: FAIL — `resolveAiTarget is not a function`.

- [ ] **Step 3: Implement `frontend/src/static/ai-target.js`**

```js
// ai-target.js — pure, read-only AI target resolution.
// The single source of truth for "what would Ask AI act on right now".
// NO mutation, ever. Safe to call on every caret move. No TipTap-construction
// deps, so it loads in Node (vitest) with a minimal window.TipTap stub.
;(function () {
  'use strict'
  var T = (typeof window !== 'undefined' && window.TipTap) ? window.TipTap : (window.TipTap = {})

  function titleCase(kind) {
    if (!kind) return 'Block'
    return kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')
  }

  // Quote + truncate a snippet on a word boundary near 20 chars.
  function quoteSnippet(text) {
    var s = (text || '').replace(/\s+/g, ' ').trim()
    if (!s) return 'Selection'
    if (s.length > 20) {
      var cut = s.slice(0, 20)
      var sp = cut.lastIndexOf(' ')
      if (sp > 8) cut = cut.slice(0, sp)
      return '"' + cut + '…"'
    }
    return '"' + s + '"'
  }

  function isSieveName(name) { return name === 'aiBlock' || name === 'sieve-ai-block' || name.indexOf('sieve-') === 0 }
  function isAnchorName(name) { return name === 'blockRef' }
  function isTargetName(name) { return isSieveName(name) || isAnchorName(name) }

  // Read a block id from the DOM focus / native selection (mirrors buildAiContext).
  // Returns '' if none (e.g. in Node tests with no real DOM focus).
  function domBlockId() {
    if (typeof document === 'undefined') return ''
    var el = document.activeElement
    if (el && el.closest) {
      var hit = el.closest('[data-id], [data-type^="sieve-"]')
      if (hit) return hit.getAttribute('data-id') || ''
    }
    var sel = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
    if (sel && sel.anchorNode) {
      var node = sel.anchorNode
      if (node.nodeType === 3) node = node.parentElement
      if (node && node.closest) {
        var hit2 = node.closest('[data-id], [data-type^="sieve-"]')
        if (hit2) return hit2.getAttribute('data-id') || ''
      }
    }
    return ''
  }

  // Find the target block node (blockRef anchor or sieve-* block) for the current
  // selection, or null. Native code/table nodes are intentionally NOT targets.
  function findBlockTarget(state) {
    var doc = state.doc, sel = state.selection
    var from = sel.from, to = sel.to

    // Stage 1: DOM-anchored id.
    var domId = domBlockId()
    if (domId) {
      var hit = null
      doc.descendants(function (node, pos) {
        if (hit) return false
        if (node.attrs && node.attrs.id === domId && isTargetName(node.type.name)) {
          hit = { node: node, pos: pos }; return false
        }
      })
      if (hit) return hit
    }

    // Stage 2: ancestor depth walk from the caret.
    for (var d = sel.$from.depth; d >= 1; d--) {
      var anc = sel.$from.node(d)
      if (isTargetName(anc.type.name)) return { node: anc, pos: sel.$from.before(d) }
    }

    // Stage 3: scan the block(s) touched by the caret/selection.
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo = (from === to) ? Math.min(doc.content.size, to + 1) : to
    var scanned = null
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (scanned) return false
      if (isTargetName(node.type.name)) { scanned = { node: node, pos: pos }; return false }
    })
    return scanned
  }

  // describeTarget(node|null, selectionText|null) → friendly label (no "Ask About" prefix)
  function describeTarget(node, selectionText) {
    if (node) {
      var name = node.type.name
      if (name === 'aiBlock' || name === 'sieve-ai-block') return 'Follow-up'
      if (name === 'blockRef') return quoteSnippet(node.textContent || '')
      if (name.indexOf('sieve-') === 0) {
        return (T.getSieveBlockLabel ? T.getSieveBlockLabel(node) : titleCase(node.attrs.kind))
      }
      return titleCase(name)
    }
    if (selectionText != null) return quoteSnippet(selectionText)
    return 'Document'
  }

  // resolveAiTarget(editor, isMarkdownMode) → { kind, id?, range?, label, node? }
  function resolveAiTarget(editor, isMarkdownMode) {
    if (isMarkdownMode) {
      var ta = (typeof document !== 'undefined') ? document.querySelector('.markdown-raw') : null
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        return { kind: 'selection', range: null, label: quoteSnippet(ta.value.slice(ta.selectionStart, ta.selectionEnd)) }
      }
      return { kind: 'document', range: null, label: 'Document' }
    }

    var state = editor.state
    var sel = state.selection
    var doc = state.doc
    var from = sel.from, to = sel.to

    var found = findBlockTarget(state)
    if (found) {
      var n = found.node
      return {
        kind: isAnchorName(n.type.name) ? 'anchor' : 'sieveBlock',
        id: n.attrs.id || '',
        range: { from: found.pos, to: found.pos + n.nodeSize },
        label: describeTarget(n, null),
        node: n,
      }
    }
    if (from !== to) {
      return { kind: 'selection', range: { from: from, to: to }, label: describeTarget(null, doc.textBetween(from, to, ' ')) }
    }
    return { kind: 'document', range: null, label: 'Document' }
  }

  T.titleCase = titleCase
  T.quoteSnippet = quoteSnippet
  T.describeTarget = describeTarget
  T.resolveAiTarget = resolveAiTarget
})()
```

- [ ] **Step 4: Run to verify pass**

Run: `cd frontend && npx vitest run test/ai-target.test.js`
Expected: PASS (kinds + no-mutation).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/ai-target.js frontend/test/ai-target.test.js
git commit -m "feat: pure resolveAiTarget — four target kinds, read-only"
```

---

## Task 3: `describeTarget` labels — selection snippet + Follow-up

**Files:**
- Modify: `frontend/test/ai-target.test.js`
- Modify: `frontend/src/static/ai-target.js` (only if a test fails — implementation already present)

- [ ] **Step 1: Add label tests**

Append to `frontend/test/ai-target.test.js`:
```js
describe('resolveAiTarget — labels', () => {
  it('selection label quotes a short word', () => {
    const { editor } = docWithRange([build.p('product')], 1, 8) // "product"
    expect(resolveAiTarget(editor, false).label).toBe('"product"')
  })

  it('selection label truncates long text on a word boundary', () => {
    const { editor } = docWithRange([build.p('the quarterly revenue summary')], 1, 30)
    const label = resolveAiTarget(editor, false).label
    expect(label.startsWith('"the quarterly')).toBe(true)
    expect(label.endsWith('…"')).toBe(true)
    expect(label.length).toBeLessThan(26)
  })

  it('sieve block label comes from getSieveBlockLabel', () => {
    const { editor } = docWithRange([build.p('x'), build.sieveCode('c-1')], 4, 4)
    expect(resolveAiTarget(editor, false).label).toBe('Code Block')
  })

  it('ai-block label is Follow-up', () => {
    const { editor } = docWithRange([build.p('x'), build.aiBlock('ai-1')], 4, 4)
    expect(resolveAiTarget(editor, false).label).toBe('Follow-up')
  })

  it('document label is Document', () => {
    const { editor } = docWithCaret([build.p('hi')], 0, 1)
    expect(resolveAiTarget(editor, false).label).toBe('Document')
  })
})
```

- [ ] **Step 2: Run tests**

Run: `cd frontend && npx vitest run test/ai-target.test.js`
Expected: PASS. If the snippet boundary test fails, adjust `quoteSnippet` in `ai-target.js` (the `sp > 8` boundary) until green — do not change test intent.

- [ ] **Step 3: Commit**

```bash
git add frontend/test/ai-target.test.js frontend/src/static/ai-target.js
git commit -m "test: label cases for resolveAiTarget (snippet, Follow-up, block)"
```

---

## Task 4: Expose `T.getSieveBlockLabel` from the renderer registry

**Files:**
- Modify: `frontend/src/static/sieve-block-extension.js:404-418`

- [ ] **Step 1: Add the canonical sieve-block label seam**

After the `registerSieveRenderer` function (sieve-block-extension.js:410), add:
```js
  // Canonical friendly name for a sieve block node — the ONE source the live
  // label, the context menu, and the commit path share. Reuses each renderer's
  // optional buildAiCtx(node).contextLabel (e.g. a code block surfacing its
  // language), falling back to a title-cased kind.
  T.getSieveBlockLabel = function (node) {
    var kind = node && node.attrs ? node.attrs.kind : ''
    var r = renderers[kind]
    var base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    var fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  }
```

- [ ] **Step 2: Compile check**

Run: `cd frontend && node -e "require('fs').readFileSync('src/static/sieve-block-extension.js','utf8'); console.log('ok')"`
Expected: `ok` (syntax sanity — file is an ES module loaded by the browser; full behavior verified in Task 10).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/static/sieve-block-extension.js
git commit -m "feat: expose T.getSieveBlockLabel from renderer registry"
```

---

## Task 5: `buildAiContext` → read-only, delegate to resolver, drop native targeting

**Files:**
- Modify: `frontend/src/static/extensions.js:314-447`

**Context:** `buildAiContext` currently both *reads* (traverses to find the target) and *mutates* (wraps in `blockRef`). The mint moves entirely to SEND-time `applyTargetHighlight` (Task 9). `buildAiContext` becomes a pure mapping from the resolved target to the `{blockRef, contextLabel}` job payload.

- [ ] **Step 1: Replace the body of `buildAiContext`**

Replace `extensions.js:314-447` (the whole `function buildAiContext(...) { ... }`) with:
```js
  function buildAiContext(editor, isMarkdownMode, rawMd, uuid) {
    var t = T.resolveAiTarget(editor, isMarkdownMode)

    if (t.kind === 'document') return { blockRef: 'doc', contextLabel: 'Document' }
    if (t.kind === 'selection') return { blockRef: t.blockRef || 'doc', contextLabel: t.label }

    // sieveBlock / anchor → reference the existing id (no mutation).
    var n = t.node
    if (n && (n.type.name === 'aiBlock' || n.type.name === 'sieve-ai-block')) {
      // Follow-up: chain this AI block onto its own ref so Go assembles history.
      var aiBlockId = n.attrs.id || ''
      var aiBlockRef = n.attrs.ref || ''
      var newRef = aiBlockRef && aiBlockRef !== 'doc' ? aiBlockRef + ',' + aiBlockId : aiBlockId
      return { blockRef: newRef, contextLabel: 'Follow-up' }
    }
    return { blockRef: t.id || 'doc', contextLabel: t.label }
  }
```

Notes for the implementer:
- For `kind === 'selection'`, `buildAiContext` no longer mints. At SEND the caller mints first (Task 9), so by the time this runs the selection resolves to an `anchor` and we take the `t.id` path. The `selection` branch here is the fallback when no mint happened (e.g. markdown mode) → `blockRef: 'doc'`.
- The native `codeBlock`/`table` `setNodeMarkup`/`wrap` branches are deleted with the old body — that scope is dropped (Convert-to-Smart is the on-ramp).

- [ ] **Step 2: Verify `buildAiContext` no longer mutates**

Run: `cd frontend && grep -n "tr\.\|dispatch\|setNodeMarkup\|\.wrap(" src/static/extensions.js | sed -n '1,40p'`
Expected: no `dispatch`/`wrap`/`setNodeMarkup` inside `buildAiContext` (lines around the function). Other functions (e.g. `applyTargetHighlight`) may still contain them — that is correct.

- [ ] **Step 3: Go/JS load sanity**

Run: `cd frontend && node --check src/static/extensions.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/extensions.js
git commit -m "refactor: buildAiContext is read-only, delegates to resolveAiTarget, drops native targeting"
```

---

## Task 6: `getAiTargetLabel` → thin delegate to the resolver

**Files:**
- Modify: `frontend/src/static/extensions.js` (the `getAiTargetLabel` function, ~lines 449-547, and its `T.getAiTargetLabel` export)

**Context:** `getAiTargetLabel` is the read-only label tracker the live panel calls (editor.js:792). It currently duplicates the resolver traversal. Collapse it to a one-liner so there is a single traversal.

- [ ] **Step 1: Replace `getAiTargetLabel` with a delegate**

Replace the entire `function getAiTargetLabel(editor, isMarkdownMode) { ... }` block in `extensions.js` with:
```js
  // Read-only label for the live Ask panel. Single source: resolveAiTarget.
  function getAiTargetLabel(editor, isMarkdownMode) {
    return T.resolveAiTarget(editor, isMarkdownMode).label
  }
```
Leave the existing `T.getAiTargetLabel = getAiTargetLabel` export in place (extensions.js:652 area).

- [ ] **Step 2: Confirm the duplicated traversal is gone**

Run: `cd frontend && grep -c "function labelFor" src/static/extensions.js`
Expected: `0` (both copies removed — one with `buildAiContext`'s old body in Task 5, one here).

- [ ] **Step 3: JS load sanity**

Run: `cd frontend && node --check src/static/extensions.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/extensions.js
git commit -m "refactor: getAiTargetLabel delegates to resolveAiTarget (kills duplicate traversal)"
```

---

## Task 7: Ephemeral glow decoration plugin

**Files:**
- Create: `frontend/src/static/ai-target-decoration.js`
- Modify: `frontend/src/static/editor.js:139` (extension list)
- Modify: `frontend/src/index.html:261` (script load)
- Modify: `frontend/src/static/editor.css` (glow styles)

- [ ] **Step 1: Create the plugin `frontend/src/static/ai-target-decoration.js`**

Modeled on `block-chrome.js`'s decoration approach (it already drives per-block visual state via `Decoration.node` classes).
```js
// ai-target-decoration.js — AiTargetDecoration extension.
// Ephemeral glow for the live Ask AI target. NOT a doc mutation: a single
// Decoration.node class driven by plugin state, set via meta. Cleared at SEND
// when the committed == highlight / blockRef takes over. Separate plugin from
// blockChrome on purpose: it must NOT be suppressed by block-chrome's
// has-selection rule (the target frequently IS the selection).
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'
  var T = window.TipTap
  var Extension = T.Extension
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey
  var Decoration = T.Decoration
  var DecorationSet = T.DecorationSet

  var aiTargetKey = new PluginKey('aiTarget')

  var AiTargetDecoration = Extension.create({
    name: 'aiTargetDecoration',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: aiTargetKey,
          state: {
            init: function () { return { range: null } },
            apply: function (tr, prev) {
              var meta = tr.getMeta(aiTargetKey)
              if (meta && Object.prototype.hasOwnProperty.call(meta, 'range')) {
                return { range: meta.range }
              }
              if (prev.range && tr.docChanged) {
                // keep the glow valid across edits
                try {
                  return { range: { from: tr.mapping.map(prev.range.from), to: tr.mapping.map(prev.range.to) } }
                } catch (e) { return { range: null } }
              }
              return prev
            },
          },
          props: {
            decorations: function (state) {
              var ps = aiTargetKey.getState(state)
              if (!ps || !ps.range) return DecorationSet.empty
              var from = ps.range.from, to = ps.range.to
              if (to <= from) return DecorationSet.empty
              return DecorationSet.create(state.doc, [
                Decoration.node(from, to, { class: 'block-ai-target' }),
              ])
            },
          },
        }),
      ]
    },
  })

  // Imperative helpers used by editor.js.
  T.AiTargetDecoration = AiTargetDecoration
  T.setAiTargetGlow = function (view, range) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(aiTargetKey, { range: range || null }))
  }
  T.clearAiTargetGlow = function (view) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(aiTargetKey, { range: null }))
  }
})()
```

- [ ] **Step 2: Load the new scripts in `index.html`**

In `frontend/src/index.html`, after line 260 (`<script src="/static/extensions.js"></script>`), add:
```html
    <script src="/static/ai-target.js"></script>
```
After line 261 (`<script src="/static/block-chrome.js"></script>`), add:
```html
    <script src="/static/ai-target-decoration.js"></script>
```

- [ ] **Step 3: Register the extension in the editor**

In `frontend/src/static/editor.js:139`, immediately after `T.BlockChrome,` add:
```js
        T.AiTargetDecoration,
```

- [ ] **Step 4: Add glow CSS**

In `frontend/src/static/editor.css`, add (extend the chrome rail/gutter vocabulary — adjust the accent variable to match the existing rail colour used by `.block-chrome-rail`):
```css
/* Ephemeral AI-target glow — same gutter/rail language as block chrome,
   visually distinct from a text selection. Not a committed highlight. */
.tiptap .block-ai-target {
  position: relative;
  border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(99, 102, 241, 0.25);
  background: rgba(99, 102, 241, 0.05);
  transition: box-shadow 120ms ease, background 120ms ease;
}
.tiptap .block-ai-target > .block-chrome-host .block-chrome-rail {
  background: rgba(99, 102, 241, 0.8);
}
```

- [ ] **Step 5: Manual verification (glow renders + follows caret)**

Run: `wails dev`. Then:
1. Open the Ask panel (`Ctrl+Shift+A`).
2. In the browser devtools console, manually drive the glow to confirm wiring:
   `window.TipTap.setAiTargetGlow(window.__tiptap.view, { from: 1, to: window.__tiptap.state.doc.firstChild.nodeSize + 1 })`
   Expected: the first block shows the glow outline + rail accent.
3. `window.TipTap.clearAiTargetGlow(window.__tiptap.view)` → glow disappears.

(Automatic caret-following is wired in Task 8.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/ai-target-decoration.js frontend/src/index.html frontend/src/static/editor.js frontend/src/static/editor.css
git commit -m "feat: AiTargetDecoration glow plugin (ephemeral, decoration-driven)"
```

---

## Task 8: Wire the live glow + precomputed-pin guard in editor.js

**Files:**
- Modify: `frontend/src/static/editor.js:785-815` (`updateAskPanelLabelLive`, `openAskPopup`)

- [ ] **Step 1: Glow + label together, guarded by pin**

Replace `updateAskPanelLabelLive` (editor.js:785-795) with:
```js
  function updateAskPanelLabelLive(editor) {
    if (!askDialog) return
    if (!askDialog.classList.contains('is-open')) return
    // A pinned explicit target (right-click / sieve block) overrides ambient.
    if (pendingAskCtx) return
    if (askLabelTimeout) clearTimeout(askLabelTimeout)
    askLabelTimeout = setTimeout(function () {
      if (pendingAskCtx) return
      var t = window.TipTap.resolveAiTarget(editor, currentMode === 'markdown')
      var label = askDialog.querySelector('.ask-popup__label')
      label.textContent = t.label === 'Follow-up' ? 'Ask Follow-up' : 'Ask About ' + t.label
      if (currentMode !== 'markdown') window.TipTap.setAiTargetGlow(editor.view, t.range)
    }, 100)
  }
```

- [ ] **Step 2: Clear the glow when the panel closes/opens with an explicit target**

In `openAskPopup` (editor.js:797-815), after `pendingAskCtx = precomputedCtx || null` add a glow refresh for the pinned case:
```js
    pendingAskCtx = precomputedCtx || null
    askDialog.classList.add('is-open')
    if (pendingAskCtx && pendingAskCtx.range && currentEditor) {
      window.TipTap.setAiTargetGlow(currentEditor.view, pendingAskCtx.range)
    } else if (currentEditor) {
      updateAskPanelLabelLive(currentEditor)
    }
```
(Replace the existing `if (currentEditor) updateAskPanelLabelLive(currentEditor)` line.)

- [ ] **Step 3: Manual verification (ambient glow follows the caret)**

Run: `wails dev`. Then:
1. Type a few paragraphs and insert a Smart Code block.
2. `Ctrl+Shift+A` to open the panel; click back into the document.
3. Move the caret between a paragraph, a text selection, and the code block.
   Expected: label cycles "Ask About Document" → `Ask About "<word>"` → "Ask About Code Block"; the glow jumps to the targeted block each time; **no undo step is created** (press `Ctrl+Z` — nothing about the glow should be undone).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat: live ambient glow + label, pinned-target override guard"
```

---

## Task 9: Focus toggle, return-selection, and SEND-time mint

**Files:**
- Modify: `frontend/src/static/editor.js` — module state, `openAskPopup` (797), `createAskDialog` closePanel (770), `doAsk` (1049), and the `sieve:ai-ask` handler (1434)

- [ ] **Step 1: Add `returnSelection` module state**

Near the Ask panel state (editor.js:750-752), add:
```js
  var returnSelection = null   // editor selection captured on jump-in to the Ask box
```

- [ ] **Step 2: Capture on jump-in, toggle out on repeat**

Replace the early-return toggle block in `openAskPopup` (editor.js:800-806) with:
```js
    // Toggle: if the box already has focus, jump back to the editor (focus axis
    // only — pin/visibility is independent).
    if (askDialog.classList.contains('is-open') && document.activeElement === textarea) {
      returnToEditor()
      return
    }
    // Jump IN: remember where we were so we can restore the caret exactly.
    if (currentEditor) returnSelection = currentEditor.state.selection
```

- [ ] **Step 3: Add `returnToEditor` helper**

Immediately above `function doAsk` (editor.js:1049), add:
```js
  // Jump back to the editor, restoring the caret to where we were when we entered
  // the Ask box. Focus and panel visibility are independent: only hide if unpinned.
  function returnToEditor() {
    if (!isAskPanelPinned && askDialog) askDialog.classList.remove('is-open')
    if (currentEditor) {
      if (returnSelection) {
        try {
          currentEditor.view.focus()
          currentEditor.view.dispatch(currentEditor.state.tr.setSelection(returnSelection))
        } catch (e) { currentEditor.view.focus() }
      } else {
        currentEditor.view.focus()
      }
    }
  }
```

- [ ] **Step 4: Use it from `closePanel` (Escape)**

In `createAskDialog`, replace `closePanel` (editor.js:770-773) with:
```js
    function closePanel() { returnToEditor() }
```

- [ ] **Step 5: SEND mints only for `selection`, then returns the caret**

Replace `doAsk` (editor.js:1049-1059) with:
```js
  function doAsk(textarea, panel) {
    var val = textarea.value.trim()
    if (!val) return

    var ctx
    if (pendingAskCtx) {
      ctx = pendingAskCtx
    } else {
      // Resolve once at SEND. Mint an anchor ONLY for a live selection — the one
      // mutating case. applyTargetHighlight wraps in blockRef + applies ==.
      var t = window.TipTap.resolveAiTarget(currentEditor, currentMode === 'markdown')
      if (t.kind === 'selection' && currentMode !== 'markdown') {
        window.TipTap.applyTargetHighlight(currentEditor)
      }
      ctx = window.TipTap.buildAiContext(currentEditor, currentMode === 'markdown', lastSyncedBody, currentUuid)
    }

    runAiJob('ask', val, ctx)
    pendingAskCtx = null
    textarea.value = ''
    if (currentEditor) window.TipTap.clearAiTargetGlow(currentEditor.view)
    if (!isAskPanelPinned) panel.classList.remove('is-open')
    // Return focus to the editor. For the selection-mint case the caret already
    // sits in the freshly-minted anchor (applyTargetHighlight preserves it); for
    // non-mutating kinds, restore the captured selection.
    if (currentEditor) {
      currentEditor.view.focus()
      if (returnSelection && pendingAskCtx === null) {
        try { currentEditor.view.dispatch(currentEditor.state.tr.setSelection(returnSelection)) } catch (e) {}
      }
    }
    returnSelection = null
  }
```
Implementer note: for the `selection`-mint case, `returnSelection` was captured *before* the wrap, so its positions are stale after minting. We intentionally do NOT restore it there — `applyTargetHighlight` leaves the caret on the minted text, which is "where we were." The `setSelection(returnSelection)` only runs for non-mutating kinds (verified in Step 7).

- [ ] **Step 6: Stop the ASK seam from minting at open**

The `sieve:ai-ask` handler currently mints at open via `aiPrepareTarget` → `applyTargetHighlight` (editor.js:1416-1427, 1434-1439). The mint must happen at SEND now. In the `sieve:ai-ask` handler (editor.js:1434), bypass the highlight prep but keep markdown-abort and overlay setup:
```js
  document.addEventListener('sieve:ai-ask', function (e) {
    var ctx = e && e.detail && e.detail.precomputedCtx
    if (currentMode === 'markdown' && !ctx) {
      // markdown mode: still allow asking about the whole doc / selection
    }
    ensureOverlays()
    openAskPopup(ctx)
  })
```
Leave the `sieve:ai-explain` handler and `aiPrepareTarget` unchanged — Explain is a one-shot and still mints at action time.

- [ ] **Step 7: Manual verification (focus round-trip + send)**

Run: `wails dev`. Then:
1. Place the caret mid-word in a paragraph. `Ctrl+Shift+A` → focus jumps to the Ask box, label "Ask About Document". `Ctrl+Shift+A` again → caret returns to the **exact** mid-word position.
2. Select a word → `Ctrl+Shift+A` → label `Ask About "<word>"`, glow on the block. Type a question, press Enter (SEND).
   Expected: a `blockRef` + `==` highlight is minted around the word (visible highlight), the glow clears, an AI job runs, focus returns to the editor.
3. Caret inside a Smart Code block → `Ctrl+Shift+A` → "Ask About Code Block" → SEND.
   Expected: **no new highlight minted** (it referenced the block id); job runs; `Ctrl+Z` does not reveal a stray wrap.
4. Pin the panel (existing meta-style toggle). `Ctrl+Shift+A` out → panel stays visible, caret returns to editor, ambient tracking resumes.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat: Ctrl+Shift+A focus toggle, return-selection, SEND-time mint"
```

---

## Task 10: Full integration verification + build

**Files:** none (verification only)

- [ ] **Step 1: Unit tests green**

Run: `cd frontend && npm test`
Expected: all `test/*.test.js` PASS.

- [ ] **Step 2: Go build (embeds compile)**

Run: `go build ./...`
Expected: no errors.

- [ ] **Step 3: End-to-end manual pass in `wails dev`**

Verify the full spec behaviour against §8 of the spec:
- Native code block caret → "Ask About Document", no error.
- Right-click a Sieve block → "Ask AI" → label/glow reflect that block (explicit pin), ambient paused.
- Markdown mode → only Selection/Document; no glow.
- Anchor already highlighted, re-ask → references existing id, no second mint.
- Move caret while panel open → glow + label follow live; no undo entries created.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "fix: ambient Ask AI verification fixups"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** §3 taxonomy → Tasks 2–3; §4.1 resolver → Task 2; §4.2 labels → Tasks 3–4; §4.3 glow plugin → Task 7; §4.4 SEND mint → Tasks 5,9; §4.5 focus toggle → Task 9; §6 invariants → no-mutation asserted in Task 2 Step 1 + manual `Ctrl+Z` checks; §7 file changes → File Structure table.
- **Dropped scope (native code/table targeting):** removed in Task 5; fallback asserted in Task 2 ("native code block → document") and Task 10.
- **Type consistency:** `resolveAiTarget` returns `{ kind, id?, range?, label, node? }` everywhere; glow helpers are `T.setAiTargetGlow(view, range)` / `T.clearAiTargetGlow(view)`; label seam is `T.getSieveBlockLabel(node)`. These names are used identically across Tasks 2–9.
- **Known v1 simplification:** anchor label uses the blockRef's text (truncated), not the precise highlighted word — acceptable; refine later if needed.
