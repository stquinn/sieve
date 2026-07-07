# Block Cursor Affordance (B + A) Implementation Plan

> **STATUS: DONE** — shipped; trailingNode:true + caretStop/insertParagraphAfter live (commit f48e4fe). Archived 2026-07-07.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the caret behave naturally around Sieve blocks — you can always type past the last block, and pressing Enter on/in a non-text-editable Sieve block creates a paragraph after it.

**Architecture:** Two complementary changes. **(A)** Re-enable a trailing-paragraph guarantee so the document always ends in a typeable paragraph. **(B)** One uniform "Enter escapes the block" mechanism: a `textEditable` capability flag on each Sieve block kind plus a single high-priority Enter keymap that, when the caret is inside a *non-text-editable* Sieve block (ai-block / web-clip / log) or a Sieve block is selected as a whole, inserts a paragraph after the block and moves the caret there. The three blocks that currently silently swallow Enter have that ad-hoc handling retired in favour of the central keymap. Code and Diagram keep their native inner editing because they are flagged `textEditable` and own Enter inside their own content before the keymap defers to them.

**Intersection with existing tech debt (TECH-DEBT.md):**
- **B-B / D-r.7 (retired) — "answer blocks split the target paragraph".** Its fix introduced `T.blockInsertPos(state, isInline)` ([ai-target.js:187](../../../frontend/src/static/ai-target.js)) — the single "insert an additive block AFTER the enclosing top-level block, never split" position rule used by every AI-answer / create-block insert. The Enter-escape insert position is byte-identical to `blockInsertPos(state, false)`, so this plan **reuses `T.blockInsertPos`** rather than computing "after the block" a second time. Enter-escape and AI answers then share ONE notion of where a sibling block lands (per `feedback_prefer_uniform_patterns`).
- **B-A (backend-authoritative prose id, plan `2026-06-29-backend-authoritative-prose-id.md`) — `splitBlock` attr-copy trap + identity plugin.** No conflict; the two are disjoint by construction. This plan's Enter keymap returns `false` for prose (`blockToEscape` only fires for a NodeSelection on a sieve block or a caret inside a non-textEditable sieve block), so native `splitBlock` and B-A's attr-copy handling are never intercepted. The escape inserts a *fresh* `createAndFill()` paragraph (empty id/token, no attr copy), so it triggers neither the duplicate-id trap nor `splitBlock`. **Identity of that empty paragraph depends on which plan has landed:** pre-B-A the `mintActions` pass stamps a cosmetic `pr-…` id (never synced — `isPendingEmptyProse` blocks it); post-B-A the content-gated token plugin stamps **nothing** until the user types, so the escape paragraph (and the Task 1 trailing paragraph) are genuinely inert — no id, no token, no create-block, never persisted. Post-B-A is cleaner and de-risks Task 1's "Risk & fallback" persistence concern. This plan touches neither `prose-block.js` nor `block-sync.js`, so it is robust to B-A landing in either order; recommended order is **B-A first**.
- **E-1** (multi-node embed fragmentation) is unrelated (load-time fragmentation of a backend block).

**Tech Stack:** Vanilla JS, TipTap 3 / ProseMirror (pre-bundled as `window.TipTap`), vitest + happy-dom for pure-logic tests.

## Global Constraints

- **No loose/free functions** — behaviour attaches to the owning type/service. The pure decision helpers in this plan live in one focused module (`block-escape.js`) mirroring the existing `block-position.js`; they are the editor-wiring's pure core, the established pattern for testable editor logic.
- **No React / no JSX / no new heavy npm deps.** Vanilla JS only.
- **Backend is the document source of truth.** This change only adds a *native* paragraph (a prose block) via a tracked PM transaction and moves the caret. It never full-reloads (`softReloadContent`) and never serialises a block to markdown.
- **Prose is a block, never special-cased.** Native prose nodes (`paragraph`, `heading`, …, and `proseGroup`) are identified by `T.isNativeProseNodeName(name)` / the absence of a `sieve-` name prefix. The Enter keymap must treat them as native (split), never as "escape".
- **`user_intent` is user-owned** — not touched here.
- **Test pure JS logic with vitest** (`npm test` in `frontend/`). Full editor/NodeView behaviour is verified manually in the WebKitGTK app (`wails dev`) — the Playwright harness is a separate future spec.
- **wails dev rebuild gotcha:** `wails dev` only rebuilds on `.go` changes. After editing `/static/*.js`, the files are served live from disk, but a hard reload of the webview is needed to pick them up.

---

### Task 1: Re-enable the trailing-paragraph guarantee (A)

Restore "a new line at the end" so a document ending in a Sieve block always has a typeable paragraph after it. StarterKit v3 bundles `TrailingNode`; it is currently disabled (`trailingNode: false`). Re-enable it with explicit options: append a `paragraph` after any last node that is not already a paragraph.

**Files:**
- Modify: `frontend/src/static/editor.js:339-342`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new in code; behavioural guarantee that `editor.state.doc.lastChild.type.name === 'paragraph'` after any edit that would otherwise leave a non-paragraph last node.

- [ ] **Step 1: Replace the `trailingNode:false` disable with an explicit enable**

In `frontend/src/static/editor.js`, change the StarterKit configuration. Current code (lines 339-342):

```js
        // trailingNode:false — we let PM's native Gapcursor place a caret after a
        // trailing atom (structured) block; typing there creates a real native
        // paragraph (a new prose block). No fabricated trailing surface.
        T.StarterKit.configure({ document: false, link: false, codeBlock: false, trailingNode: false, history: { depth: 10000, newGroupDelay: 500 } }),
```

Replace with:

```js
        // trailingNode — GapCursor only renders next to ATOM/leaf nodes, so it does
        // NOT offer a caret after our non-atom read-only container blocks (ai-block,
        // web-clip). A trailing paragraph restores "always typeable past the last
        // block". notAfter:['paragraph'] means it only appends when the last node is
        // not already a paragraph, so prose docs are unaffected. The Enter-escape
        // keymap (block-escape.js) handles the mid-document case.
        T.StarterKit.configure({ document: false, link: false, codeBlock: false, trailingNode: { node: 'paragraph', notAfter: ['paragraph'] }, history: { depth: 10000, newGroupDelay: 500 } }),
```

- [ ] **Step 2: Compile-check the bundle is unaffected (no build step needed for /static JS)**

Run: `cd frontend && npm test`
Expected: PASS — existing suite is green (this is a config change to a runtime file, not imported by tests; this step just confirms no test references the old literal).

- [ ] **Step 3: Manual verification in the app**

Run: `wails dev`, hard-reload the webview. Open a document whose last block is a web-clip or ai-block (or paste/create one at the end).
Expected: there is an empty paragraph after the last block; clicking into it or pressing ↓ lands the caret there and you can type. A document ending in a paragraph shows no *extra* trailing paragraph (notAfter guard).
Also confirm: open the same doc a second time — it does NOT keep accreting blank trailing blocks, and opening it does not immediately mark it dirty/trigger a spurious save. (If it does, see "Risk & fallback" at the end of this plan.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): restore trailing paragraph after non-paragraph last node (A)"
```

---

### Task 2: Add a `textEditable` capability to the Sieve block factory (B)

The Enter-escape keymap must distinguish blocks whose contentDOM the user *edits as text* (code, diagram — Enter inserts a newline there) from read-only containers (ai-block, web-clip, log — Enter should escape). Add a `textEditable` flag, read by the factory into a name-keyed registry exposed as `T.isTextEditableBlock(nodeName)`. The flag is NOT a ProseMirror schema field — the factory reads it for the registry only and does not pass it to `Node.create`.

**Files:**
- Modify: `frontend/src/static/sieve-block-extension.js:166-168` (factory head) and `:861-863` (exports)
- Modify: `frontend/src/static/code-renderer.js:46-56` (nodeConfig)
- Modify: `frontend/src/static/diagram-renderer.js:338-348` (nodeConfig)
- Test: `frontend/test/text-editable-registry.test.js`

**Interfaces:**
- Produces: `window.TipTap.isTextEditableBlock(name: string) → boolean` — true for `'sieve-code'` and `'sieve-diagram'`, false for every other Sieve block name and for any non-Sieve name.

- [ ] **Step 1: Write the failing test**

Create `frontend/test/text-editable-registry.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest'

// The registry is populated as a side effect of registering renderers, which the
// factory does at import time against window.TipTap. We exercise the SAME public
// helper the keymap uses, driving it through a minimal fake renderer registration.
describe('isTextEditableBlock registry', () => {
  let T
  beforeAll(async () => {
    // Minimal window.TipTap stub the factory needs to build a node + register.
    const noop = () => {}
    const NodeStub = { create: (spec) => ({ name: spec.name, spec }) }
    T = {
      Node: NodeStub,
      mergeAttributes: (...a) => Object.assign({}, ...a),
      registerBlockKind: noop,
    }
    globalThis.window = { TipTap: T }
    await import('../src/static/sieve-block-extension.js')
    // Register two renderers: one text-editable, one not.
    T.registerSieveRenderer('code', { nodeConfig: { atom: false, content: 'text*', textEditable: true }, makeNodeView: noop })
    T.registerSieveRenderer('web-clip', { nodeConfig: { atom: false, content: 'block+' }, makeNodeView: noop })
  })

  it('returns true for a textEditable kind', () => {
    expect(T.isTextEditableBlock('sieve-code')).toBe(true)
  })

  it('returns false for a non-textEditable kind', () => {
    expect(T.isTextEditableBlock('sieve-web-clip')).toBe(false)
  })

  it('returns false for an unknown / native node name', () => {
    expect(T.isTextEditableBlock('paragraph')).toBe(false)
    expect(T.isTextEditableBlock('sieve-nope')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run test/text-editable-registry.test.js`
Expected: FAIL — `T.isTextEditableBlock is not a function`.

- [ ] **Step 3: Implement the registry in the factory**

In `frontend/src/static/sieve-block-extension.js`, just below the `DEFAULT_NODE_CONFIG` declaration (after line 162), add the registry object:

```js
  // textEditable kinds (code, diagram) edit their contentDOM as TEXT — Enter there
  // inserts a newline, owned by the kind's own plugin. Read-only containers
  // (ai-block, web-clip, log) are NOT textEditable: the Enter-escape keymap turns
  // Enter into "paragraph after the block" for them. Keyed by node NAME ('sieve-…').
  var textEditableNames = {}
```

Inside `createSieveNode`, right after `nodeName` is computed (after line 168 `var dataType = ...`), record the flag:

```js
    if (cfg.textEditable) textEditableNames[nodeName] = true
```

Add the export alongside the other `T.` exports (near line 863, after `T.getSieveNodes = getSieveNodes`):

```js
  T.isTextEditableBlock = function (name) { return !!textEditableNames[name] }
```

- [ ] **Step 4: Flag code and diagram as textEditable**

In `frontend/src/static/code-renderer.js`, nodeConfig (lines 46-56), add `textEditable: true`:

```js
    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false,
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      textEditable: true   // Enter inserts a newline in the code body (own plugin)
    },
```

In `frontend/src/static/diagram-renderer.js`, nodeConfig (lines 338-348), add `textEditable: true`:

```js
    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,  // reorder via custom gutter handle; native node-drag fights it (see sieve-block-extension.js DEFAULT_NODE_CONFIG)
      group: 'block',
      inline: false,
      content: 'text*',
      marks: '',
      code: true,
      defining: true,
      textEditable: true   // edit mode: Enter inserts a newline in the source (own plugin)
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run test/text-editable-registry.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/sieve-block-extension.js frontend/src/static/code-renderer.js frontend/src/static/diagram-renderer.js frontend/test/text-editable-registry.test.js
git commit -m "feat(block): add textEditable capability flag + isTextEditableBlock registry (B)"
```

---

### Task 3: Pure Enter-escape decision + transaction module (B)

The testable core: given a PM state and two predicates, decide whether Enter should escape a Sieve block, and build the transaction that inserts a paragraph after it and places the caret inside. Mirrors `block-position.js` (pure, schema-driven, vitest-tested).

**Files:**
- Create: `frontend/src/static/block-escape.js`
- Test: `frontend/test/block-escape.test.js`

**Interfaces:**
- Produces:
  - `blockToEscape(state, isSieveName, isTextEditable) → { pos: number, node: Node } | null` — the top-level Sieve block to escape after, or `null` to leave Enter to native handling. `isSieveName(name) → bool`, `isTextEditable(name) → bool` are injected. This is the GATE (decide *whether* + *which*); it does NOT compute the insert position.
  - `escapeParagraphTransaction(state, insertPos) → Transaction` — a tracked transaction inserting an empty paragraph at `insertPos` and selecting inside it. `insertPos` is supplied by the caller via the existing `T.blockInsertPos(state, false)` ([ai-target.js:187](../../../frontend/src/static/ai-target.js)) so Enter-escape and AI-answer inserts share ONE "after the top-level block, never split" rule. Kept pure (position injected) so the module needs no `window.TipTap`.

- [ ] **Step 1: Write the failing test**

Create `frontend/test/block-escape.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'
import { blockToEscape, escapeParagraphTransaction } from '../src/static/block-escape.js'

// Schema: native paragraph (block) + two sieve kinds — a read-only container
// (sieve-web-clip: block+, not textEditable) and an editable leaf
// (sieve-code: text*, textEditable).
const schema = new Schema({
  nodes: {
    doc: { content: '(block | sieveBlock)+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    'sieve-web-clip': {
      group: 'sieveBlock',
      content: 'block+',
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-web-clip' }, 0],
    },
    'sieve-code': {
      group: 'sieveBlock',
      content: 'text*',
      code: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['pre', ['code', 0]],
    },
    'sieve-image': {
      group: 'sieveBlock',
      atom: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-image' }],
    },
    text: { group: 'inline' },
  },
})
const n = schema.nodes
const isSieveName = (name) => name.indexOf('sieve-') === 0
const isTextEditable = (name) => name === 'sieve-code'

function p(t) { return t ? n.paragraph.create(null, schema.text(t)) : n.paragraph.create() }
function webclip() { return n['sieve-web-clip'].create({ id: 'wc-1' }, p('clip body')) }
function code() { return n['sieve-code'].create({ id: 'co-1' }, schema.text('x = 1')) }
function image() { return n['sieve-image'].create({ id: 'im-1' }) }

function stateWith(doc, makeSel) {
  return EditorState.create({ schema, doc, selection: makeSel(doc) })
}
// caret just inside the first child's content
const caretInFirst = (doc) => TextSelection.create(doc, 2)
// whole-node selection on the first child
const nodeSelFirst = (doc) => NodeSelection.create(doc, 0)

describe('blockToEscape', () => {
  it('escapes when caret is inside a non-textEditable container (web-clip)', () => {
    const doc = n.doc.create(null, [webclip()])
    const target = blockToEscape(stateWith(doc, caretInFirst), isSieveName, isTextEditable)
    expect(target).not.toBeNull()
    expect(target.node.type.name).toBe('sieve-web-clip')
    expect(target.pos).toBe(0)
  })

  it('does NOT escape when caret is inside a textEditable block (code) — native newline', () => {
    const doc = n.doc.create(null, [code()])
    const target = blockToEscape(stateWith(doc, caretInFirst), isSieveName, isTextEditable)
    expect(target).toBeNull()
  })

  it('escapes when a textEditable block is selected as a whole (NodeSelection)', () => {
    const doc = n.doc.create(null, [code()])
    const target = blockToEscape(stateWith(doc, nodeSelFirst), isSieveName, isTextEditable)
    expect(target).not.toBeNull()
    expect(target.node.type.name).toBe('sieve-code')
  })

  it('escapes when an atom sieve block is selected (image)', () => {
    const doc = n.doc.create(null, [image()])
    const target = blockToEscape(stateWith(doc, nodeSelFirst), isSieveName, isTextEditable)
    expect(target).not.toBeNull()
    expect(target.node.type.name).toBe('sieve-image')
  })

  it('returns null when caret is in a native paragraph (split natively)', () => {
    const doc = n.doc.create(null, [p('hello')])
    const target = blockToEscape(stateWith(doc, caretInFirst), isSieveName, isTextEditable)
    expect(target).toBeNull()
  })

  it('returns null for a non-collapsed range selection that is not a whole node', () => {
    const doc = n.doc.create(null, [webclip()])
    const sel = (d) => TextSelection.create(d, 2, 6) // a range inside the clip body
    const target = blockToEscape(stateWith(doc, sel), isSieveName, isTextEditable)
    expect(target).toBeNull()
  })
})

describe('escapeParagraphTransaction', () => {
  it('inserts a paragraph at insertPos and selects inside it', () => {
    const doc = n.doc.create(null, [webclip()])
    const state = stateWith(doc, caretInFirst)
    const target = blockToEscape(state, isSieveName, isTextEditable)
    // insertPos is what T.blockInsertPos(state,false) yields = after the top-level
    // block. For a single web-clip that is target.pos + target.node.nodeSize.
    const insertPos = target.pos + target.node.nodeSize
    const tr = escapeParagraphTransaction(state, insertPos)
    // web-clip is child 0; the new paragraph is now child 1
    expect(tr.doc.childCount).toBe(2)
    expect(tr.doc.child(1).type.name).toBe('paragraph')
    expect(tr.doc.child(1).childCount).toBe(0) // empty
    // caret is inside the new paragraph
    expect(tr.selection.from).toBe(insertPos + 1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run test/block-escape.test.js`
Expected: FAIL — cannot resolve `../src/static/block-escape.js`.

- [ ] **Step 3: Implement the pure module**

Create `frontend/src/static/block-escape.js`:

```js
// block-escape.js — the pure core of "Enter escapes a Sieve block".
//
// GapCursor only renders next to ATOM/leaf nodes, so it never offers a caret
// after our non-atom read-only container blocks (ai-block, web-clip). And those
// blocks (plus log) swallow Enter inside their read-only content. The fix: when
// Enter is pressed on/in a Sieve block that the user is NOT text-editing, insert a
// paragraph AFTER the block and move the caret there — Confluence-style.
//
// This module is pure (no window/TipTap). editor.js injects the two predicates
// (isSieveName, isTextEditable) and wires the result into a keymap. Mirrors the
// block-position.js pattern so it is unit-testable with a constructed PM schema.

import { TextSelection } from '@tiptap/pm/state'

// blockToEscape decides whether Enter should escape the current block.
// Returns { pos, node } for the TOP-LEVEL Sieve block to escape after, else null.
// Fires when:
//   (a) a Sieve block is selected as a whole (NodeSelection) — any kind, OR
//   (b) the caret is inside a top-level Sieve block that is NOT textEditable.
// Leaves Enter to native handling (returns null) for prose, for the caret inside a
// textEditable block (code/diagram own the newline), and for multi-position range
// selections that are not a whole-node selection.
export function blockToEscape(state, isSieveName, isTextEditable) {
  var sel = state.selection
  var isNodeSel = !!sel.node
  // Only a collapsed caret or a whole-node selection escapes; a text range is
  // left to native delete-and-split semantics.
  if (!sel.empty && !isNodeSel) return null

  var $from = sel.$from
  var topNode, topPos
  if ($from.depth === 0) {
    // NodeSelection: $from sits just before the selected top-level node.
    topNode = sel.node || $from.nodeAfter
    topPos = $from.pos
  } else {
    // Caret inside content: walk to the top-level (depth 1) ancestor.
    topNode = $from.node(1)
    topPos = $from.before(1)
  }

  if (!topNode || !isSieveName(topNode.type.name)) return null
  // Caret inside a textEditable block → native newline (its own plugin handles it).
  if (!isNodeSel && isTextEditable(topNode.type.name)) return null
  return { pos: topPos, node: topNode }
}

// escapeParagraphTransaction inserts an empty paragraph at insertPos and places the
// caret inside it. insertPos comes from the caller's T.blockInsertPos(state,false)
// — the SAME "after the top-level block, never split" rule AI answers use (B-B /
// D-r.7), so the two share one notion of where a sibling block lands. A tracked
// transaction (default addToHistory) so the escape is undoable. The backend stays
// the source of truth: this only adds a native prose block and moves the caret —
// no block is serialised, no full reload. It does NOT splitBlock, so it sidesteps
// the duplicate-id attr-copy trap. The new empty paragraph acquires identity the
// same way any typed paragraph does — via the prose identity plugin (prose-block.js):
// pre-B-A a cosmetic pr-… id (unsynced); post-B-A nothing until the user types
// (content-gated token). Either way it is never persisted while empty.
export function escapeParagraphTransaction(state, insertPos) {
  var tr = state.tr
  var para = state.schema.nodes.paragraph.createAndFill()
  tr.insert(insertPos, para)
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 1))
  tr.scrollIntoView()
  return tr
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run test/block-escape.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd frontend && npm test`
Expected: PASS — all existing tests still green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/block-escape.js frontend/test/block-escape.test.js
git commit -m "feat(block): pure Enter-escape decision + transaction (block-escape.js) (B)"
```

---

### Task 4: Wire the central Enter-escape keymap into the editor (B)

Register one TipTap extension whose Enter shortcut consults `blockToEscape`. Give it a high `priority` so its Enter runs before StarterKit's `splitBlock` and before list/table Enter; returning `false` when not applicable lets those native handlers run unchanged.

**Files:**
- Modify: `frontend/src/static/editor.js` (add an import + a `SieveBlockEscape` extension + place it in the extensions array)

**Interfaces:**
- Consumes: `blockToEscape`, `escapeParagraphTransaction` from `block-escape.js`; `T.isTextEditableBlock` from Task 2; `T.blockInsertPos` from `ai-target.js` (existing).
- Produces: a registered extension named `sieveBlockEscape`.

- [ ] **Step 1: Import the pure module at the top of editor.js**

At the top of `frontend/src/static/editor.js`, alongside the other ES-module imports (check the existing import block near the top of the file and add):

```js
import { blockToEscape, escapeParagraphTransaction } from './block-escape.js'
```

- [ ] **Step 2: Define the SieveBlockEscape extension**

Above the `new T.Editor({...})` call (before line 334), define the extension:

```js
    // Enter-escape: GapCursor only serves ATOM blocks, so non-atom read-only
    // containers (ai-block/web-clip/log) trap the caret. This single keymap turns
    // Enter into "paragraph after the block" for any selected Sieve block or a
    // caret inside a non-textEditable one. High priority so it precedes StarterKit
    // Enter; returns false otherwise, leaving prose/list/table/code Enter native.
    var isSieveName = function (name) { return !!name && name.indexOf('sieve-') === 0 }
    var SieveBlockEscape = T.Extension.create({
      name: 'sieveBlockEscape',
      priority: 1000,
      addKeyboardShortcuts: function () {
        var editor = this.editor
        return {
          Enter: function () {
            var state = editor.state
            var target = blockToEscape(state, isSieveName, T.isTextEditableBlock)
            if (!target) return false
            // Reuse the SAME "after the top-level block, never split" position rule
            // AI answers use (B-B / D-r.7) — one notion of where a sibling lands.
            var insertPos = T.blockInsertPos(state, false)
            editor.view.dispatch(escapeParagraphTransaction(state, insertPos))
            return true
          },
        }
      },
    })
```

- [ ] **Step 3: Add the extension to the editor's extensions array**

In the `extensions: [...]` array (lines 336-371), add `SieveBlockEscape` near the top, right after `T.BlockId` (line 338):

```js
        SieveDocument,
        T.BlockId,
        SieveBlockEscape,
```

- [ ] **Step 4: Manual verification in the app**

Run: `wails dev`, hard-reload the webview. Then exercise each block:
- Caret inside an **ai-block**: press Enter → a new empty paragraph appears after the block; caret lands in it. (Previously: nothing.)
- Caret inside a **web-clip**: press Enter → paragraph after the block. (Previously: nothing.)
- Caret inside a **log** block: press Enter → paragraph after the block.
- Inside a **code** block: press Enter → newline inserted IN the code (unchanged).
- Inside a **diagram** in edit mode: press Enter → newline in the source; Ctrl/Cmd+Enter still toggles render (unchanged).
- A **code/diagram** block selected as a whole (click its gutter handle / Esc to NodeSelection): Enter → paragraph after it.
- In ordinary **prose**: Enter splits the paragraph (unchanged); inside a **list**/**table**, Enter behaves natively (unchanged).
- **Undo** (Cmd/Ctrl+Z) after an escape removes the added paragraph.

Expected: all of the above hold.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): central Enter-escape keymap for Sieve blocks (B)"
```

---

### Task 5: Retire the ad-hoc Enter blockers in ai-block / web-clip / log (B)

The three read-only containers each return `true` from `handleKeyDown` for Enter, swallowing it. With Task 4 live, the high-priority keymap already intercepts Enter for them (it wins by priority), so these branches are now dead and duplicate the policy. Remove Enter from each condition, leaving Backspace/Delete (whole-block removal) and the single-character typing guard intact.

**Files:**
- Modify: `frontend/src/static/ai-block-renderer.js:225-229`
- Modify: `frontend/src/static/web-clip-renderer.js:252-260`
- Modify: `frontend/src/static/log-renderer.js:620-628`

**Interfaces:**
- Consumes: the keymap from Task 4 (which now owns Enter for these kinds).
- Produces: nothing new; removes dead handling.

- [ ] **Step 1: ai-block — drop the Enter branch**

In `frontend/src/static/ai-block-renderer.js`, the `handleKeyDown` (lines 219-233). Remove the Enter branch (lines 225-229):

```js
              // Enter and ordinary typing would replace/insert text — never allowed
              // when the selection touches an ai-block at all.
              if (event.key === 'Enter') {
                return isInsideAiBlock(view.state, view.state.selection.from, view.state.selection.to)
              }
```

So that the handler becomes:

```js
            handleKeyDown: function(view, event) {
              // Backspace/Delete: allowed to remove the whole block (undoable),
              // blocked only when they would edit the read-only response body.
              if (event.key === 'Backspace' || event.key === 'Delete') {
                return deleteEditsAiBody(view.state)
              }
              // Enter is owned by the central Enter-escape keymap (block-escape.js):
              // it inserts a paragraph AFTER the block. Do not swallow it here.
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInsideAiBlock(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
```

- [ ] **Step 2: web-clip — drop Enter from the key condition**

In `frontend/src/static/web-clip-renderer.js`, `handleKeyDown` (lines 252-260). Change the condition so Enter is no longer swallowed:

```js
            handleKeyDown: function(view, event) {
              // Enter is owned by the central Enter-escape keymap (block-escape.js).
              if (event.key === 'Backspace' || event.key === 'Delete') {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
```

- [ ] **Step 3: log — drop Enter from the key condition**

In `frontend/src/static/log-renderer.js`, `handleKeyDown` (lines 620-628). Change the condition so Enter is no longer swallowed:

```js
            handleKeyDown: function(view, event) {
              // Enter is owned by the central Enter-escape keymap (block-escape.js).
              if (event.key === 'Backspace' || event.key === 'Delete') {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInside(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
```

- [ ] **Step 4: Manual verification — read-only content is still protected**

Run: `wails dev`, hard-reload. For ai-block, web-clip, and log:
- Caret inside the block, type a letter → still blocked (read-only body unchanged).
- Caret inside the block, press Enter → paragraph created AFTER the block (the keymap), NOT a split of the read-only content.
- Select the whole block, Backspace/Delete → whole block removed (undoable), unchanged.

Expected: all hold; no Enter ever splits a read-only body.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/ai-block-renderer.js frontend/src/static/web-clip-renderer.js frontend/src/static/log-renderer.js
git commit -m "refactor(block): retire ad-hoc Enter blockers; central keymap owns Enter-escape (B)"
```

---

### Task 6: Document the affordance + note deferred D/E

Record the new behaviour and the deferred enhancements so the next contributor understands the design and the open follow-ups.

**Files:**
- Modify: `docs/TECH-DEBT.md` (or `docs/FEATURE-BACKLOG.md` if that is where forward-looking items live — match the existing convention in the file)

**Interfaces:** none.

- [ ] **Step 1: Add a backlog note for D and E**

Append an entry (match the surrounding format) noting that the block cursor affordance shipped **B + A** (trailing paragraph + Enter-escape keymap), and that two enhancements remain deferred:
- **D — click-below affordance:** clicking the empty area below the last block places a caret after it (largely covered by the trailing paragraph from A; only bottom-padding clicks remain).
- **E — arrow/Down/End navigation + gap-cursor-between-blocks rendering:** "natural caret before and after every block" for non-atom containers. The expensive, regression-prone half of full-Confluence feel; pursue only if arrow navigation still feels off after B+A.

- [ ] **Step 2: Commit**

```bash
git add docs/TECH-DEBT.md
git commit -m "docs: record block cursor affordance (B+A); note deferred D/E"
```

---

## Risk & fallback (Task 1 / A)

`TrailingNode` adds a **real** paragraph node to the document, so when a doc ends in a Sieve block it now persists an empty trailing prose block (a `<!--s:pr-…-->` marker pair around a blank line). This is intended ("a newline at the end") and should round-trip stably (reload → last node is already a paragraph → `notAfter:['paragraph']` makes the extension a no-op). 

**Post-B-A this risk largely evaporates:** once the backend-authoritative prose id plan lands, the identity plugin is content-gated, so an empty trailing paragraph acquires no token/id and is never emitted as a create-block — it cannot persist while empty. The only residual concern is the load-time `appendTransaction` flipping a dirty flag (independent of B-A); verify in Step 3.

If Task 1 Step 3 (run pre-B-A) reveals churn (the doc accretes blank trailing blocks on each open, or opening marks it dirty / triggers a spurious save), do NOT keep the broad StarterKit config. Instead replace Task 1 with a **scoped** custom trailing-node extension that appends a paragraph only when `doc.lastChild` is in the `sieveBlock` group (or is a non-`textEditable` atom), and that sets `addToHistory:false` + does not flip the dirty flag. This keeps prose-ending docs byte-identical on disk while still rescuing the trailing-block case. The pure escape logic (Tasks 2-5) is unaffected either way.

---

## Self-Review

**Spec coverage:**
- A (trailing paragraph) → Task 1. ✓
- B (textEditable flag) → Task 2. ✓
- B (pure escape logic) → Task 3. ✓
- B (keymap wiring) → Task 4. ✓
- B (retire ad-hoc blockers) → Task 5. ✓
- "Code/Diagram/Log keep working as editors" → Task 2 (flags), Task 4 Step 4 (manual), Task 5 Step 4 (manual). ✓
- D/E deferred and recorded → Task 6. ✓

**Type consistency:** `blockToEscape(state, isSieveName, isTextEditable)` and `escapeParagraphTransaction(state, insertPos)` signatures match across Task 3 (definition + tests) and Task 4 (call site). `T.isTextEditableBlock(name)` matches across Task 2 (definition/test) and Task 4 (use). `T.blockInsertPos(state, false)` is the existing helper (ai-target.js:187), called only at the Task 4 site. `isSieveName` defined identically in the Task 3 test and the Task 4 call site (`name.indexOf('sieve-') === 0`).

**Placeholder scan:** no TBD / "handle edge cases" / "similar to" — all code is concrete.
