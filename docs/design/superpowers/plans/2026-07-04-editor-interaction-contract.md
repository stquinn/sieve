# Editor Interaction Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared interaction-policy plugin (declared per-kind, applied uniformly) replacing scattered per-renderer key handlers; the six confirmed defects fixed as conformance; the caret contract (boundaries, trailing node, uniform escape) implemented; a normative contract doc that doubles as the regression checklist.

**Architecture:** Block renderers declare an `interactionPolicy` object; `getBlockBehaviour(kind)` (the existing all-blocks registry in `block-kinds.js`) exposes it uniformly — prose included. A new TipTap extension in `frontend/src/static/editor/interaction-policy.js` (LOW priority — defer-first, consume-last) resolves the caret's context to a policy and applies Tab/Shift+Tab/Enter/Mod+Enter/arrow behaviour. The root `editorProps` Tab branch and the per-renderer Tab/Enter handlers are deleted. Pure helpers (context classification, indent transforms, auto-indent, smart Home) are vitest-tested.

**Tech Stack:** Vanilla JS (ES modules), TipTap 3 / ProseMirror (window.TipTap bundle), vitest + happy-dom (existing `frontend/test/` setup), headless Chrome against `wails dev :34115` for UI verification.

**Spec:** `docs/design/superpowers/specs/2026-07-04-editor-interaction-contract-design.md`

## Global Constraints

- **No per-renderer `handleKeyDown` for Tab/Enter after this plan.** Key behaviour comes from declared policy + the shared plugin. (Renderer plugins may keep non-key concerns: decorations, paste guards.)
- **Defer first, consume last:** the policy extension registers with TipTap `priority: 50` (default is 100; lower runs later) so native keymaps — list indent, Table `goToNextCell` — always win. Never use `editorProps.handleKeyDown` for policy behaviour.
- **Uniform values:** indent width 2 in raw-text blocks; Tab/Shift+Tab consumed as no-ops in plain paragraphs; Enter never auto-escapes a raw-text block; Mod+Enter = insert-paragraph-after (diagram overrides Mod+Enter to mode-toggle via its policy — declared variance, one mechanism).
- **Backend is doc source of truth** rules unchanged — this plan touches only local editing transactions (typing-equivalent), never server-op render-backs. All transactions here are tracked (undo-safe).
- **JS style:** match existing files — `var`, function statements, ES-module exports guarded for browser+vitest use. No new npm deps.
- **`wails dev` gotcha:** `/static/` is live from disk; `index.html`/template changes need a `.go` touch.
- **WebKit check:** caret/perf behaviour must be spot-checked in the real WebKitGTK app, not only Chrome (`project_test_perf_in_wails_app`).
- Verification: `cd frontend && npx vitest run` for pure logic; headless Chrome (`~/.nix-profile/bin/google-chrome-stable`, CDP against :34115) for interaction smoke; contract-doc checklist for the full pass.
- **Commits:** conventional style, no Co-Authored-By trailer.

---

### Task 1: The normative contract document

**Files:**
- Create: `docs/editor-interaction-contract.md`

This document is the arbiter of "correct" for every later task and the manual regression checklist. Write it FIRST so conformance is checked against text, not memory.

- [ ] **Step 1: Write `docs/editor-interaction-contract.md`** with exactly this content (it encodes every spec decision; later tasks may append discovered rows but must not silently change existing ones):

```markdown
# Editor Interaction Contract

**Normative.** Any interaction change MUST update this document in the same
change. Each cell is a testable behaviour; ✅-mark cells during a manual
regression pass. Source spec:
`docs/design/superpowers/specs/2026-07-04-editor-interaction-contract-design.md`.

## Key matrix

"consume ∅" = event consumed, nothing happens, focus stays in the editor.
"native" = TipTap/ProseMirror default; Sieve does not interject.

| Context | Tab | Shift+Tab | Enter | Mod+Enter | ArrowDown at end | ArrowUp at start | Home |
|---|---|---|---|---|---|---|---|
| Plain paragraph | consume ∅ | consume ∅ | native (split para) | insert ¶ after block | native | native | native |
| List item | native (indent) | native (outdent) | native | insert ¶ after list | native | native | native |
| Table cell | native (next cell; last cell appends row — adopted TipTap default) | native (prev cell; consume ∅ in first cell) | native | insert ¶ after table | native | native | native |
| Code block | indent 2 (multi-line: indent each selected line) | de-indent ≤2 per line | newline + auto-indent (copy previous line's leading whitespace) | insert ¶ after block | exit to next block, content unchanged | exit to previous block | 1st press: first non-ws char; 2nd: column 0 |
| Diagram (edit) | indent 2 (as code) | de-indent ≤2 (as code) | newline + auto-indent | **toggle to render mode** (declared policy override; cursor position preserved) | exit to next block | exit to previous block | as code |
| Diagram (render) | consume ∅ | consume ∅ | insert ¶ after (block is a caret stop) | **toggle to edit mode** (works with block selected OR render body focused — one function, two entry points) | pass to next block | pass to previous block | n/a |
| Log block | consume ∅ | consume ∅ | consume ∅ (read-only text) | insert ¶ after block | exit to next block | exit to previous block | native |
| ai-block | consume ∅ | consume ∅ | insert ¶ after (caret stop) | insert ¶ after | pass | pass | n/a |
| web-clip | consume ∅ | consume ∅ | insert ¶ after (caret stop) | insert ¶ after | pass | pass | n/a |
| smart-image | consume ∅ | consume ∅ | insert ¶ after (caret stop) | insert ¶ after | pass | pass | n/a |

## Caret contract

1. No dead-ends: every position reachable by arrows alone; a trailing
   paragraph is guaranteed after a final structured block (trailing-node).
2. Entering an editable raw-text block from above: text caret on FIRST line,
   column preserved. From below: LAST line. Never a NodeSelection, never
   skipped.
3. Leaving a block never modifies its content (no phantom newlines).
4. Read-only blocks (web-clip, ai-block, diagram-render, smart-image) are a
   single caret stop: arrow onto → whole-block selection; arrow again → past
   it. Enter while selected inserts a paragraph after (this is how prose is
   added between two adjacent read-only blocks).
5. Click in a block body → text caret there; click on chrome (header/gutter)
   → block selection. Never silent nothing.
6. Typing always goes somewhere visible after entering a block.
7. Diagram edit↔render round-trip restores cursor position (block-start if
   content changed).

## Copy matrix

| Selection | Result |
|---|---|
| Partial text inside any block | plain text/HTML only — no sieve MIMEs (by design) |
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

## Deferred (recorded, not shipped)

- Bracket/quote auto-pairing in code blocks (`autoPair` policy flag) —
  deferred; must not fight PM input rules.
- Per-language indent width — uniform 2 until proven insufficient.
```

- [ ] **Step 2: Commit**

```bash
git add docs/editor-interaction-contract.md
git commit -m "docs: normative editor interaction contract (key/copy/paste matrices, caret contract)"
```

---

### Task 2: Pure core — policy table, context classifier, text transforms

**Files:**
- Create: `frontend/src/static/editor/interaction-policy.js`
- Test: `frontend/test/interaction-policy.test.js`

**Interfaces:**
- Produces (all exported, pure, no TipTap/DOM deps in this task):

```js
DEFAULT_POLICY                      // { rawText:false, indentWidth:0, enterInsertsNewline:false,
                                    //   autoIndentOnEnter:false, modEnterTogglesMode:false,
                                    //   readOnlyText:false, caretStop:false }
policyFor(kind)                     // merged DEFAULT_POLICY + getBlockBehaviour(kind).interactionPolicy
classifyContext(info)               // info: { parentTypeName, ancestorTypeNames, nodeSelectionTypeName, mode }
                                    // → { kind, policy, inList, inTable, isNodeSelection }
indentInsertions(text, from, to, w) // → [{pos, insert}] descending-pos space insertions per selected line
dedentDeletions(text, from, to, w)  // → [{from, to}] descending leading-space deletions (≤w per line)
leadingIndentAt(text, offset)       // → leading-whitespace string of the line containing offset
smartHomeTarget(lineText, col)      // → column to jump to (first non-ws, or 0 if already there)
```

- Consumes: `getBlockBehaviour` from `../block/block-kinds.js`.

- [ ] **Step 1: Write the failing tests** — `frontend/test/interaction-policy.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { registerBlockKind } from '../src/static/block/block-kinds.js'
import {
  DEFAULT_POLICY, policyFor, classifyContext,
  indentInsertions, dedentDeletions, leadingIndentAt, smartHomeTarget,
} from '../src/static/editor/interaction-policy.js'

describe('policyFor', () => {
  it('merges a declared policy over defaults', () => {
    registerBlockKind({ kind: 'test-raw', native: false, renderer: {
      interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true },
    }})
    const p = policyFor('test-raw')
    expect(p.rawText).toBe(true)
    expect(p.indentWidth).toBe(2)
    expect(p.caretStop).toBe(false) // default survives
  })
  it('unknown kind gets pure defaults', () => {
    expect(policyFor('nope')).toEqual(DEFAULT_POLICY)
  })
})

describe('classifyContext', () => {
  it('sieve-code parent → kind code', () => {
    const c = classifyContext({ parentTypeName: 'sieve-code', ancestorTypeNames: [] })
    expect(c.kind).toBe('code')
  })
  it('paragraph inside listItem → prose, inList', () => {
    const c = classifyContext({ parentTypeName: 'paragraph', ancestorTypeNames: ['bulletList', 'listItem'] })
    expect(c.kind).toBe('prose')
    expect(c.inList).toBe(true)
    expect(c.inTable).toBe(false)
  })
  it('paragraph inside tableCell → inTable', () => {
    const c = classifyContext({ parentTypeName: 'paragraph', ancestorTypeNames: ['table', 'tableRow', 'tableCell'] })
    expect(c.inTable).toBe(true)
  })
  it('node selection on sieve-web-clip → kind web-clip, isNodeSelection', () => {
    const c = classifyContext({ parentTypeName: 'doc', ancestorTypeNames: [], nodeSelectionTypeName: 'sieve-web-clip' })
    expect(c.kind).toBe('web-clip')
    expect(c.isNodeSelection).toBe(true)
  })
})

describe('indent transforms', () => {
  const text = 'aa\n  bb\ncc'
  it('indentInsertions covers every selected line, descending', () => {
    // selection spans all three lines
    const ins = indentInsertions(text, 0, text.length, 2)
    expect(ins).toEqual([{ pos: 8, insert: '  ' }, { pos: 3, insert: '  ' }, { pos: 0, insert: '  ' }])
  })
  it('single caret indents only its line', () => {
    expect(indentInsertions(text, 4, 4, 2)).toEqual([{ pos: 3, insert: '  ' }])
  })
  it('dedentDeletions removes at most w leading spaces per line', () => {
    const del = dedentDeletions(text, 0, text.length, 2)
    expect(del).toEqual([{ from: 3, to: 5 }]) // only line 2 has leading spaces
  })
})

describe('auto-indent + home', () => {
  it('leadingIndentAt copies the current line indent', () => {
    expect(leadingIndentAt('if x:\n    y = 1', 12)).toBe('    ')
    expect(leadingIndentAt('plain', 3)).toBe('')
  })
  it('smartHomeTarget toggles first-non-ws / 0', () => {
    expect(smartHomeTarget('    code', 8)).toBe(4)
    expect(smartHomeTarget('    code', 4)).toBe(0)
    expect(smartHomeTarget('nows', 2)).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify FAIL** — `cd frontend && npx vitest run test/interaction-policy.test.js` → FAIL (module missing).

- [ ] **Step 3: Write the pure core of `interaction-policy.js`**

```js
// interaction-policy.js — ONE shared mechanism for keyboard interaction.
// Renderers DECLARE an interactionPolicy; this module resolves the caret's
// context and applies the policy. Per-renderer key handlers are forbidden
// (docs/editor-interaction-contract.md is the normative behaviour spec).
//
// Layered: pure helpers (this section, vitest-tested) + the TipTap extension
// (browser-only, added by editor.js at priority 50 so native keymaps —
// list indent, table cell nav — always run first).

import { getBlockBehaviour } from '../block/block-kinds.js'

export var DEFAULT_POLICY = {
  rawText: false,            // literal paste target; Tab indents inside
  indentWidth: 0,            // spaces per Tab where rawText
  enterInsertsNewline: false,
  autoIndentOnEnter: false,
  modEnterTogglesMode: false, // diagram: Mod+Enter flips edit/render instead of escape
  readOnlyText: false,        // log: caret may enter text, typing is consumed
  caretStop: false,           // read-only block: arrows select it as one stop
}

export function policyFor(kind) {
  var beh = getBlockBehaviour(kind)
  var declared = (beh && beh.interactionPolicy) || {}
  var merged = {}
  for (var k in DEFAULT_POLICY) merged[k] = (k in declared) ? declared[k] : DEFAULT_POLICY[k]
  return merged
}

var LIST_TYPES = { listItem: 1, taskItem: 1 }
var TABLE_TYPES = { table: 1, tableRow: 1, tableCell: 1, tableHeader: 1 }

function kindFromTypeName(name) {
  if (!name) return 'prose'
  return name.indexOf('sieve-') === 0 ? name.slice('sieve-'.length) : 'prose'
}

// classifyContext is pure: the extension extracts names from PM state and
// passes them here so this decision table is unit-testable.
export function classifyContext(info) {
  var nodeSel = info.nodeSelectionTypeName || null
  var kind = kindFromTypeName(nodeSel || info.parentTypeName)
  var inList = false
  var inTable = false
  ;(info.ancestorTypeNames || []).forEach(function (n) {
    if (LIST_TYPES[n]) inList = true
    if (TABLE_TYPES[n]) inTable = true
  })
  return {
    kind: kind,
    policy: policyFor(kind),
    inList: inList,
    inTable: inTable,
    isNodeSelection: !!nodeSel,
    mode: info.mode || null, // diagram edit/render
  }
}

// ── raw-text transforms (pure; offsets are within the block's text) ─────────

function lineStartsInRange(text, from, to) {
  var starts = [0]
  for (var i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts.filter(function (s) {
    var end = text.indexOf('\n', s)
    if (end === -1) end = text.length
    return s <= to && end >= from
  })
}

export function indentInsertions(text, from, to, width) {
  var pad = new Array(width + 1).join(' ')
  return lineStartsInRange(text, from, to)
    .map(function (s) { return { pos: s, insert: pad } })
    .sort(function (a, b) { return b.pos - a.pos })
}

export function dedentDeletions(text, from, to, width) {
  var out = []
  lineStartsInRange(text, from, to).forEach(function (s) {
    var n = 0
    while (n < width && text[s + n] === ' ') n++
    if (n > 0) out.push({ from: s, to: s + n })
  })
  return out.sort(function (a, b) { return b.from - a.from })
}

export function leadingIndentAt(text, offset) {
  var start = text.lastIndexOf('\n', offset - 1) + 1
  var m = /^[ \t]*/.exec(text.slice(start, offset))
  // only whitespace BEFORE the caret on this line counts (caret mid-indent
  // copies what's left of it)
  return m ? m[0] : ''
}

export function smartHomeTarget(lineText, col) {
  var first = /^[ \t]*/.exec(lineText)[0].length
  return col === first ? 0 : first
}
```

- [ ] **Step 4: Run tests** — `cd frontend && npx vitest run test/interaction-policy.test.js` → PASS. Also `npx vitest run` (whole suite) → no regressions.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor/interaction-policy.js frontend/test/interaction-policy.test.js
git commit -m "feat(editor): interaction-policy pure core — policy table, context classifier, indent transforms"
```

---

### Task 3: Policy declarations on renderers + prose

**Files:**
- Modify: `frontend/src/static/processors/code-renderer.js`, `frontend/src/static/processors/diagram-renderer.js`, `frontend/src/static/processors/log-renderer.js`, `frontend/src/static/processors/ai-block-renderer.js`, `frontend/src/static/processors/web-clip-renderer.js`, `frontend/src/static/processors/smart-image-renderer.js`
- Modify: wherever the prose kind is registered (`grep -rn "registerBlockKind" frontend/src/static/ | grep -v block-kinds` — expected `prose-block.js`)
- Test: append to `frontend/test/interaction-policy.test.js`

- [ ] **Step 1: Declare policies** (add one property to each renderer object, next to `nodeConfig`):

```js
// code-renderer.js
interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true },

// diagram-renderer.js
interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true, modEnterTogglesMode: true, caretStop: 'render' },

// log-renderer.js
interactionPolicy: { readOnlyText: true },

// ai-block-renderer.js / web-clip-renderer.js / smart-image-renderer.js
interactionPolicy: { caretStop: true },
```

`caretStop: 'render'` on diagram means "a stop only in render mode" — `policyFor` passes the value through; the extension treats truthy-with-`'render'` as conditional on `node.attrs.mode === 'render'`. Prose declares nothing (defaults are exactly prose's contract).

- [ ] **Step 2: Append a registration test** (uses the REAL renderer files where importable; structured renderers self-register on import via `T.registerSieveRenderer`, which needs `window.TipTap` — if importing a renderer in vitest is heavy, register a minimal stand-in with the same policy object and note it):

```js
describe('declared policies', () => {
  it('code is raw text width 2', () => {
    registerBlockKind({ kind: 'code', native: false, renderer: {
      interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true },
    }})
    const p = policyFor('code')
    expect(p.rawText).toBe(true)
    expect(p.indentWidth).toBe(2)
  })
})
```

- [ ] **Step 3: Run + commit**

```bash
cd frontend && npx vitest run
git add frontend/src/static/processors/ frontend/test/interaction-policy.test.js
git commit -m "feat(editor): renderers declare interactionPolicy (code/diagram raw-text, log read-only, containers caret-stop)"
```

(Include the prose registration file if it needed a touch.)

---

### Task 4: The extension — Tab/Shift+Tab conformance (kills defects 1, 2, 6)

**Files:**
- Modify: `frontend/src/static/editor/interaction-policy.js` (append extension), `frontend/src/static/editor/editor.js` (add extension; DELETE root Tab branch), `frontend/src/static/processors/code-renderer.js` + `diagram-renderer.js` (DELETE their Tab branches)
- Modify: `frontend/src/index.html` if interaction-policy.js needs a module script tag (check how block-kinds.js is loaded — follow the same pattern)

**Interfaces:**
- Produces: `buildInteractionPolicyExtension(T)` → TipTap Extension (priority 50) exported from interaction-policy.js; also `resolveContext(state)` (state → classifyContext info extraction, browser layer).

- [ ] **Step 1: Append the extension layer to `interaction-policy.js`**

```js
// ── browser layer: PM state → classified context, and the TipTap extension ──

export function resolveContext(state) {
  var sel = state.selection
  var nodeSelName = sel.node ? sel.node.type.name : null
  var $from = sel.$from
  var ancestors = []
  for (var d = $from.depth; d >= 0; d--) ancestors.push($from.node(d).type.name)
  var parent = $from.parent
  return classifyContext({
    parentTypeName: parent.type.name,
    ancestorTypeNames: ancestors,
    nodeSelectionTypeName: nodeSelName,
    mode: (sel.node ? sel.node.attrs && sel.node.attrs.mode : parent.attrs && parent.attrs.mode) || null,
  })
}

// Block-local text + offsets for raw-text transforms.
function rawTextSpan(state) {
  var $from = state.selection.$from
  var $to = state.selection.$to
  var blockStart = $from.start()
  return {
    text: $from.parent.textContent,
    from: $from.pos - blockStart,
    to: $to.pos - blockStart,
    blockStart: blockStart,
  }
}

function applyIndent(view) {
  var s = rawTextSpan(view.state)
  var ctx = resolveContext(view.state)
  var tr = view.state.tr
  indentInsertions(s.text, s.from, s.to, ctx.policy.indentWidth).forEach(function (ins) {
    tr.insertText(ins.insert, s.blockStart + ins.pos)
  })
  view.dispatch(tr.scrollIntoView())
  return true
}

function applyDedent(view) {
  var s = rawTextSpan(view.state)
  var ctx = resolveContext(view.state)
  var tr = view.state.tr
  var dels = dedentDeletions(s.text, s.from, s.to, ctx.policy.indentWidth)
  if (!dels.length) return true // consumed: nothing to dedent, but never escape
  dels.forEach(function (d) { tr.delete(s.blockStart + d.from, s.blockStart + d.to) })
  view.dispatch(tr.scrollIntoView())
  return true
}

export function buildInteractionPolicyExtension(T) {
  return T.Extension.create({
    name: 'sieveInteractionPolicy',
    // Lower than default 100: native keymaps (list indent/outdent, table
    // goToNextCell/PreviousCell) run FIRST. We are the backstop, never a shadow.
    priority: 50,
    addProseMirrorPlugins: function () {
      return [
        new T.Plugin({
          props: {
            handleKeyDown: function (view, event) {
              if (event.key !== 'Tab') return false
              if (event.metaKey || event.ctrlKey || event.altKey) return false
              var ctx = resolveContext(view.state)
              // Native structural contexts already ran (priority order) and
              // returned false if they didn't want it — from here we own it.
              if (ctx.inList || ctx.inTable) {
                // e.g. Shift+Tab in first cell: consume so focus never escapes.
                event.preventDefault()
                return true
              }
              if (ctx.policy.rawText && !ctx.isNodeSelection && ctx.mode !== 'render') {
                event.preventDefault()
                return event.shiftKey ? applyDedent(view) : applyIndent(view)
              }
              // Plain paragraph / read-only / caret-stop: consume ∅.
              event.preventDefault()
              return true
            },
          },
        }),
      ]
    },
  })
}
```

- [ ] **Step 2: Wire into editor.js and DELETE the old branches**

1. editor.js: import at top is not possible (classic IIFE) — follow the block-kinds pattern: interaction-policy.js already sets nothing on window; add at its bottom:

```js
if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.buildInteractionPolicyExtension = buildInteractionPolicyExtension
  window.TipTap.resolveInteractionContext = resolveContext
}
```

2. `frontend/src/index.html`: add `<script type="module" src="/static/editor/interaction-policy.js"></script>` alongside the other module tags (before editor.js usage at runtime — safe, same as block-kinds). Touch a `.go` file for wails dev.
3. editor.js extensions array (near `T.Table.configure` ~line 351): add `T.buildInteractionPolicyExtension(T),`
4. editor.js `handleKeyDown` (~line 534): **DELETE the whole `if (event.key === 'Tab' …)` branch** (lines 534–540). Mod-s / Mod-Shift-W / Mod-Shift-L stay.
5. code-renderer.js `handleKeyDown` (~line 279): **DELETE the Tab branch** (keep Enter for now — Task 5 moves it).
6. diagram-renderer.js plugin `handleKeyDown`: **DELETE the Tab branch** (keep Enter/Mod+Enter for now).

- [ ] **Step 3: Verify in the browser (headless Chrome against `wails dev`)**

Checklist (contract rows exercised — also run by hand if headless is fiddly):
- Table: Tab moves to next cell (defect 6 dead), Shift+Tab to previous, Shift+Tab in first cell does nothing but focus stays, Tab in last cell appends a row.
- List: Tab indents item, Shift+Tab outdents (unchanged).
- Plain paragraph: Tab does nothing, Shift+Tab does nothing, **focus never leaves the editor** (defect 2 dead).
- Code block: Tab inserts 2 spaces at caret line start… multi-line selection: both lines indent (new capability); Shift+Tab de-indents (defect 1 dead — no more 4-vs-2).
- Undo: one Ctrl+Z reverts one indent operation.

- [ ] **Step 4: Run vitest suite** — `cd frontend && npx vitest run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/editor/ frontend/src/static/processors/ frontend/src/index.html
git commit -m "feat(editor): shared interaction-policy extension owns Tab/Shift+Tab; root+renderer Tab branches deleted"
```

---

### Task 5: Enter conformance — newline+auto-indent, diagram Mod+Enter unification (kills defect 5)

**Files:**
- Modify: `frontend/src/static/editor/interaction-policy.js`, `frontend/src/static/processors/code-renderer.js`, `frontend/src/static/processors/diagram-renderer.js`

- [ ] **Step 1: Extend the extension's handleKeyDown for Enter**

Add to the same plugin (above the Tab handling, same props function — one keydown handler, branch on key):

```js
              if (event.key === 'Enter') {
                var ctx = resolveContext(view.state)
                var isMod = event.metaKey || event.ctrlKey
                if (isMod && ctx.policy.modEnterTogglesMode) {
                  var beh = getBlockBehaviour(ctx.kind)
                  if (beh && beh.onModEnter) {
                    event.preventDefault()
                    return beh.onModEnter(view, view.state.selection) === true
                  }
                }
                if (ctx.policy.readOnlyText && !isMod) {
                  event.preventDefault()
                  return true // consume: read-only text
                }
                if (ctx.policy.enterInsertsNewline && !ctx.isNodeSelection && ctx.mode !== 'render' && !isMod) {
                  event.preventDefault()
                  var s = rawTextSpan(view.state)
                  var indent = ctx.policy.autoIndentOnEnter ? leadingIndentAt(s.text, s.from) : ''
                  view.dispatch(view.state.tr.insertText('\n' + indent).scrollIntoView())
                  return true
                }
                return false // native Enter (prose split, etc.) — Mod+Enter escape comes in Task 6
              }
```

- [ ] **Step 2: Diagram — one toggle function, two entry points**

In diagram-renderer.js, add to the renderer object a behaviour hook (replacing the toggle logic currently inline in its plugin handleKeyDown):

```js
    // onModEnter — the ONE mode-flip entry point (policy plugin + render-body
    // listener both call it; the two-mechanism split was contract defect #5).
    onModEnter: function (view, selection) {
      var node = selection.node || selection.$from.parent
      if (!node || node.type.name !== 'sieve-diagram') return false
      var id = node.attrs.id
      if (!id) return false
      var cursorPos = selection.node
        ? (typeof node.attrs.cursorPos === 'number' ? node.attrs.cursorPos : 0)
        : selection.$from.parentOffset
      var newMode = node.attrs.mode === 'render' ? 'edit' : 'render'
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: id, kind: 'diagram', attrs: { mode: newMode, cursorPos: cursorPos } },
      }))
      return true
    },
```

Then:
- **DELETE** diagram-renderer's plugin `handleKeyDown` entirely (Tab went in Task 4; Enter/Mod+Enter now live in the policy extension → its plugin keeps only decorations).
- The render-body `Ctrl/Cmd-Enter` DOM listener (~line 556) now calls `DiagramRenderer.onModEnter` with a synthesized selection: replace its body with a call that dispatches the same `sieve:block-update` via `onModEnter` — simplest faithful form: keep the listener but have it call a small shared private `flipMode(nodeAttrs)` that `onModEnter` also uses; both paths MUST dispatch identical events.
- code-renderer.js: **DELETE its Enter branch** (and now-empty handleKeyDown, if nothing remains — keep the decorations plugin).

- [ ] **Step 3: Verify in browser + WebKit app**

- Code block: Enter mid-line → newline copying leading whitespace (type `  foo`, Enter at end → caret indented 2).
- Enter at end of code block → newline INSIDE the block (never escapes).
- Diagram edit mode: Enter → newline; Ctrl+Enter → render mode, cursor pos kept.
- Diagram render mode: Ctrl+Enter with block selected → edit mode; Ctrl+Enter with SVG body focused → edit mode (defect 5 dead — same behaviour both entry points).
- Log block: typing/Enter inside does nothing (still consumed — its own plugin still guards; Task 7 unifies).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor/interaction-policy.js frontend/src/static/processors/
git commit -m "feat(editor): Enter via policy — auto-indent newline in raw-text, one diagram Mod+Enter path"
```

---

### Task 6: Caret contract — trailing node, Mod+Enter escape, read-only caret stops

**Files:**
- Modify: `frontend/src/static/editor/editor.js` (trailingNode config), `frontend/src/static/editor/interaction-policy.js`
- Test: append pure-logic cases to `frontend/test/interaction-policy.test.js` where extractable

- [ ] **Step 1: Trailing-node guarantee**

editor.js ~line 347: change `trailingNode: false` → `trailingNode: true` in the StarterKit config and DELETE the stale comment above it (the "let Gapcursor handle it" bet — it fails for non-atom read-only containers, see `project_block_cursor_affordance_defect`). Confirm the StarterKit bundle includes the trailing-node extension: `grep -n "trailingNode\|TrailingNode" frontend/src/static/vendor/tiptap.js | head -3`. If the bundled StarterKit does NOT support it, STOP and flag — do not hand-roll one silently (options: rebundle with the extension, or a 15-line appendTransaction plugin inside interaction-policy.js; prefer rebundle only with user sign-off per npm rules).

- [ ] **Step 2: Mod+Enter = insert paragraph after current block (universal escape)**

In the Enter branch of the policy plugin, after the `modEnterTogglesMode` check, add:

```js
                if (isMod) {
                  // Universal escape: paragraph after the caret's TOP-LEVEL block.
                  event.preventDefault()
                  var state = view.state
                  var $from = state.selection.$from
                  var topDepth = 1
                  var after = state.selection.node
                    ? state.selection.to
                    : $from.after(topDepth)
                  var para = state.schema.nodes.paragraph.create()
                  var tr2 = state.tr.insert(after, para)
                  tr2 = tr2.setSelection(T.TextSelection.create(tr2.doc, after + 1)).scrollIntoView()
                  view.dispatch(tr2)
                  return true
                }
```

(`T` must be in scope in the extension factory — it already is: `buildInteractionPolicyExtension(T)`.)

Also: plain Enter while a `caretStop` block is NodeSelected does the same (contract row "insert ¶ after (caret stop)"):

```js
                if (ctx.isNodeSelection && ctx.policy.caretStop && !isMod) {
                  // same insert-paragraph-after body as above
                }
```

Extract the insert-paragraph-after body into a local function `insertParagraphAfter(view, T)` used by both.

- [ ] **Step 3: Read-only caret stop on arrows**

Append to the plugin's handleKeyDown:

```js
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                var down = event.key === 'ArrowDown'
                var st = view.state
                // Case 1: a caretStop block is selected → move past it.
                if (st.selection.node) {
                  var selCtx = resolveContext(st)
                  var stop = selCtx.policy.caretStop
                  if (stop === 'render' ? selCtx.mode === 'render' : stop) {
                    var target = down ? st.selection.to : st.selection.from
                    var sel = T.TextSelection.near(st.doc.resolve(target), down ? 1 : -1)
                    view.dispatch(st.tr.setSelection(sel).scrollIntoView())
                    return true
                  }
                  return false
                }
                // Case 2: caret at the boundary line adjacent to a caretStop block
                // → select the block (single stop) instead of PM's default
                // (which dives inside non-atom read-only containers).
                var $head = st.selection.$head
                var adjacent = down
                  ? st.doc.resolve($head.after(1)).nodeAfter
                  : st.doc.resolve($head.before(1)).nodeBefore
                if (adjacent && adjacent.type.name.indexOf('sieve-') === 0) {
                  var kind = adjacent.type.name.slice('sieve-'.length)
                  var pol = policyFor(kind)
                  var isStop = pol.caretStop === 'render'
                    ? adjacent.attrs && adjacent.attrs.mode === 'render'
                    : pol.caretStop
                  if (isStop && view.endOfTextblock(down ? 'down' : 'up')) {
                    var pos = down ? $head.after(1) : $head.before(1) - adjacent.nodeSize
                    view.dispatch(st.tr.setSelection(T.NodeSelection.create(st.doc, pos)).scrollIntoView())
                    return true
                  }
                }
                return false
              }
```

**Position-arithmetic caution for the implementer:** `$head.before(1) - adjacent.nodeSize` / `$head.after(1)` boundary math must be validated interactively — PM off-by-ones here are the classic failure. If a NodeSelection lands wrong, log `pos`, compare with `st.doc.resolve(...)` structure, adjust. `view.endOfTextblock` is the correct guard for "caret is on the boundary line".

- [ ] **Step 4: Verify against the contract's caret section, in BOTH Chrome dev server and the WebKitGTK app**

- Prose above a web-clip: ArrowDown selects the clip (ring visible), ArrowDown again lands in content below (or trailing paragraph). ArrowUp symmetric.
- Doc ending in a code block: trailing paragraph exists, ArrowDown from last code line reaches it, content unchanged (no phantom newline).
- Code block from prose above: ArrowDown enters FIRST line as text caret (not NodeSelection).
- Mod+Enter in every context inserts a paragraph after the current top-level block and moves the caret there (except diagram, which toggles — its declared override).
- Enter on a selected ai-block/web-clip/smart-image inserts a paragraph after it — including between two adjacent read-only blocks.
- Diagram render↔edit round-trip restores cursor position.

- [ ] **Step 5: Run vitest, commit**

```bash
cd frontend && npx vitest run
git add frontend/src/static/editor/
git commit -m "feat(editor): caret contract — trailing node on, Mod+Enter escape, read-only single caret stops"
```

---

### Task 7: Home/End smart behaviour + log unification

**Files:**
- Modify: `frontend/src/static/editor/interaction-policy.js`, `frontend/src/static/processors/log-renderer.js`

- [ ] **Step 1: Home in raw-text blocks**

Append to the plugin handleKeyDown:

```js
              if (event.key === 'Home' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
                var hCtx = resolveContext(view.state)
                if (!hCtx.policy.rawText || hCtx.isNodeSelection) return false
                var hs = rawTextSpan(view.state)
                var lineStart = hs.text.lastIndexOf('\n', hs.from - 1) + 1
                var lineText = hs.text.slice(lineStart, (hs.text + '\n').indexOf('\n', lineStart))
                var col = hs.from - lineStart
                var targetCol = smartHomeTarget(lineText, col)
                var pos = hs.blockStart + lineStart + targetCol
                view.dispatch(view.state.tr.setSelection(T.TextSelection.create(view.state.doc, pos)))
                event.preventDefault()
                return true
              }
```

- [ ] **Step 2: Log key-swallowing via policy**

The extension already consumes Enter for `readOnlyText` (Task 5). Extend: in the plugin, before other branches, add a `readOnlyText` guard for typing keys mirroring log-renderer's current rule (`event.key.length === 1 && !meta/ctrl`, plus Backspace/Delete). Then DELETE the `handleKeyDown` prop from log-renderer.js's plugin (keep its `handlePaste` guard and decorations — paste stays consumed per the contract).

- [ ] **Step 3: Verify**

- Code block: Home toggles first-non-ws / column-0.
- Log block: typing, Backspace, Enter inside are consumed exactly as before; selection/copy still work.
- Run `cd frontend && npx vitest run` → PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor/interaction-policy.js frontend/src/static/processors/log-renderer.js
git commit -m "feat(editor): smart Home in raw-text blocks; log read-only keys via shared policy"
```

---

### Task 8: Stale docs + contract cross-references

**Files:**
- Modify: `frontend/src/static/processors/code-renderer.js` (header comment lines 1–9), `frontend/src/static/processors/diagram-renderer.js` (header comment ~lines 1–5), `docs/editor-interaction-contract.md`

- [ ] **Step 1: Fix the stale "textarea + overlay" header comments** — describe reality:

```js
// code-renderer.js — Sieve block renderer for the 'code' kind.
//
// Editing surface: a ProseMirror contentDOM (pre>code, code:true node) — NOT a
// textarea (that implementation is long gone). Syntax highlight is decoration-
// based. Keyboard behaviour (Tab/Enter/Home) comes from the shared
// interaction-policy extension via this renderer's interactionPolicy — do not
// add handleKeyDown here (docs/editor-interaction-contract.md).
```

Mirror the same correction in diagram-renderer.js's header ("Edit mode: contentDOM + highlight overlay + line gutter…").

- [ ] **Step 2: Contract doc final pass** — walk every matrix cell against the implementation; ✅ or fix. Append any rows discovered during Tasks 4–7 (e.g. exact first/last-cell table behaviour observed). Commit doc updates with the code they describe if any fix is needed.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/static/processors/ docs/editor-interaction-contract.md
git commit -m "docs(editor): correct stale renderer headers; contract doc conformance pass"
```

---

### Task 9: Full conformance pass + CLAUDE.md rules

**Files:**
- Modify: `CLAUDE.md`, `docs/TECH-DEBT.md`

- [ ] **Step 1: Manual regression pass** — run the ENTIRE key matrix + caret contract + copy/paste matrices from `docs/editor-interaction-contract.md` in `wails dev` (drive headless where scriptable), then spot-check caret feel in the real WebKitGTK app (`wails build` or dev window, not just Chrome). Record ✅/❌ per row in the doc; fix ❌s before proceeding.

- [ ] **Step 2: Add to CLAUDE.md** (Non-Obvious Rules):

```markdown
- **Editor interaction contract** — `docs/editor-interaction-contract.md` is NORMATIVE. New block kinds declare `interactionPolicy` (see `interaction-policy.js` DEFAULT_POLICY); per-renderer `handleKeyDown` for Tab/Enter/Home/arrows is forbidden — the shared policy extension (priority 50, defer-first) owns them. Any interaction change updates the contract doc in the same change.
```

- [ ] **Step 3: TECH-DEBT entries** (follow the file's format):
- Auto-pairing (`autoPair` policy flag) deferred from the interaction contract.
- Contract matrices → Playwright harness test inventory when the browser harness lands (`project_testing_strategy`).

- [ ] **Step 4: Final suite + commit**

```bash
cd frontend && npx vitest run && cd .. && go build ./...
git add CLAUDE.md docs/TECH-DEBT.md docs/editor-interaction-contract.md
git commit -m "docs: editor interaction upkeep rules; conformance pass recorded"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** contract doc (T1), policy mechanism + declarations (T2–3), defects 1/2/6 (T4), defect 5 + Enter policy (T5), caret contract incl. trailing node/escape/caret stops (T6), affordances Home + log unification (T7), stale docs = defect list item 6 (T8), CLAUDE.md (T9). Defects 3/4 are bless-and-document — encoded in T1's matrices, no code change. Auto-pairing explicitly deferred (spec marked it stretch).
- **Deviation from spec, justified:** log block is read-only text (verified in log-renderer.js:620–628), so it takes `readOnlyText`, not the raw-text indent policy the spec grouped it with. Contract doc (T1) already reflects this.
- **Known risk concentrations:** T6 Step 3 position arithmetic (flagged inline with debugging guidance); bundled StarterKit trailingNode support (T6 Step 1 has a STOP condition); renderer-import weight in vitest (T3 Step 2 offers the stand-in fallback).
- **Type consistency:** `policyFor`/`classifyContext`/`resolveContext`/`rawTextSpan` names used identically across T2 code and T4–7 extensions; `caretStop: 'render'` convention defined in T3 and consumed in T6.
