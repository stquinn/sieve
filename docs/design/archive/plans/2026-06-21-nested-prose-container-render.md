# Nested-Prose Container Render Implementation Plan

> **STATUS — ✅ COMPLETE (closed out 2026-06-28).** A multi-node prose block renders as ONE chrome-less editable `proseGroup` container (`frontend/src/static/prose-group.js`), chosen by the renderer's own parse count. Tech-debt **E-1 (embed fragmentation) RESOLVED** (user-verified in-app; commits `77ad7ae`, `cd6c66d`). Block-model close-out item for Stage D. **Note:** this is backend-authoritative *by construction* and does **not** depend on **B-A** (frontend-minted prose ids), which remains separately ⏸ **DEFERRED** (`docs/TECH-DEBT.md`).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a multi-node `kind:prose` block (an embedded AI answer / Web Clip) as ONE editable block with ONE id, instead of fragmenting it into N native nodes that mint N separate block ids (the embed-fragmentation bug, tech-debt E-1).

**Architecture:** A multi-node prose block becomes a single chrome-less, editable `content:'block+'` container node (`proseGroup`) on the frontend ONLY. It is the prose kind's *multi-node rendering* — not a new kind, not a `sieve-*` NodeView. Because its node name is `proseGroup` (not `sieve-*`), `isNativeProseNodeName(name) === true`, so every existing prose path (save via `topBlockTriple`/`wysiwygMarkdown`, AI ref-chain via `proseChainHits`, identity via the mint observer) already treats it as ONE native prose block — no bridge code. The renderer's own parse decides: a prose block that parses to 1 top-level node stays a native node (today); >1 → one container. The backend is unchanged: the wire kind is always `prose`, the container's markdown serialize is transparent (children only), and Go re-wraps in `<!--s:id-->` markers on save exactly as for single-node prose.

**Tech Stack:** Vanilla JS, TipTap 2 / ProseMirror, tiptap-markdown, vitest. No Go, no backend, no React.

## Global Constraints

- **Backend is UNCHANGED.** No Go edits, no codec change, no on-disk flag. The wire `kind` is always `prose`. The container is purely a frontend rendering of an existing multi-node prose block.
- **Wysiwyg renders from the structured block list (`attrs`) — NEVER from a doc-level markdown string.** Markdown and `serialisedForm` are storage/transitional representations being retired from the model; re-deriving the document (its blocks, structure, or ids) from a markdown string via `setContent(<flat markdown>)` is FORBIDDEN in the wysiwyg path — it is the embed-fragmentation bug, and it depends on a representation that is going away. The doc and every id come from `data.blocks`. (A single *prose* block's `content` is still a markdown string rendered *within its own block boundary* — that is allowed; what is forbidden is the doc-level re-parse that ignores boundaries and invents ids.) Markdown MODE (the breakglass textarea) is the only place a flat markdown body is an input.
- **Created ONLY by code** — `proseBlockNodes`, called from `renderBlocksIntoEditor` at load. The editor / keyboard / toolbar NEVER creates a container (the doc top is `(block | sieveBlock)+` with native nodes as first-class sibling blocks, so typing makes native sibling blocks, never a container). Future toolbar containers (columns/cells) are out of scope.
- **Node name MUST be `proseGroup`** — NOT `sieve-*`. This is load-bearing: `isNativeProseNodeName('proseGroup') === true` is what routes the container through every prose path (save, chain, identity) with zero bridge code. Naming it `sieve-prose` would break this and require teaching four paths to treat it as prose.
- **Root DOM MUST carry `class="block-node"` and `data-id="<id>"`** — the hooks the block CSS and the AI ref-chain accent target (CSS matches `.block-node[data-id]`). Native prose nodes get these from the `BlockId` global attr; `proseGroup` is not in that list, so its own `renderHTML` emits them.
- **Markdown serialize MUST be transparent** — emit ONLY the children's markdown, no wrapper, no `<!--s:id-->` markers. Go owns the marker wrapper on save (serialization is a backend concern).
- **One-id invariant** — a multi-node prose block renders to exactly ONE container node = ONE block. Its children are never top-level, so they are never minted and never become separate blocks.
- **No keymap. Start with ZERO schema flags** (no `defining`, no `isolating`). The container's keyboard/boundary behavior is left to PM (Enter inside → new child; Enter on an empty trailing line → escape to a new native sibling block; it never splits into two containers). Add a schema flag ONLY if in-app acceptance shows the one-id invariant breaking; document any flag added and the behavior that forced it.
- **Editability is the proven native `block+` mechanism** (the early single-container "bag" demonstrated it). The bag failed only because it was the DOC TOP NODE — trapping the doc in one block with no sibling. This container is the inverse: ONE selective sibling among first-class native blocks. Do NOT make it the top node and do NOT use the sieve display framework (`sieve-block-extension.js`) — its `block+` renderers (`ai-block`, `web-clip`) are non-editable display blocks.
- **`index.html` changes need a `.go` touch (or rebuild) to go live** — `wails dev` rebuilds on `.go` changes only; `/static/` JS is served live from disk.
- **Process:** TDD (watch each test fail first). One commit per task. NO `Co-Authored-By` trailer. Stage explicit paths only — never `git add -A`. Do NOT touch the pre-existing unstaged changes `frontend/src/static/tailwind.css` and `sieve/ai/cli.go`, or untracked scratch in the repo root.

## File Structure

- **Create** `frontend/src/static/prose-group.js` — the container module. Pure exports `proseBlockNodes(fragment, id, schema)` (the 1-vs-N mapper) and `proseGroupMarkdownSerialize(state, node)` (transparent serialize), plus a guarded `proseGroup` node definition registered as `window.TipTap.ProseGroup` / `window.TipTap.proseBlockNodes`. The TipTap-node creation is guarded behind `if (T.Node)` so the module is importable in a bare vitest env (where the pure exports are tested).
- **Create** `frontend/test/prose-group.test.js` — vitest for the two pure exports + the node's schema shape.
- **Modify** `frontend/src/index.html` — add the `prose-group.js` module script (after `prose-block.js`, before `editor.js`).
- **Modify** `frontend/src/static/editor.js` — register `T.ProseGroup` in the editor extensions; switch `renderBlocksIntoEditor`'s prose branch to call `proseBlockNodes`.
- **Modify** `frontend/src/static/editor.css` — minimal `.prose-group` rule (block-level spacing only; no visual chrome).

---

### Task 1: The `proseGroup` container node + `proseBlockNodes` mapper

**Files:**
- Create: `frontend/src/static/prose-group.js`
- Test: `frontend/test/prose-group.test.js`

**Interfaces:**
- Produces: `proseBlockNodes(fragment, id, schema) → Node[]` — maps a parsed prose-content Fragment to the doc node(s): `[]` for 0 children, `[node-with-id]` for 1, `[one-proseGroup-with-id]` for >1. Consumed by `renderBlocksIntoEditor` in Task 2.
- Produces: `proseGroupMarkdownSerialize(state, node)` — the transparent tiptap-markdown serialize fn (delegates to `state.renderContent(node)`).
- Produces: `window.TipTap.ProseGroup` (TipTap node), `window.TipTap.proseBlockNodes` — consumed by `editor.js` in Task 2.

- [ ] **Step 1: Write the failing test for the pure exports + node shape**

Create `frontend/test/prose-group.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { Schema, Fragment } from '@tiptap/pm/model'
import { proseBlockNodes, proseGroupMarkdownSerialize } from '../src/static/prose-group.js'

// A minimal schema mirroring the live doc's relevant shape: native prose nodes
// (group "block") + the proseGroup container (group "block", content "block+").
// This pins the design; the live ProseGroup node transcribes it.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*', attrs: { id: { default: '' } },
      toDOM: (n) => ['p', { 'data-id': n.attrs.id }, 0],
    },
    heading: {
      group: 'block', content: 'inline*', attrs: { id: { default: '' } },
      toDOM: (n) => ['h1', { 'data-id': n.attrs.id }, 0],
    },
    proseGroup: {
      group: 'block', content: 'block+', attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-id': n.attrs.id, class: 'block-node prose-group' }, 0],
    },
    text: { group: 'inline' },
  },
})

describe('proseBlockNodes', () => {
  it('1 node → that node with the block id stamped (no container)', () => {
    const p = schema.nodes.paragraph.create({}, schema.text('hello'))
    const out = proseBlockNodes(Fragment.from(p), 'pr-1', schema)
    expect(out.length).toBe(1)
    expect(out[0].type.name).toBe('paragraph')
    expect(out[0].attrs.id).toBe('pr-1')
  })

  it('>1 nodes → ONE proseGroup carrying the id, wrapping all children', () => {
    const h = schema.nodes.heading.create({}, schema.text('Title'))
    const p = schema.nodes.paragraph.create({}, schema.text('body'))
    const out = proseBlockNodes(Fragment.fromArray([h, p]), 'ai-d63e', schema)
    expect(out.length).toBe(1)
    expect(out[0].type.name).toBe('proseGroup')
    expect(out[0].attrs.id).toBe('ai-d63e')
    expect(out[0].childCount).toBe(2)
    expect(out[0].child(0).type.name).toBe('heading')
    expect(out[0].child(1).type.name).toBe('paragraph')
  })

  it('0 nodes → [] (caller logs an empty-block error)', () => {
    expect(proseBlockNodes(Fragment.empty, 'pr-x', schema)).toEqual([])
  })
})

describe('proseGroupMarkdownSerialize', () => {
  it('is transparent — delegates to renderContent and writes no wrapper/markers', () => {
    const calls = { rendered: [], writes: [] }
    const fakeState = {
      renderContent(node) { calls.rendered.push(node) },
      write(s) { calls.writes.push(s) },
    }
    const node = { type: { name: 'proseGroup' } }
    proseGroupMarkdownSerialize(fakeState, node)
    expect(calls.rendered).toEqual([node]) // children rendered…
    expect(calls.writes).toEqual([])        // …and nothing else written
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run test/prose-group.test.js`
Expected: FAIL — cannot resolve `../src/static/prose-group.js` (module does not exist yet).

- [ ] **Step 3: Create `prose-group.js` with the pure exports + guarded node**

Create `frontend/src/static/prose-group.js`:

```js
// prose-group.js — the multi-node prose CONTAINER (the embed render, 2026-06-21).
//
// A backend `kind:prose` block whose content is MULTI-NODE (an embedded AI answer
// or Web Clip: heading + paragraphs) must render as ONE editable block with ONE
// id — not N native nodes (which the mint observer would split into N blocks: the
// embed-fragmentation bug, tech-debt E-1). This node is that container.
//
// It is the PROSE kind's multi-node rendering — NOT a new kind and NOT a sieve-*
// NodeView. Because its node name is `proseGroup` (not `sieve-*`),
// isNativeProseNodeName(name) === true, so every prose path already handles it as
// ONE native prose block, with no bridge:
//   - save:     topBlockTriple + wysiwygMarkdown serialize it via serializeNode and
//               (wysiwyg) wrap it in <!--s:id--> markers — like single-node prose.
//   - chain:    proseChainHits matches it (top-level, native-named, id) so the AI
//               ref-chain decoration lands on its root.
//   - identity: the mint observer counts it as one top-level prose node; it carries
//               the loaded id, so nothing is minted. Its CHILDREN are not top-level,
//               so they are never minted or treated as blocks.
//
// Created ONLY by code (proseBlockNodes, from renderBlocksIntoEditor at load when a
// prose block parses to >1 top-level node). The editor/keyboard never creates one.
//
// Editability is the proven native `block+` mechanism (the early single-container
// "bag"). The bag failed only because it was the DOC top node — trapping the doc in
// one block with no sibling. This container is the inverse: ONE selective sibling
// among first-class native blocks.
//
// Markdown serialize is TRANSPARENT: emit ONLY the children's markdown, no markers.
// Go re-wraps in <!--s:id--> on save — serialization stays a backend concern.
//
// Depends on window.TipTap (vendor/tiptap.js) for Node — guarded so this module is
// importable in a bare (vitest) env where TipTap is absent; the pure exports
// (proseBlockNodes, proseGroupMarkdownSerialize) are always available.

const T = (typeof window !== 'undefined' && window.TipTap) || {}

// proseGroupMarkdownSerialize: TRANSPARENT serialize — render ONLY the children, no
// wrapper, no markers. state.renderContent walks the child blocks and lets each
// serialize itself with proper block separation (the prosemirror-markdown contract,
// the same call blockquote's serializer uses).
export function proseGroupMarkdownSerialize(state, node) {
  state.renderContent(node)
}

// proseBlockNodes maps a prose block's PARSED content (a Fragment of native
// top-level nodes, as produced by the editor's own DOMParser) to the node(s) the
// document should hold:
//   - 0 children  → []        (caller logs an empty-block error)
//   - 1 child     → [that node, with the block id stamped]   (the native path)
//   - >1 children → [ONE proseGroup carrying the id, wrapping all N]  (the fix)
// The renderer's OWN parse count decides: a typed prose block is always exactly one
// top-level node; only an actor-created embed is multi-node. So childCount > 1 ⟺ a
// container — no flag, no content inspection.
export function proseBlockNodes(fragment, id, schema) {
  if (!fragment || fragment.childCount === 0) return []
  if (fragment.childCount === 1) {
    const only = fragment.firstChild
    return [only.type.create(Object.assign({}, only.attrs, { id: id }), only.content, only.marks)]
  }
  return [schema.nodes.proseGroup.create({ id: id }, fragment)]
}

if (T.Node) {
  const ProseGroup = T.Node.create({
    name: 'proseGroup',
    group: 'block',
    content: 'block+',
    addAttributes() {
      return {
        // The id round-trips through data-id. The attribute's renderHTML returns {}
        // so the node renderHTML below is the SOLE emitter of data-id (no conflict /
        // no dependency on mergeAttributes); parseHTML reads it back on re-parse.
        id: {
          default: '',
          parseHTML(el) { return el.getAttribute('data-id') || '' },
          renderHTML() { return {} },
        },
      }
    },
    parseHTML() { return [{ tag: 'div.prose-group' }] },
    // Root carries `block-node` + data-id so it gets the SAME block styling and AI
    // ref-chain accent as every other block (CSS targets .block-node[data-id]). `0`
    // is the content hole → children render and edit natively (no NodeView).
    renderHTML(props) {
      const id = props.node.attrs.id
      const attrs = { class: 'block-node prose-group' }
      if (id) attrs['data-id'] = id
      return ['div', attrs, 0]
    },
    addStorage() {
      return { markdown: { serialize: proseGroupMarkdownSerialize } }
    },
  })

  T.ProseGroup = ProseGroup
  T.proseBlockNodes = proseBlockNodes
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && npx vitest run test/prose-group.test.js`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run the full vitest suite to confirm no regression**

Run: `cd frontend && npx vitest run`
Expected: PASS — the prior suite count + 4 new tests, all green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/static/prose-group.js frontend/test/prose-group.test.js
git commit -m "Add proseGroup container node + proseBlockNodes mapper (transparent serialize, frontend-only)"
```

---

### Task 2: Register the container + route ALL wysiwyg doc render through `renderBlocksIntoEditor`/`proseBlockNodes`

**Why this task is bigger than "the childCount switch":** the embed (AI block → prose) re-renders via `block-promoted` → `softReloadContent` → `setContent(data.body)` — a frontend-local **flat-markdown re-parse**, NOT `renderBlocksIntoEditor`. That flat re-parse is the fragmentation engine: it splits a multi-node prose block into N native nodes AND loses the backend's block id (observed: an embedded AI answer became `pr-9306`/`pr-c97f`/`pr-e27f`, the original `ai-c53d` id gone). So patching `renderBlocksIntoEditor` alone (2a) never fires for the embed — the embed must also be routed through the block-list path (2b). The backend half is already correct (`PromoteBlock` creates one prose block, reuses the embedded id); the bug is purely that the frontend re-derives the doc from flat markdown instead of **faithfully rendering the backend's authoritative block list**. `/api/editor/load` already returns `data.blocks` (`requesthandlers/editor_handler.go:56,85`); `softReloadContent` currently ignores them.

**Files:**
- Modify: `frontend/src/index.html` (add the module script)
- Modify: `frontend/src/static/editor.js` (register `T.ProseGroup`; rewrite the prose branch of `renderBlocksIntoEditor` [2a]; route `softReloadContent`'s wysiwyg branch through `renderBlocksIntoEditor(data.blocks)` [2b])
- Modify: `frontend/src/static/editor.css` (minimal `.prose-group` spacing)

**Interfaces:**
- Consumes: `window.TipTap.ProseGroup`, `window.TipTap.proseBlockNodes` (Task 1).
- `renderBlocksIntoEditor(editor, blocks)` already exists (editor.js:158) and replaces the whole doc via a non-undoable transaction — 2b reuses it; it must keep `softReloadContent`'s cursor-restore (`setTextSelection` after).

- [ ] **Step 1: Load the container module in `index.html`**

In `frontend/src/index.html`, add the module script immediately after the `prose-block.js` line (currently line 294) and before `editor.js`:

```html
    <script type="module" src="/static/prose-block.js"></script>
    <script type="module" src="/static/prose-group.js"></script>
    <script src="/static/editor.js"></script>
```

- [ ] **Step 2: Register `T.ProseGroup` in the editor extensions**

In `frontend/src/static/editor.js`, the editor's `extensions` array ends with a `.concat(...)` chain (around line 320, `.concat(window.SieveNativeCodeBlock ? [...] : []).concat(T.getSieveNodes()).concat([...])`). Add a guarded concat for the container right after the `SieveNativeCodeBlock` concat:

```js
      ].concat(window.SieveNativeCodeBlock ? [window.SieveNativeCodeBlock] : [])
       .concat(window.TipTap.ProseGroup ? [window.TipTap.ProseGroup] : [])
       .concat(T.getSieveNodes()).concat([
```

(No change to the `doc` schema: `proseGroup` is `group: 'block'`, which the existing `(block | sieveBlock)+` top-level content already admits.)

- [ ] **Step 3: Rewrite the prose branch of `renderBlocksIntoEditor` to call `proseBlockNodes`**

In `frontend/src/static/editor.js`, `renderBlocksIntoEditor` (around lines 172–184), replace the entire `if (b.kind === 'prose') { ... }` block — which currently stamps `data-id` on the first DOM child and pushes every parsed top-level node — with:

```js
        if (b.kind === 'prose') {
          // Node-granular: a prose block parses to its NATIVE top-level node(s). One
          // node → that node carries the block id (the native path). >1 nodes → ONE
          // proseGroup container carries the id and wraps them, so a multi-node embed
          // stays ONE block (proseBlockNodes, prose-group.js). The id is stamped onto
          // the node, not the DOM — children are never top-level, never minted.
          var parsed = parser.parse(tmp).content
          var produced = window.TipTap.proseBlockNodes(parsed, b.id || '', editor.state.schema)
          if (!produced.length) {
            console.error('[editor] prose block ' + i + ' (' + (b.id || '') + ') produced no node from:\n' + bhtml.trim().slice(0, 200))
          }
          produced.forEach(function (n) { nodes.push(n) })
        } else {
```

(Leave the `else` structured branch — `var want = 'sieve-' + b.kind; ...` — exactly as-is.)

- [ ] **Step 3b: Route `softReloadContent`'s wysiwyg branch through the block list (THE EMBED FIX)**

This is the path the embed actually uses (`block-promoted` → `softReloadContent`, editor.js:718–719). Currently its wysiwyg branch does `setContent(data.body)` — a flat re-parse that fragments a multi-node prose block and loses the backend id. In `frontend/src/static/editor.js`, `softReloadContent` (around lines 1402–1409), replace ONLY the wysiwyg branch:

```js
        if (currentMode === 'wysiwyg' && currentEditor) {
          currentEditor.commands.setContent(body)
          lastSyncedBody = body
          aiReloadInProgress = false
          var maxPos = currentEditor.state.doc.content.size
          currentEditor.commands.setTextSelection(Math.min(savedAnchor, maxPos - 1))
        }
```

with:

```js
        if (currentMode === 'wysiwyg' && currentEditor) {
          // Wysiwyg renders the backend's AUTHORITATIVE block list — markdown is
          // NOT a wysiwyg render input. A flat setContent(body) re-parse ignores
          // block boundaries and invents ids, fragmenting a multi-node prose block
          // and losing its id (the embed bug). The doc structure + every id come
          // from data.blocks; renderBlocksIntoEditor + proseBlockNodes wrap a multi-
          // node block into ONE container carrying its id. (Per-block prose content
          // is still markdown, but rendered WITHIN its own block by the block list —
          // it never crosses a boundary.) No setContent fallback: there is no
          // markdown render path for wysiwyg.
          renderBlocksIntoEditor(currentEditor, data.blocks || [])
          lastSyncedBody = body
          aiReloadInProgress = false
          var maxPos = currentEditor.state.doc.content.size
          currentEditor.commands.setTextSelection(Math.min(savedAnchor, maxPos - 1))
        }
```

(`renderBlocksIntoEditor` is in module scope, callable here. `lastSyncedBody = body` stays — it is the sync-diff baseline bookkeeping, not a render input. The markdown-MODE branch below — the breakglass textarea — keeps its flat body; only wysiwyg render changes. `renderBlocksIntoEditor` already early-returns when `nodes.length === 0`, matching `mountWysiwyg`'s empty handling — confirm this is acceptable for an emptied-doc reload, and if the doc must be cleared to empty, handle it explicitly rather than via `setContent`.)

- [ ] **Step 3c: Audit the remaining wysiwyg `setContent(body)` doc-load callers**

Use the language-server `references` tool (or grep) on `setContent` in `editor.js`. For EACH call site that loads a whole document into the **wysiwyg** editor from disk/backend body (candidates: the `setContent(data.body)` near line 1911, the `setContent` helper near line 1687 when used for a doc load), confirm whether it should instead render `data.blocks` via `renderBlocksIntoEditor`. Convert the ones that are wysiwyg doc-loads (same fragmentation risk); leave markdown-mode and non-doc uses alone. If a call site is ambiguous, note it in the report and leave it — do not guess. The flat re-parse must not be a wysiwyg doc-render path anywhere.

- [ ] **Step 4: Add a minimal `.prose-group` style**

In `frontend/src/static/editor.css`, add (the container is visually transparent — block spacing only, no chrome; `.block-node` already supplies padding/accent shared with every block):

```css
/* proseGroup: the multi-node prose container. Transparent — no chrome; it relies on
   the shared .block-node styling. This rule only ensures its children sit as a
   normal block run. */
.prose-group > * {
  margin-block: 0;
}
```

- [ ] **Step 5: Verify the JS bundle is consistent (lint/build smoke)**

Run: `cd frontend && npx vitest run`
Expected: PASS — unchanged from Task 1 (this task is wiring; its behavior is verified in-app below and pinned in Task 3).

- [ ] **Step 6: Manual (in-app) smoke — requires the running app**

> Requires the user to run the app. Because `index.html` changed, a `.go` touch / rebuild is needed for it to go live (`/static/` JS is live from disk). Hand this to the user; do not assume the app is running.

Open a document containing an **embedded multi-node block** (e.g. the `ai-d63e` embed: an AI answer with a heading + a paragraph). Verify it renders as **ONE block** — one element with a single `data-id`, NOT two `pr-xxxx` fragments. (Editing/save/reload are gated in Task 3.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/index.html frontend/src/static/editor.js frontend/src/static/editor.css
git commit -m "Render multi-node prose blocks as one proseGroup container (childCount switch in renderBlocksIntoEditor)"
```

---

### Task 3: Pin the prose-path behavior + full in-app acceptance

**Files:**
- Test: `frontend/test/prose-group-paths.test.js` (the unit pins)

**Interfaces:**
- Consumes: `isNativeProseNodeName`, `proseChainHits` from `frontend/src/static/block-kinds.js` (pure, importable).

- [ ] **Step 1: Write the failing behavior-pin tests**

Create `frontend/test/prose-group-paths.test.js`. These pin the two facts that make the container flow through the prose machinery unchanged (the basis for save + chain working with zero bridge code):

```js
import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { isNativeProseNodeName, proseChainHits } from '../src/static/block-kinds.js'

describe('proseGroup is routed as native prose (the linchpin)', () => {
  it('isNativeProseNodeName("proseGroup") is true (so save/chain/identity treat it as prose)', () => {
    expect(isNativeProseNodeName('proseGroup')).toBe(true)
    // contrast: a sieve-* node is NOT native prose
    expect(isNativeProseNodeName('sieve-ai-block')).toBe(false)
  })
})

describe('proseChainHits matches a proseGroup container', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block', content: 'inline*', attrs: { id: { default: '' } },
        toDOM: (n) => ['p', { 'data-id': n.attrs.id }, 0],
      },
      proseGroup: {
        group: 'block', content: 'block+', attrs: { id: { default: '' } },
        toDOM: (n) => ['div', { 'data-id': n.attrs.id, class: 'block-node prose-group' }, 0],
      },
      text: { group: 'inline' },
    },
  })

  it('returns the container range when its id is in the chain', () => {
    const inner = schema.nodes.paragraph.create({}, schema.text('answer'))
    const group = schema.nodes.proseGroup.create({ id: 'ai-d63e' }, inner)
    const doc = schema.nodes.doc.create({}, group)
    const hits = proseChainHits(doc, ['ai-d63e'])
    expect(hits.length).toBe(1)
    expect(hits[0].id).toBe('ai-d63e')
    expect(hits[0].from).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail (or pass) for the RIGHT reason**

Run: `cd frontend && npx vitest run test/prose-group-paths.test.js`
Expected: The `isNativeProseNodeName` test PASSES immediately (the function already returns true for any non-`sieve-*` name — this is the pin, not new behavior). The `proseChainHits` test should also PASS if `proseChainHits` already matches by `isNativeProseNodeName` + top-level + id. If either FAILS, that is a real gap in routing the container as prose — STOP and report; do not weaken the test.

> Note: this task's unit tests pin EXISTING behavior (the routing is structural, established in Tasks 1–2). Per TDD they confirm the linchpin holds; if they pass on first run that is expected and correct — the witness here is "the container is genuinely treated as prose," not "new code."

- [ ] **Step 3: Run the full vitest suite**

Run: `cd frontend && npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 4: Manual (in-app) acceptance — requires the running app**

> Requires the user to run the app. Hand this checklist to the user. These are the WebKit contentEditable behaviors that cannot be unit-tested (editability, keyboard, highlight, round-trip) — verify in the actual WebKitGTK app, not just a Chrome dev server.

Open a document with an embedded multi-node block (e.g. `ai-d63e`) and verify each:

1. **One block on load** — renders as ONE block: one root with a single `data-id` (the embed's id), no `pr-xxxx` fragments.
2. **Editable** — click inside; edit a child paragraph; text changes commit normally.
3. **Stays one block on internal edit** — Enter *inside* the container makes a new child paragraph; the block remains ONE block (still one `data-id`, no newly minted ids).
4. **Escapes to a sibling at the boundary** — Enter on an empty trailing line escapes to a NEW native sibling prose block; the container stays intact as one block (it never splits into two containers).
5. **Round-trips on save** — saved markdown contains exactly ONE `<!--s:<id>-->…multi-node…<!--/s:<id>-->` block with the original id preserved (NOT `pr-xxxx` fragments, NOT split markers).
6. **Stable on reload** — reopen the doc: still ONE block, byte-stable (no mutation on load, no re-mint).
7. **Chain-active styling** — hover/activate the AI ref-chain that includes this block: the container ROOT receives the chain-active accent (the `.block-node[data-id]` styling), like any other block.
8. **Highlights work** — select text inside a child and apply `==highlight==`; it renders and round-trips. The selection-highlight decoration works inside the container.

If any of 1–8 fails: for 3/4 specifically (the one-id invariant under keyboard), the remedy is a single declarative schema flag on `proseGroup` (`defining: true` and/or `isolating: true`) — add the minimal flag that restores the invariant, document which and the behavior that forced it, and re-run this checklist. Do NOT add a keymap.

- [ ] **Step 5: Commit**

```bash
git add frontend/test/prose-group-paths.test.js
git commit -m "Pin proseGroup prose-path routing (isNativeProseNodeName + proseChainHits); in-app acceptance for E-1 embed fix"
```

---

## Post-Plan: tech-debt + close-out

After Task 3 passes (including in-app acceptance), update `docs/TECH-DEBT.md`: mark **E-1** (embed broken / multi-node) RESOLVED by the `proseGroup` container render, and note that the fix is backend-authoritative-by-construction (no `nested` flag, content-derived) so it does NOT depend on **B-A** (which remains deferred to its own branch). This is the second of the two delivery-critical close-out items in `docs/design/archive/plans/2026-06-17-block-document-model.md` (the first, legacy goldmark cleanup, is already done). After this, the branch is ready for the final whole-branch review and `finishing-a-development-branch`.
