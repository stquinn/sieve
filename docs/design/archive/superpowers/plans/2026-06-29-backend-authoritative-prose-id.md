# Backend-Authoritative Prose Id (retire B-A) Implementation Plan

> **STATUS — ✅ COMPLETE (closed out 2026-06-30; user-verified in-app).** Shipped via the `token → mint → ack` round-trip on `feature/backend-authoritative-prose-id` (merged to `main`, fast-forward to `8ca1f93`). `mintProseId`/`mintActions` retired; `dedupeActions` is the split defense; the observer skips + baseline-pins in-flight tokens; the `insert-block` ack swaps token→id (tracked, undo-safe). Tech-debt **B-A RESOLVED**; this also enforces **E-1's root principle** (identity never invented on the frontend) for typed prose, and the `proseidentity-loop.test.js` rewrite (**C-T**) landed here. Executed via SDD — 9 tasks + a final whole-branch review (caught the in-flight edit-loss gap) + 3 in-app-smoke fixes, each two-stage reviewed: (1) `block-node` padding keys on `id||token` (no reflow when the id acks); (2) structural empty paragraphs reconciled with main's persist-structural-blanks feature (a structural blank is a real block; only the trailing surface stays bare); (3) **`proseGroup` carries the transient `token` attr** — the multi-node-split data-loss fix (the container held an id but not a token, so the stamp was dropped and the split half orphaned). Go suite + vitest green (157/157 JS).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend-minted durable prose id (`mintProseId`) with a backend-authoritative `create-block → mint → ack` round-trip, so the frontend never invents durable block identity.

**Architecture:** A new prose block, when it first gains content, is stamped with a *transient correlation token* (`tok-…`, never persisted), marked pending, and sent on `create-block` with **no** blockId. Go's existing `GenerateBlockIDFor` mints the durable id; the WS render-back (`insert-block`) echoes the token; the frontend swaps the token for the backend id and clears pending. The debounced observer skips pending (in-flight) nodes; the identity plugin no longer mints durable ids — on a `splitBlock` attr-copy it *clears* the duplicated id/token (the new half re-acquires a token → one create round-trip). This also retires E-1's root principle: identity is never invented on the frontend, and a load never posts a mutation.

**Tech Stack:** Go (chi, gorilla/websocket) + vanilla JS + TipTap 2 (ProseMirror) + vitest. Backend is the document source of truth.

## Global Constraints

- **This work goes on its own branch** `feature/backend-authoritative-prose-id`. B-A lives in the highest-churn area of the editor (two prior reverts — see TECH-DEBT B-A "Why deferred"); isolate it.
- **Backend is the document source of truth.** The frontend places the server's node / applies the server's id; it NEVER invents durable identity. A transient `tok-…` correlation token is NOT identity — it is discarded on ack. (memory `feedback_backend_is_doc_source_of_truth`.)
- **A LOAD never posts a mutation.** Honour the existing `aiReloadInProgress` flag (`editor.js:20`) and the loaded-node-carries-its-id invariant: `renderBlocksIntoEditor` stamps each loaded block's id, so the identity plugin must never stamp a token onto a node that already carries an id.
- **Never full-reload (`softReloadContent`) for an operation** — it wipes undo history (`replaceWith + addToHistory:false`). Token-id application is a tracked, history-EXCLUDED `setNodeMarkup` on the existing node, never a re-insert.
- **No new npm dependencies.** Vanilla JS only.
- **Tests live with the type they exercise.** Pure JS decisions go in `frontend/test/*.test.js` (vitest); Go white-box tests in `sieve/services/*_test.go`.
- **`user_intent` is user-owned** — untouched by this work.
- This also retires **E-1's root principle** (identity never invented on the frontend); E-1's `proseGroup` container is already backend-authoritative by construction and must keep working unchanged (it carries a backend id on load, so the identity plugin leaves it alone).
- Token format is pinned: `tok-` prefix. `block-sync.js` distinguishes a pending token from a durable id solely by this prefix.

---

## Current Mint Flow (investigation, verified against live code 2026-06-29)

This is the flow being retired. Cited precisely so the implementer can see exactly what changes.

1. **Frontend mints the durable id.** `frontend/src/static/prose-block.js:47`:
   ```js
   var mintProseId = function () { return 'pr-' + Math.random().toString(16).slice(2, 6) }
   ```
   The `BlockId` TipTap extension (`prose-block.js:49-120`) adds a global `id` attr to the prose node types (`prose-block.js:32-36`, `PROSE_NODE_TYPES`) bound to `data-id` (`prose-block.js:55-67`). Its `blockIdMint` ProseMirror plugin (`prose-block.js:81-118`) runs in `appendTransaction` (history-excluded, runaway-guarded) and, on a doc change, collects every top-level prose node's `id` (`prose-block.js:98-102`), calls `window.TipTap.mintActions(ids)` (`block-sync.js:94`) to find indices that are empty OR a duplicate-second-occurrence, and `setNodeMarkup`s a fresh `mintProseId()` onto each (`prose-block.js:109-114`).

2. **`mintActions`** (`block-sync.js:94-103`) returns indices where the id is empty (`!id`) OR already seen (`seen[id]`) — the latter is the splitBlock attr-copy trap (Enter copies attrs → new half born with the original's id). The first occurrence keeps its id; the duplicate is re-minted.

3. **The observer sends the minted id as the durable blockId.** `editor.js` `onUpdate` (`editor.js:563-578`) arms a 500 ms debounce → `syncDocument` (`editor.js:316-322`) → `collectTopBlocks` → `topBlockTriple` (`editor.js:260-267`, reads `node.attrs.id`) → `window.TipTap.computeBlockSync(curr, blockContentCache)` (`block-sync.js:105-147`). For a prose id present in `curr` but not in `prev`, it emits `proseOp('create-block', p, k)` (`block-sync.js:42-44, 134`), i.e. `blockOp('create-block', b.id, 'prose', {content}, aliases, index)` (`block-sync.js:33-38`) — **the frontend-minted id is the durable blockId on the wire.** Sent as `{type:'block-op', uuid, op}` (`editor.js:321`).

4. **Go honours the frontend id (the inconsistency).** `EditorService.HandleBlockOp` (`editor_service.go:226-256`) `create-block` case (`editor_service.go:228-241`): `id := op.BlockID; if id == "" { id = block.GenerateBlockIDFor(op.Kind) }` then `createBlockWithID`. Because the frontend supplied an id, Go uses it verbatim. Only structured blocks get a backend id (`GenerateBlockIDFor`, the `CreateBlock`/paste paths). **The backend mint floor already exists** (line 237) — it just never triggers for prose because op.BlockID is non-empty.

5. **Render-back is a prose no-op today.** `createBlock` (`editor_service.go:443-479`) → `notifyBlockCreated` (`editor_service.go:53-68`) → `OnBlockCreated` (`ws_handler.go:240-254`) emits `insert-block {kind,id,attrs,index,markdown}`. The frontend `editor:insert-block` handler (`editor.js:909-957`) does insert-if-absent: a node with that `data-id` already exists (the user typed it), so it baselines via `noteServerBlock` (`editor.js:619-628`) and returns (`editor.js:937-940`).

6. **The splitBlock duplicate-id trap** (memory `project_node_granular_prose`): `splitBlock` copies attrs → the new node is born with the original's id; current code RE-MINTS it (`prose-block.js:109-114`). The new design CLEARS it instead.

7. **E-1 interplay** (TECH-DEBT E-1, RESOLVED 2026-06-21 via `proseGroup`): a multi-node backend block renders as ONE `proseGroup` container node carrying the backend id, so the mint plugin never re-mints it. E-1's *root* principle ("the frontend re-mints a backend-authored block's id when it fragments") is what B-A's retirement generalises: **no frontend durable mint at all.**

### Positioning is already done — out of scope

Per TECH-DEBT B-A "Progress 2026-06-21": the positioned single create path exists. UI/AI/extract emit one `block-op {create-block, kind, attrs, index}` through `HandleBlockOp`; the legacy `create-block` WS message + `handleCreateBlock` + the `SetBlock`-append second path are retired. **Do NOT re-plan positioning or the op envelope.** This plan changes ONLY the prose id authority (the token→mint→ack round-trip).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `frontend/src/static/block-sync.js` | Pure diff core + minting decisions | Add `dedupeActions`; teach `computeBlockSync` the token (pending) create + skip + delete-skip; extend `proseOp` to carry a token. Retire `mintActions`. |
| `frontend/src/static/prose-block.js` | Prose identity extension + plugin | Delete `mintProseId`; add transient `token` global attr (`rendered:false`); rewrite the `blockIdMint` plugin to stamp a token (not a durable id) on content-bearing id-less prose, and CLEAR duplicate ids/tokens on split. |
| `frontend/src/static/editor.js` | Editor island: observer drive, WS, ack | `topBlockTriple` surfaces `token`; `editor:insert-block` handler swaps token→backend id (tracked, history-excluded) and reconciles the sync cache; deleted-in-flight emits a real-id delete. |
| `sieve/block/shadow_document.go` | `BlockOp` wire type | Add `Token string \`json:"token,omitempty"\``. |
| `sieve/block/processor_registry.go` | `BlockLifecycleListener` | `OnBlockCreated` gains a trailing `token string` param. |
| `sieve/services/editor_service.go` | Create lifecycle | Thread `op.Token` from `HandleBlockOp` → `createBlock` → `notifyBlockCreated` → `OnBlockCreated`. |
| `requesthandlers/ws_handler.go` | WS render-back | `OnBlockCreated` echoes `token` in the `insert-block` payload. |
| `sieve/services/editor_service_test.go` | White-box Go test + mock listener | Update `mockLifecycleListener.OnBlockCreated` signature; add token round-trip test. |
| `frontend/test/block-sync.test.js` | Pure JS tests | Add `dedupeActions` + token-flow cases; retire `mintActions` cases. |
| `frontend/test/proseidentity-loop.test.js` | Plugin contract / loop-stability harness | Rewrite to the token→stamp / dedupe-clear / convergence contract (deferred here from close-out Task 3; also addresses TECH-DEBT C-T). |

---

## The pinned token→mint→ack design (end to end)

**Pending state:** a prose node is *pending* iff it carries a `token` attr and an empty `id` attr. The token is the only marker — no side map needed to answer "is this pending".

1. **Stamp (frontend plugin).** On a doc change, for each top-level prose node with empty `id` AND empty `token` AND real content, the identity plugin stamps `token = mintToken()` (`'tok-' + Math.random().toString(16).slice(2,10)`), history-excluded. It NEVER fills the durable `id`. On a split (duplicate id or duplicate token), it CLEARS the second occurrence's id/token to `''` (reuse the dedupe detection) so the new half re-acquires its own token next pass. Convergent (only fills/clears attrs, creates no nodes); runaway guard retained.

2. **Emit (observer, pure).** `computeBlockSync` sees a pending node (token, no id) whose token is NOT yet baselined → emits ONE `create-block {kind:'prose', attrs:{content}, index, token}` (no `blockId`), and baselines the token (`next[token]=sig`). A pending node whose token IS baselined (in flight) → **skipped** (no create, no update). A node with a durable id behaves as today (update on sig change).

3. **Mint (Go).** `HandleBlockOp` create-block with `op.BlockID==""` → `GenerateBlockIDFor("prose")` (already exists, `editor_service.go:237`). The lifecycle runs unchanged; `op.Token` is threaded to the render-back.

4. **Ack (WS).** `OnBlockCreated` echoes the token: `insert-block {kind,id,attrs,index,markdown,token}`.

5. **Apply + clear pending (frontend).** The `editor:insert-block` handler, when `msg.token` is set, finds the prose node whose `attrs.token === msg.token`, and `setNodeMarkup`s `{id: msg.id, token: ''}` (tracked, `addToHistory:false`). It reconciles the sync cache: `blockContentCache[msg.id] = blockContentCache[token]; delete blockContentCache[token]` — so an edit made *during* the flight surfaces as `update-block {msg.id}` on the next pass (no lost edit), and the token key never looks "deleted". It does NOT insert (the node exists). If the node is gone (deleted in flight), it emits `block-op {delete-block, blockId: msg.id}` and drops the token key.

6. **Delete-skip (observer).** The delete loop skips `tok-`-prefixed baseline keys (an in-flight token is not a backend id — deleting it would 404). A genuine pending delete is handled by the ack's deleted-in-flight branch (step 5).

This satisfies "create carries a transient token, marks pending; Go mints; WS acks token→id; frontend applies + clears pending; observer skips pending; split clears the copied id."

---

### Task 1: `dedupeActions` — duplicate-only detection (split defense)

**Files:**
- Modify: `frontend/src/static/block-sync.js:85-103` (alongside `mintActions`)
- Test: `frontend/test/block-sync.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function dedupeActions(ids: string[]): number[]` — returns the indices of the 2nd-and-later occurrences of any **non-empty** id. Empty ids are NOT flagged (they are legitimately id-less/pending). Used by `prose-block.js` (Task 5) to clear split-copied ids/tokens.

- [ ] **Step 1: Write the failing test**

Add to `frontend/test/block-sync.test.js` (import `dedupeActions` on line 2):
```js
import { computeBlockSync, seedBaseline, dedupeActions, proseOp, updateBlockOp } from '../src/static/block-sync.js'

describe('dedupeActions', () => {
  it('returns nothing when every id is unique and non-empty', () => {
    expect(dedupeActions(['pr-1', 'pr-2', 'pr-3'])).toEqual([])
  })
  it('does NOT flag empty ids (they are legitimately pending — no frontend mint)', () => {
    expect(dedupeActions(['pr-1', '', 'pr-3', ''])).toEqual([])
  })
  it('flags the DUPLICATE second occurrence — the splitBlock attr-copy trap', () => {
    expect(dedupeActions(['pr-1', 'pr-1'])).toEqual([1])
  })
  it('flags every later duplicate, first occurrence always kept', () => {
    expect(dedupeActions(['pr-1', 'pr-2', 'pr-1', 'pr-2', 'pr-2'])).toEqual([2, 3, 4])
  })
  it('flags duplicate tokens too (split copies a pending token)', () => {
    expect(dedupeActions(['tok-aa', 'tok-aa'])).toEqual([1])
  })
  it('is empty for an empty list', () => {
    expect(dedupeActions([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run test/block-sync.test.js -t dedupeActions`
Expected: FAIL — `dedupeActions is not a function` (and the import would also break the file; that is expected RED).

- [ ] **Step 3: Write minimal implementation**

In `frontend/src/static/block-sync.js`, add after `mintActions` (line 103):
```js
// dedupeActions is the split-defense decision: given the identity values (ids or
// tokens) of the top-level prose nodes in document order, return the INDICES of
// the 2nd-and-later occurrences of any NON-EMPTY value. ProseMirror's Enter copies
// the split node's attrs, so the new half is born carrying the original's id/token;
// the first occurrence keeps it, every later duplicate is CLEARED (not re-minted —
// the frontend never invents durable identity). Empty values are left untouched:
// an id-less node is legitimately pending (it acquires a token, then a backend id).
export function dedupeActions(values) {
  var seen = {}
  var dup = []
  for (var i = 0; i < (values || []).length; i++) {
    var v = values[i]
    if (!v) continue
    if (seen[v]) { dup.push(i); continue }
    seen[v] = true
  }
  return dup
}
```
And export it on the window shim (after `block-sync.js:153`):
```js
  window.TipTap.dedupeActions = dedupeActions
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run test/block-sync.test.js -t dedupeActions`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/block-sync.js frontend/test/block-sync.test.js
git commit -m "feat(block-sync): dedupeActions — duplicate-only split defense (no empty-fill)"
```

---

### Task 2: `computeBlockSync` token create + pending skip

**Files:**
- Modify: `frontend/src/static/block-sync.js:33-44` (`proseOp`), `:63-65` (`isPendingEmptyProse`), `:105-147` (`computeBlockSync`)
- Test: `frontend/test/block-sync.test.js`

**Interfaces:**
- Consumes: triple shape `{ id, kind, content?, aliases?, token? }` (prose may carry `token` from `editor.js` Task 4).
- Produces:
  - `proseOp(type, b, index)` — for `create-block`, includes `op.token = b.token` when present; `op.blockId` is `b.id || ''` (empty for a pending create → Go mints).
  - `computeBlockSync(curr, prev)` — a pending prose node (`token`, no `id`) whose token is not in `prev` emits `create-block {kind:'prose', attrs:{content}, index, token}` (no real blockId) and baselines the token; a pending node whose token IS in `prev` emits nothing (in flight).

- [ ] **Step 1: Write the failing test**

Add to `frontend/test/block-sync.test.js`:
```js
describe('computeBlockSync — token (backend-authoritative) prose create', () => {
  it('emits create-block with a token and NO durable blockId for a pending prose node', () => {
    const r = computeBlockSync([{ id: '', token: 'tok-aa', kind: 'prose', content: 'hi' }], {})
    expect(r.ops).toEqual([
      { type: 'create-block', blockId: '', kind: 'prose', attrs: { content: 'hi' }, index: 0, token: 'tok-aa' },
    ])
    expect(r.next).toHaveProperty('tok-aa') // token baselined so it is not re-emitted
  })

  it('SKIPS a pending node whose token is already in flight (baselined) — no duplicate create, no update', () => {
    const base = computeBlockSync([{ id: '', token: 'tok-aa', kind: 'prose', content: 'hi' }], {}).next
    const r = computeBlockSync([{ id: '', token: 'tok-aa', kind: 'prose', content: 'hi EDITED in flight' }], base)
    expect(r.ops).toEqual([]) // held until the backend acks the id
  })

  it('a node that has acquired a backend id updates by that id (post-ack)', () => {
    // ack swapped the cache key tok-aa -> pr-9 (editor.js); the node now carries id pr-9.
    const prev = { 'pr-9': 'prose\x00hi\x00' }
    const r = computeBlockSync([{ id: 'pr-9', kind: 'prose', content: 'hi there' }], prev)
    expect(r.ops).toEqual([{ type: 'update-block', blockId: 'pr-9', kind: 'prose', attrs: { content: 'hi there' } }])
  })

  it('a tokenless, idless empty surface is still skipped and not baselined', () => {
    const r = computeBlockSync([{ id: '', kind: 'prose', content: '' }], {})
    expect(r.ops).toEqual([])
    expect(r.next).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run test/block-sync.test.js -t "token"`
Expected: FAIL — the first case emits nothing (pending tokens are not handled yet) / `next` lacks `tok-aa`.

- [ ] **Step 3: Write minimal implementation**

In `block-sync.js`, replace `proseOp` (lines 42-44):
```js
// proseOp builds a create/update op for a prose block. Prose's body rides in
// attrs.content. A pending CREATE carries a transient correlation TOKEN (not a
// durable id) and an empty blockId, so Go mints the durable id and echoes the
// token back (insert-block). update/loaded nodes carry their durable id.
function proseOp(type, b, index) {
  var op = blockOp(type, b.id || '', 'prose', { content: b.content || '' }, b.aliases, index)
  if (type === 'create-block' && b.token) op.token = b.token
  return op
}
```
Export `proseOp` (so Task 2's third test and future tests can import it — add to the export list / window shim if not already; it is currently module-private). Add `export` to its declaration:
```js
export function proseOp(type, b, index) {
```
Replace the `next`-building loop and the prose op loop in `computeBlockSync` (lines 107-138) with:
```js
  var next = {}
  for (var i = 0; i < curr.length; i++) {
    var cb = curr[i]
    var key = cb.id || cb.token   // durable id once acked, else the in-flight token
    if (!key) continue            // an id-less, token-less surface — not addressable
    if (isPendingEmptyProse(cb, prev)) continue
    next[key] = blockSig(cb)
  }

  if (!prev) return { ops: [], next: next }

  var ops = []
  for (var k = 0; k < curr.length; k++) {
    var p = curr[k]
    if (p.kind !== 'prose') continue
    if (p.id) {
      // A node with a durable id: created already (in prev) → update on change.
      if (!(p.id in next)) continue
      if (!(p.id in prev)) ops.push(proseOp('create-block', p, k))
      else if (prev[p.id] !== next[p.id]) ops.push(proseOp('update-block', p, k))
    } else if (p.token) {
      // Pending: emit ONE create carrying the token; skip while it is in flight.
      if (!(p.token in next)) continue       // empty pending surface, not baselined
      if (!(p.token in prev)) ops.push(proseOp('create-block', p, k))
      // p.token in prev → in flight, awaiting the backend id → SKIP.
    }
  }
```
Update `isPendingEmptyProse` (lines 63-65) so a content-less pending node keyed by token is also treated as not-a-real-block (it should never be baselined or emitted):
```js
function isPendingEmptyProse(b, prev) {
  var key = b.id || b.token
  return b.kind === 'prose' && !(b.content && b.content.length) && !(prev && key && key in prev)
}
```
(The delete loop at lines 141-145 is changed in Task 3.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run test/block-sync.test.js`
Expected: PASS for the new `token` describe AND the existing `computeBlockSync` describe (no regressions). Note: the existing test "a brand-new EMPTY prose block is not synced until it has content" (`block-sync.test.js:237-245`) keys on `id` with no token — still valid (a node with an `id` and content but not in prev still creates; this is the loaded/seeded-empty path, not the fresh-typed path).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/block-sync.js frontend/test/block-sync.test.js
git commit -m "feat(block-sync): token-carrying prose create + in-flight pending skip"
```

---

### Task 3: Observer delete-loop skips in-flight tokens

**Files:**
- Modify: `frontend/src/static/block-sync.js:141-145` (delete loop)
- Test: `frontend/test/block-sync.test.js`

**Interfaces:**
- Consumes: `prev` baseline keys may be `tok-…` tokens (in-flight) or durable ids.
- Produces: `computeBlockSync` emits `delete-block` only for durable ids that disappeared, never for a `tok-…` key (an in-flight create has no backend id to delete; the ack's deleted-in-flight branch handles that case in `editor.js`).

- [ ] **Step 1: Write the failing test**

Add to `frontend/test/block-sync.test.js`:
```js
describe('computeBlockSync — delete loop ignores in-flight tokens', () => {
  it('does NOT emit delete-block for a tok- baseline key that vanished (no backend id yet)', () => {
    const prev = { 'tok-aa': 'prose\x00hi\x00' } // create in flight, node then removed
    const r = computeBlockSync([], prev)
    expect(r.ops).toEqual([]) // the insert-block ack handles a deleted-in-flight node by real id
  })
  it('still emits delete-block for a durable id that disappeared', () => {
    const prev = { 'pr-1': 'prose\x00A\x00' }
    const r = computeBlockSync([], prev)
    expect(r.ops).toEqual([{ type: 'delete-block', blockId: 'pr-1' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run test/block-sync.test.js -t "in-flight tokens"`
Expected: FAIL — the first case emits `{type:'delete-block', blockId:'tok-aa'}` (the loop does not yet skip tokens).

- [ ] **Step 3: Write minimal implementation**

In `block-sync.js`, replace the delete loop (lines 141-145):
```js
  // Deletes are kind-agnostic, BUT an in-flight token (tok-…) is not a backend id —
  // deleting it would 404. A node deleted while its create is in flight is handled
  // by the insert-block ack (it deletes by the real id once known).
  for (var id in prev) {
    if (id.indexOf('tok-') === 0) continue
    if (!(id in next)) ops.push({ type: 'delete-block', blockId: id })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run test/block-sync.test.js`
Expected: PASS (whole file green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/block-sync.js frontend/test/block-sync.test.js
git commit -m "feat(block-sync): delete loop ignores in-flight tok- keys"
```

---

### Task 4: Go — `BlockOp.Token` threaded to the `insert-block` render-back

**Files:**
- Modify: `sieve/block/shadow_document.go:221-232` (`BlockOp`)
- Modify: `sieve/block/processor_registry.go:182-189` (`BlockLifecycleListener`)
- Modify: `sieve/services/editor_service.go:53-68` (`notifyBlockCreated`), `:226-241` (`HandleBlockOp`), `:443-479` (`createBlock` + `createBlockWithID`)
- Modify: `requesthandlers/ws_handler.go:240-254` (`OnBlockCreated`)
- Test: `sieve/services/editor_service_test.go:513-531` (mock listener) + a new test

**Interfaces:**
- Consumes: `op.Token` from the wire (`block-op`).
- Produces:
  - `BlockOp.Token string` (`json:"token,omitempty"`).
  - `BlockLifecycleListener.OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string)`.
  - `insert-block` WS payload gains `"token": token`.
  - A `create-block` op with empty `BlockID` + a `Token` mints the durable id (`GenerateBlockIDFor`) and echoes the token back unchanged.

- [ ] **Step 1: Write the failing test**

First update the existing mock listener (`editor_service_test.go:521-525`) to the new signature (a compile prerequisite — the test file will not build until both the interface and the mock match; that is the RED):
```go
func (l *mockLifecycleListener) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string) {
	if l.onCreated != nil {
		l.onCreated(uuid, kind, blockID, markdown)
	}
}
```
Then add a token round-trip test (uses the prose processor; reuse the test helpers already in this file — `newTestDocumentService`, `resetRegistry`, `NewEditorService`):
```go
func TestHandleBlockOp_proseCreateMintsIdAndEchoesToken(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewProseProcessor())

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Hour)
	doc, _ := ds.Create()
	_ = es.Open(doc.UUID(), nil)

	var gotID, gotToken string
	es.SetLifecycleListener(&mockLifecycleListener{})
	// capture token via a dedicated listener
	cap := &tokenCaptureListener{}
	es.SetLifecycleListener(cap)

	err := es.HandleBlockOp(doc.UUID(), block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: "", Token: "tok-abc",
		Attrs: map[string]interface{}{"content": "hello"}, Index: 0,
	})
	if err != nil {
		t.Fatalf("HandleBlockOp: %v", err)
	}
	gotID, gotToken = cap.id, cap.token
	if gotToken != "tok-abc" {
		t.Fatalf("token not echoed: got %q want tok-abc", gotToken)
	}
	if gotID == "" || strings.HasPrefix(gotID, "tok-") {
		t.Fatalf("expected a backend-minted durable id, got %q", gotID)
	}
}

type tokenCaptureListener struct{ id, token string }

func (l *tokenCaptureListener) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string) {
	l.id, l.token = blockID, token
}
func (l *tokenCaptureListener) OnBlockUpdated(uuid, blockID string, attrs map[string]interface{}) {}
func (l *tokenCaptureListener) OnBlockReplaced(uuid, oldID, newKind, newID string, attrs map[string]interface{}, markdown string) {
}
```
(Confirm the prose processor constructor name with `grep -rn "func NewProseProcessor" sieve/block/processors/` and the existing `import "strings"` in the test file before running; adjust the import if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./sieve/services/ -run TestHandleBlockOp_proseCreateMintsIdAndEchoesToken`
Expected: FAIL — compile error: `BlockOp has no field Token` and `OnBlockCreated` arity mismatch in `ws_handler.go`.

- [ ] **Step 3: Write minimal implementation**

`shadow_document.go` — add to `BlockOp` (after line 231):
```go
	// Token is a TRANSIENT frontend correlation handle (tok-…) for a prose create —
	// NOT a durable id. Go mints the durable id (GenerateBlockIDFor) and echoes the
	// token back on insert-block so the client can swap its pending node's token for
	// the authoritative id. Never persisted.
	Token string `json:"token,omitempty"`
```
`processor_registry.go` — change the interface (line 183):
```go
	OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string)
```
`editor_service.go` — `HandleBlockOp` create case (line 239) pass the token through a new `createBlock` param:
```go
			_, _, err := es.createBlock(uuid, op.Kind, id, op.Attrs, op.Aliases, op.Index, true, op.Token)
			return err
```
`createBlockWithID` (line 434-436) passes an empty token:
```go
func (es *EditorService) createBlockWithID(uuid, kind, blockID string, overrides map[string]interface{}, aliases []string, index int) (id string, rawYaml string, err error) {
	return es.createBlock(uuid, kind, blockID, overrides, aliases, index, true, "")
}
```
`createBlock` (line 443) gains a `token string` param and forwards it:
```go
func (es *EditorService) createBlock(uuid, kind, blockID string, overrides map[string]interface{}, aliases []string, index int, notify bool, token string) (id string, rawYaml string, err error) {
```
and (line 475):
```go
	if notify {
		es.notifyBlockCreated(uuid, sieveBlock, index, token)
	}
```
`notifyBlockCreated` (line 53) gains `token string` and forwards it (line 66):
```go
func (es *EditorService) notifyBlockCreated(uuid string, blk block.SieveBlock, index int, token string) {
	...
		l.OnBlockCreated(uuid, blk.Kind, blk.ID, blk.Attrs, markdown, index, token)
	...
}
```
`ws_handler.go` — `OnBlockCreated` (line 240):
```go
func (h *WsHandler) OnBlockCreated(uuid, kind, blockID string, attrs map[string]interface{}, markdown string, index int, token string) {
	h.channelsMu.RLock()
	writeMsg, ok := h.channels[uuid]
	h.channelsMu.RUnlock()
	if ok {
		writeMsg(map[string]interface{}{
			"type":     "insert-block",
			"kind":     kind,
			"id":       blockID,
			"attrs":    attrs,
			"index":    index,
			"markdown": markdown,
			"token":    token, // transient correlation handle echoed for the pending-prose swap
		})
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go build ./... && go test ./sieve/services/ -run TestHandleBlockOp_proseCreateMintsIdAndEchoesToken`
Then the full Go suite: `go test ./...`
Expected: PASS, no compile errors (all `OnBlockCreated` implementers — `ws_handler.go`, `editor_service_test.go` mock — updated).

- [ ] **Step 5: Commit**

```bash
git add sieve/block/shadow_document.go sieve/block/processor_registry.go sieve/services/editor_service.go sieve/services/editor_service_test.go requesthandlers/ws_handler.go
git commit -m "feat(block): BlockOp.Token threaded to insert-block render-back (backend mints prose id)"
```

---

### Task 5: Frontend wiring — `topBlockTriple` token + `editor:insert-block` token ack

**Files:**
- Modify: `frontend/src/static/editor.js:260-267` (`topBlockTriple`), `:909-957` (`editor:insert-block` handler)
- Verification: in-app (no editor.js unit harness exists — editor.js is an IIFE; see Task 7). Pure pieces it relies on are covered by Tasks 1-3.

**Interfaces:**
- Consumes: `block-sync.js` `computeBlockSync` (token-aware, Task 2), `insert-block` WS payload `{token}` (Task 4).
- Produces: prose triples now carry `token: node.attrs.token || ''`; the `editor:insert-block` handler applies `msg.id` onto the pending node matched by `msg.token`, reconciles `blockContentCache`, and never inserts a duplicate.

- [ ] **Step 1: Update `topBlockTriple` to surface the token**

In `editor.js`, replace the prose return (line 265-266):
```js
      var content = (window.TipTap.serializeNode(ed, node) || '').trim()
      return { id: node.attrs.id || '', kind: 'prose', content: content, token: node.attrs.token || '' }
```

- [ ] **Step 2: Add the token-ack branch to the `editor:insert-block` handler**

In `editor.js`, inside the `editor:insert-block` listener (after the markdown-mode early return at line 917, before the `if (!currentEditor) return` is fine; place after `if (!currentEditor) return` at line 918) add:
```js
    // Backend-authoritative prose id (B-A): the create carried a transient token and
    // no durable id; Go minted the id and echoed the token. Swap the pending node's
    // token for the authoritative id (tracked, history-excluded — never a re-insert),
    // reconcile the sync cache (so a flight-edit becomes update-block by the new id,
    // and the token key never reads as a delete), and DO NOT insert (the node exists).
    if (msg.token) {
      var ed = currentEditor, foundPos = -1
      ed.state.doc.forEach(function (node, pos) {
        if (foundPos < 0 && node.attrs && node.attrs.token === msg.token) foundPos = pos
      })
      if (foundPos >= 0) {
        var node = ed.state.doc.nodeAt(foundPos)
        var tr = ed.state.tr.setNodeMarkup(foundPos, undefined,
          Object.assign({}, node.attrs, { id: msg.id, token: '' }))
        tr.setMeta('addToHistory', false)
        ed.view.dispatch(tr)
        if (blockContentCache && (msg.token in blockContentCache)) {
          blockContentCache[msg.id] = blockContentCache[msg.token]
          delete blockContentCache[msg.token]
        } else if (typeof noteServerBlock === 'function') {
          noteServerBlock(msg.id)
        }
      } else {
        // Deleted while the create was in flight — Go has a block we can't see.
        // Delete it by the authoritative id and drop the stale token baseline.
        wsSend({ type: 'block-op', uuid: currentUuid, op: { type: 'delete-block', blockId: msg.id } })
        if (blockContentCache) delete blockContentCache[msg.token]
      }
      return
    }
```
Note: `blockContentCache` and `noteServerBlock` are in `mountWysiwyg` scope, while the `editor:insert-block` listener is at module scope (`editor.js:909`). Confirm scope: the listener references `currentEditor`, `currentUuid`, `noteServerBlock` (module-level `var noteServerBlock`, `editor.js:69`) — all module-visible. `blockContentCache` is mountWysiwyg-private. **Resolve this before writing:** expose the cache reconcile via the existing `noteServerBlock` closure by extending it, OR add a module-level `var reconcilePendingToken = null` set inside `mountWysiwyg` (mirroring `noteServerBlock`/`docSyncFlush`, `editor.js:69, 609, 619`). Use the module-level seam:

In `mountWysiwyg` (next to `noteServerBlock`, after line 628) add:
```js
    // reconcilePendingToken swaps a pending prose node's token baseline for the
    // backend id in the sync cache (called by the insert-block token ack at module
    // scope, which cannot see blockContentCache). A flight-edit then surfaces as an
    // update-block keyed on the real id; the token key never reads as a delete.
    reconcilePendingToken = function (token, id) {
      if (!blockContentCache) return
      if (token in blockContentCache) {
        blockContentCache[id] = blockContentCache[token]
        delete blockContentCache[token]
      } else {
        noteServerBlock(id)
      }
    }
```
and declare it module-level beside `noteServerBlock` (line 69):
```js
  var reconcilePendingToken = null
```
Then in the handler replace the inline cache block with:
```js
        if (typeof reconcilePendingToken === 'function') reconcilePendingToken(msg.token, msg.id)
```

- [ ] **Step 3: Verify the build loads (no unit test for editor.js)**

Run: `cd frontend && npx vitest run` (the whole JS suite must stay green — Tasks 1-3 cover the pure logic this wiring drives).
Then a syntax/load sanity check: `node --check frontend/src/static/editor.js`
Expected: vitest green; `node --check` prints nothing (valid JS).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/static/editor.js
git commit -m "feat(editor): apply backend prose id on insert-block token ack; reconcile sync cache"
```

---

### Task 6: `prose-block.js` — retire the durable mint, stamp a token, clear duplicates on split

**Files:**
- Modify: `frontend/src/static/prose-block.js:47` (delete `mintProseId`), `:49-120` (`BlockId` extension + plugin)
- Test: contract pinned by the rewritten harness in Task 7; in-app verified in Task 8.

**Interfaces:**
- Consumes: `window.TipTap.dedupeActions` (Task 1).
- Produces: prose nodes carry a transient `token` attr (`rendered:false` — never in HTML/markdown); the plugin stamps a token on content-bearing id-less-and-token-less prose and clears the 2nd occurrence of any duplicate id/token. It NEVER fills the durable `id`.

- [ ] **Step 1: Delete `mintProseId`, add `mintToken`**

In `prose-block.js`, replace line 47:
```js
  // A TRANSIENT correlation token (not a durable id): the frontend never invents
  // durable block identity (B-A). The token rides the create-block round-trip; Go
  // mints the durable id and the insert-block ack swaps it in (editor.js).
  var mintToken = function () { return 'tok-' + Math.random().toString(16).slice(2, 10) }
```

- [ ] **Step 2: Add the transient `token` global attribute**

In the `BlockId` extension's `addGlobalAttributes` (inside the `attributes` object, after the `id` attr block, `prose-block.js:55-66`), add:
```js
          token: {
            default: '',
            rendered: false, // transient correlation handle: never in HTML or markdown
          },
```

- [ ] **Step 3: Rewrite the plugin to stamp a token + clear split duplicates**

Replace the `appendTransaction` body (`prose-block.js:86-117`):
```js
        appendTransaction: function (trs, _oldState, newState) {
          var now = Date.now()
          if (now - last > 100) calls = 0
          last = now
          if (++calls > 100) {
            console.error('[blockId] RUNAWAY identity pass — disabling to avoid a freeze')
            return null
          }
          if (!trs.some(function (t) { return t.docChanged })) return null

          var isProse = window.TipTap.isNativeProseNodeName
          var ids = [], tokens = [], positions = []
          newState.doc.forEach(function (node, pos) {
            if (!isProse(node.type.name)) return // structured nodes own their id
            ids.push(node.attrs.id || '')
            tokens.push(node.attrs.token || '')
            positions.push(pos)
          })

          // Split defense: Enter copies attrs, so the new half is born with the
          // original's id AND token. CLEAR the 2nd occurrence of each (never re-mint —
          // the frontend invents no durable identity); the cleared half re-acquires a
          // fresh token below → its own create round-trip. First occurrence is kept.
          var clearId = {}, clearTok = {}
          window.TipTap.dedupeActions(ids).forEach(function (i) { clearId[i] = true })
          window.TipTap.dedupeActions(tokens).forEach(function (i) { clearTok[i] = true })

          var tr = null
          for (var idx = 0; idx < positions.length; idx++) {
            var pos = positions[idx]
            var node = newState.doc.nodeAt(pos)
            if (!node) continue
            var attrs = Object.assign({}, node.attrs)
            var changed = false
            if (clearId[idx]) { attrs.id = ''; changed = true }
            if (clearTok[idx]) { attrs.token = ''; changed = true }
            // Stamp a token on a content-bearing prose that has neither id nor token
            // (a freshly typed block). Empty surfaces stay bare (no churn); loaded /
            // acked nodes already carry an id, so they are left untouched — a LOAD
            // never triggers a create.
            if (!attrs.id && !attrs.token && node.textContent && node.textContent.length > 0) {
              attrs.token = mintToken(); changed = true
            }
            if (changed) {
              if (!tr) tr = newState.tr
              tr.setNodeMarkup(pos, undefined, attrs)
            }
          }
          if (!tr) return null
          tr.setMeta('addToHistory', false)
          return tr
        },
```
Note on convergence: stamping/clearing only fills or empties attrs (creates no nodes); a cleared duplicate gets ONE token next pass; a stamped node is then `id:'' token:set` so it is not re-stamped → the next pass finds nothing → converges (runaway guard remains as a backstop). Note on E-1: a `proseGroup` container loaded with a backend id has a non-empty `id`, so neither branch fires — it is never re-stamped (backend-authoritative by construction).

- [ ] **Step 4: Sanity-check the module loads**

Run: `node --check frontend/src/static/prose-block.js`
Expected: no output (valid JS). Full vitest still green: `cd frontend && npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/static/prose-block.js
git commit -m "feat(prose): retire mintProseId; stamp transient token, clear duplicate id/token on split"
```

---

### Task 7: Rewrite `proseidentity-loop.test.js` to the token contract

**Files:**
- Rewrite: `frontend/test/proseidentity-loop.test.js`
- Imports: `frontend/src/static/block-sync.js` (`dedupeActions`)

**Interfaces:**
- Consumes: `dedupeActions` (Task 1); mirrors `prose-block.js`'s new `appendTransaction` (Task 6) in an inline harness (the production plugin needs a full TipTap editor; this harness pins the LOGIC + loop-stability, exactly as the file does today for the old contract).

**Why:** the current file (`proseidentity-loop.test.js`, deferred here from close-out Task 3 and also flagged in TECH-DEBT C-T) pins the RETIRED contract — it mints a durable `pr-…` id (line 41 `mintProseId`, lines 53-58) and uses an obsolete `sieve-prose` container schema (lines 25-29). The B-A change rewrites that contract: the plugin stamps a transient `tok-…` token (never a durable id), clears split duplicates, and converges.

- [ ] **Step 1: Write the new harness test (RED — it imports `dedupeActions` and asserts the new contract)**

Replace the whole file with:
```js
import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { dedupeActions } from '../src/static/block-sync.js'

// Contract + loop-stability harness for prose-block.js's identity appendTransaction
// under the BACKEND-AUTHORITATIVE id model (B-A retired). The plugin:
//   - STAMPS a transient token (tok-…) on a content-bearing prose with no id+token;
//   - NEVER fills a durable id (Go mints it; the insert-block ack swaps it in);
//   - CLEARS the 2nd occurrence of any duplicate id/token (the splitBlock attr-copy
//     trap) so the new half re-acquires its own token → one create round-trip;
//   - CONVERGES (only fills/clears attrs, creates no nodes) — a runaway counter
//     turns a regression into a throw, not a frozen main thread.

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*',
      attrs: { id: { default: '' }, token: { default: '' } },
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
})
const n = schema.nodes
const mintToken = () => 'tok-' + Math.random().toString(16).slice(2, 10)

const LIMIT = 100
function identityPlugin(counter) {
  return new Plugin({
    key: new PluginKey('blockIdentity'),
    appendTransaction(trs, _oldState, newState) {
      counter.n++
      if (counter.n > LIMIT) throw new Error('blockIdentity never stabilised (infinite appendTransaction loop)')
      if (!trs.some((tr) => tr.docChanged)) return null
      const ids = [], tokens = [], positions = []
      newState.doc.forEach((node, pos) => { ids.push(node.attrs.id || ''); tokens.push(node.attrs.token || ''); positions.push(pos) })
      const clearId = {}, clearTok = {}
      dedupeActions(ids).forEach((i) => { clearId[i] = true })
      dedupeActions(tokens).forEach((i) => { clearTok[i] = true })
      let tr = null
      positions.forEach((pos, idx) => {
        const node = newState.doc.nodeAt(pos)
        if (!node) return
        const attrs = Object.assign({}, node.attrs)
        let changed = false
        if (clearId[idx]) { attrs.id = ''; changed = true }
        if (clearTok[idx]) { attrs.token = ''; changed = true }
        if (!attrs.id && !attrs.token && node.textContent.length > 0) { attrs.token = mintToken(); changed = true }
        if (changed) { if (!tr) tr = newState.tr; tr.setNodeMarkup(pos, undefined, attrs) }
      })
      if (tr) tr.setMeta('addToHistory', false)
      return tr
    },
  })
}
function stateWith(doc, counter) {
  return EditorState.create({ schema, doc, plugins: [identityPlugin(counter)] })
}

describe('blockIdentity: token stamp, split clear, no durable mint, no infinite loop', () => {
  it('stamps a TRANSIENT token (not a durable id) on a content-bearing prose', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create(null, schema.text('hi'))])
    let state = stateWith(doc, counter)
    // a docChanged trigger
    state = state.apply(state.tr.insertText('!', 1))
    const p = state.doc.child(0)
    expect(p.attrs.id).toBe('')                  // durable id NEVER invented on the frontend
    expect(p.attrs.token).toMatch(/^tok-/)       // transient correlation token only
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('leaves an EMPTY prose bare (no token until it has content)', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create(), n.paragraph.create(null, schema.text('x'))])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', state.doc.child(0).nodeSize + 1))
    expect(state.doc.child(0).attrs.token).toBe('')      // empty surface: bare
    expect(state.doc.child(1).attrs.token).toMatch(/^tok-/)
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('CLEARS a split-copied token on the new half (the attr-copy trap) → it re-acquires its own', () => {
    const counter = { n: 0 }
    // both halves born with the same token, both content-bearing (post-split)
    const doc = n.doc.create(null, [
      n.paragraph.create({ token: 'tok-aa' }, schema.text('left')),
      n.paragraph.create({ token: 'tok-aa' }, schema.text('right')),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1)) // docChanged trigger
    expect(state.doc.child(0).attrs.token).toBe('tok-aa')   // first occurrence kept
    expect(state.doc.child(1).attrs.token).toMatch(/^tok-/) // re-stamped fresh
    expect(state.doc.child(1).attrs.token).not.toBe('tok-aa')
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('CLEARS a split-copied durable id on the new half (acked block split)', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [
      n.paragraph.create({ id: 'pr-1' }, schema.text('left')),
      n.paragraph.create({ id: 'pr-1' }, schema.text('right')),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.id).toBe('pr-1')        // original keeps its id
    expect(state.doc.child(1).attrs.id).toBe('')            // duplicate cleared
    expect(state.doc.child(1).attrs.token).toMatch(/^tok-/) // → re-acquires a token
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('converges: once every node has an id or a token, a further edit stamps nothing new', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create({ id: 'pr-1' }, schema.text('hi'))])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.id).toBe('pr-1')
    expect(state.doc.child(0).attrs.token).toBe('')
    expect(counter.n).toBeLessThan(LIMIT)
  })
})
```

- [ ] **Step 2: Run it to verify it passes (it pins the contract the plugin now implements)**

Run: `cd frontend && npx vitest run test/proseidentity-loop.test.js`
Expected: PASS (5 tests). If any fail, the harness logic and `prose-block.js` (Task 6) have diverged — reconcile them (they must be identical logic).

- [ ] **Step 3: Run the whole JS suite for regressions**

Run: `cd frontend && npx vitest run`
Expected: all green. (If `prose-identity.test.js` — the OTHER, non-loop file — asserts a `pr-…` mint, inspect it: it may also encode the retired contract per C-T. Only adjust it if it now fails; do not pre-emptively touch passing tests.)

- [ ] **Step 4: Commit**

```bash
git add frontend/test/proseidentity-loop.test.js
git commit -m "test(prose): rewrite proseidentity-loop harness to the token contract (B-A)"
```

---

### Task 8: In-app verification (WebKitGTK) + retire B-A in the tech-debt register

**Files:**
- Modify: `docs/TECH-DEBT.md` (B-A section ~line 31; note E-1 root-principle tie-in)
- Verification: the running app (`wails dev`), per memory `project_test_perf_in_wails_app` — editor mechanics must be verified in WebKitGTK, not just vitest/Chrome.

**Interfaces:** none (verification + doc).

- [ ] **Step 1: Run the app and verify the token round-trip by eye**

Run: `wails dev`
Manual checklist (open the devtools console; watch the WS frames and on-disk markers):
1. Type a brand-new prose paragraph. Confirm: the create-block op carries a `token` (`tok-…`) and NO `blockId`; the on-disk block marker carries a backend id (`pr-…` minted by Go, NOT a frontend value); the node ends with that backend id and no `token` attr.
2. Press Enter mid-paragraph (split). Confirm exactly ONE new block is created (one new backend id on disk), the original keeps its id, undo (Ctrl+Z) still works (history intact — no full reload).
3. "Embed in document" a multi-node `ai-block` (E-1 case). Confirm the original id (e.g. `ai-…`) is preserved (the `proseGroup` container), no `pr-…` re-mint, and any AI ref chain pointing at it still resolves.
4. Open an existing doc (LOAD). Confirm NO `create-block`/`update-block` op is posted as a side-effect of the load (`aiReloadInProgress`/loaded-id invariant honoured) — watch the WS: zero block-ops on open.

- [ ] **Step 2: Retire B-A in the register**

Update `docs/TECH-DEBT.md` B-A: mark it RESOLVED with the date, commit range, and a one-line summary (token→mint→ack; `mintProseId` retired; observer skips pending; split clears, never re-mints). Note that E-1's root principle (identity never invented on the frontend) is now enforced for typed prose too, and cross-reference C-T (the `proseidentity-loop.test.js` rewrite landed here).

- [ ] **Step 3: Commit**

```bash
git add docs/TECH-DEBT.md
git commit -m "docs(tech-debt): retire B-A — backend-authoritative prose id (token->mint->ack)"
```

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch to merge/PR `feature/backend-authoritative-prose-id`.

---

## Self-Review

**1. Spec coverage** (against the task brief Steps 1-5 and the required plan content):
- *Step 1 — investigate/record current mint flow with file:line* → "Current Mint Flow" section (every claim cited: `prose-block.js:47/49-120`, `block-sync.js:94`, `editor.js:316/563/909/619`, `editor_service.go:226/237/443/53`, `ws_handler.go:240`). ✓
- *Step 2 — pin token→mint→ack end to end* → "The pinned token→mint→ack design" + Tasks 1-6 (stamp/emit/mint/ack/apply/skip/split-clear all present). ✓
- *Step 3 — fold in `proseidentity-loop.test.js`* → Task 7 (full rewrite to the token contract). ✓
- *Required content 4 — bite-sized TDD tasks, RED→GREEN, end green + one commit* → every task has Write-test / Run-fail / Implement / Run-pass / Commit. ✓
- *Required content 5 — own branch + retires E-1 root principle* → Global Constraints (branch) + E-1 notes in design, Task 6, Task 8 checklist item 3. ✓
- *Required content 6 — self-review* → this section. ✓
- Backend-source-of-truth + load-never-mutates honoured: token is explicitly NOT identity; apply is a tracked history-excluded `setNodeMarkup`, never `softReloadContent`; loaded nodes carry ids so the plugin never stamps on load; Task 8 verifies zero ops on load. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases/similar to Task N". Every code step shows real code. Two grounded *confirm-before-running* notes (the prose processor constructor name in Task 4; whether `prose-identity.test.js` also encodes the retired contract in Task 7) are explicit verification instructions with the exact `grep`/run to settle them, not hand-waves — they exist because the implementer must not assume an unread symbol. The one genuine design seam flagged for resolution (`blockContentCache` scope vs the module-level `editor:insert-block` listener, Task 5) is resolved IN the plan via the module-level `reconcilePendingToken` seam mirroring the existing `noteServerBlock`/`docSyncFlush` pattern.

**3. Type/interface consistency:**
- `dedupeActions(values) -> number[]` — defined Task 1, used identically in Task 6 and Task 7. ✓
- `proseOp(type, b, index)` carries `op.token` for create — defined Task 2, asserted in Task 2 tests, produced by Task 5's `topBlockTriple` (`token` field). ✓
- Token format `tok-` — pinned in Global Constraints, produced by `mintToken` (Task 6 / Task 7), consumed by the delete-skip (`indexOf('tok-')===0`, Task 3) and the Go echo (Task 4). Consistent. ✓
- `BlockOp.Token` (Go) ↔ `op.token` (JS wire) ↔ `insert-block.token` ↔ `OnBlockCreated(... token string)` — all spelled `token`/`Token` consistently; the Go interface, the `ws_handler` impl, and the `editor_service_test` mock are all updated in Task 4 (build verified). ✓
- `reconcilePendingToken(token, id)` — declared module-level + assigned in `mountWysiwyg` (Task 5), called from the `editor:insert-block` handler (Task 5). ✓
- Pending = `token && !id`; baseline keyed by `id || token`; `computeBlockSync` create/skip/update branches and the `next`-build all use this one rule (Task 2). ✓

**Open questions surfaced for the human:**
1. **Flight-edit fidelity vs simplicity.** The design reconciles `blockContentCache[id] = blockContentCache[token]` on ack so an edit made during the (sub-millisecond, local-WS) flight surfaces as a follow-up `update-block`. This is correct but adds the `reconcilePendingToken` seam. Acceptable? Or is "the create is emitted only after the 500 ms debounce settles, so in-flight edits are effectively impossible" enough to drop the reconcile and just `noteServerBlock(id)`? (The plan keeps the safe version.)
2. **`prose-identity.test.js` (the non-loop file).** It may also encode the retired `pr-…` mint per C-T. The plan only touches it if it fails. Confirm whether you want it proactively reviewed/retired in this branch or left for the C-T sweep.
3. **`mintActions` retirement.** Task 1 adds `dedupeActions` and Task 6 stops using `mintActions`; after this branch `mintActions` has no production caller. Delete it (and its `block-sync.test.js` describe) in this branch, or leave it as dead-but-tested until a cleanup pass? (The plan leaves it; flag if you'd prefer deletion folded into Task 1.)
