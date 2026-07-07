# Markdown-mode Seed from Go (F-A) Implementation Plan

> **STATUS — ✅ COMPLETE (closed out 2026-06-29).** F-A's primary objective (markdown-mode seeds its textarea from Go's codec, not a JS whole-doc serialize) was already met by **B-G**; this plan retired the **TECH-DEBT F-A** entry (docs) and removed the last dead remnant — the `toMarkdown` registry field on `ProseBlock` plus its now-unused `wrapProseBlock` import, the test mock+assertion that fed it, and four stale comments (`prose-block.js` header, `prose-group.js`, `block-chrome.js`, `editor.js`). Executed via SDD (2 tasks, two-stage reviews + a final whole-branch review that added 2 doc/comment hygiene fixes). Merged to `main` via `feature/markdown-mode-seed-from-go` (merge `b77e802`); vitest 137/137, `go build` green. Tech-debt **F-A RETIRED**. `wrapProseBlock`/`prose-markers.js` intentionally kept (still exported + tested).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the scope of TECH-DEBT F-A, confirm what B-G already retired, and update the register accurately.

**Architecture:** F-A's objective — "markdown-mode seeds its textarea from Go's codec, not JS whole-doc serialize" — is already met. B-G retired `wysiwygMarkdown` and the `doc-update` wysiwyg fallback; the `enter-markdown` WS round-trip now delivers Go-derived markdown to the textarea on every mode switch. The remaining surface is documentation: the F-A register entry is out of date, and a handful of stale comments and one dead registry field can be cleaned up.

**Tech Stack:** Go, Vanilla JS (editor.js, prose-block.js, prose-markers.js, prose-group.js, block-chrome.js), TECH-DEBT.md

## Global Constraints

- Planning only in this doc; implementation is a single doc-update commit (TECH-DEBT.md) plus a small JS cleanup commit.
- No React, no npm build step changes.
- Keep `wrapProseBlock` / `prose-markers.js` — the function is tested and is the correct symmetry impl; only the dead `toMarkdown` registry field and stale comments are removed.
- Keep `proseGroupMarkdownSerialize` in `prose-group.js` — it is the legitimate TipTap markdown serialiser for the `proseGroup` node and is live.
- Keep the markdownit fence-rules in `sieve-block-extension.js` — they handle the paste/raw-markdown round-trip path and are still reachable.

---

## Scoping Section (Step 1)

### What F-A said it was

TECH-DEBT F-A (`docs/TECH-DEBT.md`, line 114–122) named two sub-surfaces:

1. **`wysiwygMarkdown` + `wrapProseBlock` + the `doc-update` fallback (`sendDocUpdate`)** — frontend serialises the whole document to markdown for (a) seeding the markdown-mode textarea and (b) a wysiwyg sync fallback on structured-block edits.

2. **markdownit sieve fence-rules** in `sieve-block-extension.js` — "only reachable via `buildBlocksHTML`'s `serialisedForm` fallback."

### Evidence that both sub-surfaces are already retired

**Sub-surface 1 — `wysiwygMarkdown` / whole-doc markdown seed:**

- `wysiwygMarkdown` as a function or variable: **does not exist in `editor.js`** (`grep -n "wysiwygMarkdown" editor.js` → zero hits). It was removed by B-G.
- `sendDocUpdate`: **does not exist in `editor.js`** (zero hits). Removed by B-G.
- The WYSIWYG `syncDocument` path (`editor.js:316–322`) emits ONLY `block-op` messages via `computeBlockSync`. There is no `doc-update` fallback — the comment at `editor.js:569` ("falls back to a whole-document doc-update only when a block can't be addressed yet") is stale; `computeBlockSync` (`block-sync.js:105–147`) never emits a `doc-update`.
- Markdown textarea seeding is Go-derived in **every** path:
  - **Mode-switch** (`editor.js:1860–1869`): sends `{ type: 'enter-markdown', uuid }` over WS → Go `EditorService.EnterMarkdown` (`sieve/services/editor_service.go:274`) derives `ContentForSave()` from the tree → responds via `editor:markdown-content` event → `mountMarkdown(el, uuid, e.detail.markdown)` seeds the textarea from `e.detail.markdown`.
  - **Soft-reload while in markdown** (`editor.js:1539–1541`): `softReloadContent` fetches `/api/editor/load` → `data.body` (server-derived) → `currentMarkdownTextarea.value = body`.
  - **`editor:insert-block` in markdown mode** (`editor.js:911–915`): appends to `lastSyncedBody`, which is always Go-derived (set from `data.body` on load or `e.detail.markdown` on mode-switch).

**Sub-surface 2 — markdownit fence-rules / `serialisedForm` fallback:**

- `serialisedForm` is **not in `BASE_ATTRS`** (`sieve-block-extension.js:150–157`); B-G removed it from the wire and the frontend entirely.
- `buildBlocksHTML` (`block-render.js:63–65`) → `blockHTML` (`block-render.js:42–58`) → calls `buildSieveBlockHTML(b.kind, b.attrs || {})` directly from Go-sent attrs. No fence parsing, no `serialisedForm`.
- The markdownit fence-rules (`sieve-block-extension.js:615–640`) are still registered but serve the paste/raw-markdown round-trip path (parsing a fence string back to a node). They are NOT dead code; they simply are no longer the `buildBlocksHTML` load path. `sieve-block-extension.js:882` notes: "block identically, and none reaches for the retired serialisedForm."

### What genuinely survives as minor cleanup (not F-A's objective, but adjacent)

**Dead registry field — `toMarkdown` on `ProseBlock`** (`prose-block.js:131`):

```js
toMarkdown: function (id, content) { return wrapProseBlock(id, content) },
```

This field is registered in the block-kind registry but has **no production call site**. `topBlockTriple` (`editor.js:265`) calls `serializeNode` directly and returns raw markdown content WITHOUT id markers (Go wraps on its side via `serializeProseBlock`). `wrapProseBlock` appears in tests only (`block-kinds.test.js:25`, `prose-markers.test.js`). The comment in `prose-group.js:12` still references `topBlockTriple + wysiwygMarkdown` as the save path, which is stale.

**Stale comments** (each misleads the reader):

| File | Line | Stale text | Correct state |
|---|---|---|---|
| `prose-group.js` | 12 | "topBlockTriple + wysiwygMarkdown serialize it via serializeNode and (wysiwyg) wrap it in `<!--s:id-->` markers" | `wysiwygMarkdown` is gone; prose save flows via granular `block-op` (content without markers) |
| `block-chrome.js` | 20 | "serialisedForm (present in BASE_ATTRS for every sieve- node)" | `serialisedForm` is not in `BASE_ATTRS`; the discriminator is `node.type.name.indexOf('sieve-') === 0` (line 85) |
| `editor.js` | 569 | "falls back to a whole-document doc-update only when a block can't be addressed yet" | `computeBlockSync` never falls back to `doc-update`; it emits `block-op` only or emits nothing for id-less nodes |

### Scoping verdict

**F-A's primary objective is already achieved.** No new production code is needed. The plan has two deliverables:

1. **TECH-DEBT F-A update** — mark as RETIRED (or close to it), citing B-G as the primary retiring commit set, and noting the minor cleanup remaining.
2. **Minor cleanup commit** — remove the dead `toMarkdown` registry field and fix the three stale comments. This is small, low-risk, and leaves the codebase honest.

---

## File Map

| File | Change |
|---|---|
| `docs/TECH-DEBT.md` | Retire F-A entry; add evidence + redirect to B-G |
| `frontend/src/static/prose-block.js` | Remove dead `toMarkdown` field from `ProseBlock` |
| `frontend/src/static/prose-group.js` | Fix stale save-path comment (line 12) |
| `frontend/src/static/block-chrome.js` | Fix stale discriminator comment (line 20) |
| `frontend/src/static/editor.js` | Fix stale doc-update fallback comment (line 569) |
| `frontend/test/block-kinds.test.js` | Remove the `toMarkdown` assertion that tests the dead field |

---

## Task 1: Update TECH-DEBT F-A to RETIRED

**Files:**
- Modify: `docs/TECH-DEBT.md` (F-A entry, line 114)

**Why first:** the register drives awareness; fix the authoritative record before the code cleanup.

- [ ] **Step 1: Read the current F-A entry**

```bash
grep -n "F-A" /path/to/sieve/docs/TECH-DEBT.md | head -5
```

Expected: lines around 114.

- [ ] **Step 2: Replace the F-A entry with its retired form**

Replace the existing `## F-A: Frontend still owns document-structure-as-markdown on the OUT direction` block with:

```markdown
## F-A: Frontend still owns document-structure-as-markdown on the OUT direction — ✅ RETIRED (B-G, 2026-06-21)

**RETIRED:** Both sub-surfaces are gone.

1. `wysiwygMarkdown` + the `doc-update` fallback in WYSIWYG mode — **retired by B-G (2026-06-21)**: `computeBlockSync` emits only granular `block-op` messages (no whole-doc fallback); `wysiwygMarkdown` and `sendDocUpdate` no longer exist in `editor.js`. The stale comment at `editor.js:569` ("falls back to a whole-document doc-update") is cosmetic and can be removed.

2. Markdown-mode textarea seeded from Go — **already true in every path**: mode-switch sends `enter-markdown` over WS → `EditorService.EnterMarkdown` (`sieve/services/editor_service.go:274`) derives markdown via `ContentForSave()` → `editor:markdown-content` event seeds the textarea (`editor.js:1862–1869`). Soft-reload seeds from `data.body` (`editor.js:1539`). No JS whole-doc serialise occurs.

3. markdownit fence-rules in `sieve-block-extension.js` — still live for the paste/raw-markdown round-trip; `buildBlocksHTML` now uses `buildSieveBlockHTML` from attrs directly (block-render.js), so `serialisedForm` is gone and the fence-rules are no longer the load path (only the paste-reconstruct path).

**Remaining (minor cleanup, not the F-A objective):** the `toMarkdown` registry field on `ProseBlock` (`prose-block.js:131`) has no production call site (prose save flows via granular `block-op`, not a whole-doc markdown round-trip); three stale comments mislead the reader (`prose-group.js:12`, `block-chrome.js:20`, `editor.js:569`). Clean up in a separate commit.
```

- [ ] **Step 3: Verify the document still renders correctly**

```bash
grep -n "F-A" /path/to/sieve/docs/TECH-DEBT.md
```

Expected: one block starting with `## F-A: Frontend still owns ... — ✅ RETIRED`.

- [ ] **Step 4: Commit**

```bash
git add docs/TECH-DEBT.md
git commit -m "docs(tech-debt): retire F-A (markdown-mode seed from Go already done via B-G)"
```

Expected: commit succeeds; no test run needed for a docs-only change.

---

## Task 2: Remove dead `toMarkdown` field and fix stale comments

**Files:**
- Modify: `frontend/src/static/prose-block.js` (line 131 — remove dead field)
- Modify: `frontend/src/static/prose-group.js` (line 12 — fix stale save-path comment)
- Modify: `frontend/src/static/block-chrome.js` (line 20 — fix stale discriminator comment)
- Modify: `frontend/src/static/editor.js` (line 569 — fix stale doc-update fallback comment)
- Modify: `frontend/test/block-kinds.test.js` (remove toMarkdown assertion)

**Interfaces:**
- Produces: nothing consumed by other tasks. This is a leaf cleanup.

- [ ] **Step 1: Write the failing test (confirm `toMarkdown` assertion exists)**

```bash
cd /path/to/sieve/frontend && npm test -- --reporter=verbose 2>&1 | grep "toMarkdown"
```

Expected: one passing test assertion for `getBlockKind('prose').toMarkdown(...)` in `block-kinds.test.js:25`.

- [ ] **Step 2: Remove the dead `toMarkdown` field from `ProseBlock`**

In `frontend/src/static/prose-block.js`, remove lines 130–131 (the `toMarkdown` field):

Before (lines 129–133):
```js
    // load: a block's verbatim markdown → native HTML.
    fromBlock: function (b, mdRender) { return renderProseContent(proseContent(b), mdRender) },
    // save: one top-level native node's clean markdown → paired-delimiter block.
    toMarkdown: function (id, content) { return wrapProseBlock(id, content) },
    // copy: a prose block's ContentEntry views for a slice — a `sieve/prose` view
```

After (lines 129–131):
```js
    // load: a block's verbatim markdown → native HTML.
    fromBlock: function (b, mdRender) { return renderProseContent(proseContent(b), mdRender) },
    // copy: a prose block's ContentEntry views for a slice — a `sieve/prose` view
```

Also remove the now-orphaned import of `wrapProseBlock` at line 20 IF it is unused after this removal (verify with a grep: `grep -n "wrapProseBlock" prose-block.js`). If the only remaining reference is the import line itself, remove it:

```js
// Remove this line if wrapProseBlock is now the only use:
import { wrapProseBlock } from './prose-markers.js'
```

Note: `prose-markers.js` itself is NOT removed — it is still exported, still tested directly, and is the correct symmetry impl. Only the import in `prose-block.js` becomes dead.

- [ ] **Step 3: Remove the `toMarkdown` assertion from `block-kinds.test.js`**

In `frontend/test/block-kinds.test.js`, remove the test at line 25:

```js
expect(getBlockKind('prose').toMarkdown('pr-1', 'Hi')).toBe('<!--s:pr-1-->\nHi\n<!--/s:pr-1-->')
```

If this is the only assertion in its `it`/`test` block, remove the entire block. If the block has other assertions, remove only this line.

- [ ] **Step 4: Run the test suite to confirm clean**

```bash
cd /path/to/sieve/frontend && npm test
```

Expected: all tests pass (the removed assertion tested a dead field; no regression).

- [ ] **Step 5: Fix stale comment in `prose-group.js` (line 12)**

In `frontend/src/static/prose-group.js`, replace lines 11–13:

Before:
```js
//   - save:     topBlockTriple + wysiwygMarkdown serialize it via serializeNode and
//               (wysiwyg) wrap it in <!--s:id--> markers — like single-node prose.
//   - chain:    proseChainHits matches it (top-level, native-named, id) so the AI
```

After:
```js
//   - save:     topBlockTriple serializes it via serializeNode (raw markdown, no
//               markers); the block-sync observer emits a granular block-op with
//               attrs.content. Go wraps in <!--s:id--> markers on its side.
//   - chain:    proseChainHits matches it (top-level, native-named, id) so the AI
```

- [ ] **Step 6: Fix stale comment in `block-chrome.js` (line 20)**

In `frontend/src/static/block-chrome.js`, replace line 20:

Before:
```js
// serialisedForm (present in BASE_ATTRS for every sieve- node).
```

After:
```js
// node type name starting with 'sieve-' (checked at line 85 via indexOf).
```

- [ ] **Step 7: Fix stale comment in `editor.js` (line 569)**

In `frontend/src/static/editor.js`, replace the stale comment at line 569:

Before:
```js
        // The actual diff + wire send happens once typing settles, in
        // syncDocument, which prefers granular block-ops and falls back to a
        // whole-document doc-update only when a block can't be addressed yet.
```

After:
```js
        // The actual diff + wire send happens once typing settles, in
        // syncDocument, which emits granular block-ops (id-less nodes are
        // skipped until minted — no whole-document fallback).
```

- [ ] **Step 8: Compile-check JS files**

```bash
node --check /path/to/sieve/frontend/src/static/prose-block.js
node --check /path/to/sieve/frontend/src/static/prose-group.js
node --check /path/to/sieve/frontend/src/static/block-chrome.js
node --check /path/to/sieve/frontend/src/static/editor.js
```

Expected: all exit 0 (syntax valid).

- [ ] **Step 9: Run Go build check**

```bash
go build ./... 2>&1
```

Expected: exits 0. (No Go files changed, but confirms environment is clean.)

- [ ] **Step 10: Commit**

```bash
git add frontend/src/static/prose-block.js \
        frontend/src/static/prose-group.js \
        frontend/src/static/block-chrome.js \
        frontend/src/static/editor.js \
        frontend/test/block-kinds.test.js
git commit -m "cleanup(prose): remove dead toMarkdown field + fix 3 stale comments (F-A)"
```

Expected: commit succeeds; test suite stays green.

---

## Self-Review

### Spec coverage

| Requirement from task-6-brief | Covered? |
|---|---|
| Scope F-A accurately | Yes — Scoping Section |
| Confirm `EnterMarkdown` already derives markdown-mode buffer via codec | Yes — evidence at `editor.js:1860–1869` + `editor_service.go:274` cited |
| Confirm `doc-update` wysiwyg fallback gone | Yes — `computeBlockSync` evidence cited |
| State precisely what of F-A remains beyond B-G | Yes — dead `toMarkdown` field + 3 stale comments |
| Recommended TECH-DEBT F-A update | Yes — Task 1 with full replacement text |
| If real code work: TDD tasks keeping prose-block markdown serialize | Yes — Task 2 keeps `wrapProseBlock`/`prose-markers.js`; only removes the dead field |
| If no real code work: document finding + doc-only action | Yes — Task 1 is doc-only; Task 2 is a small cleanup (honest scope) |

### Placeholder scan

Searched for: "TBD", "TODO", "implement later", "fill in details", "add appropriate", "handle edge cases", "similar to Task". None found.

### Type consistency

No new types or function signatures introduced. The `wrapProseBlock` signature (`(id: string, content: string) → string`) is unchanged; it remains exported and tested in `prose-markers.test.js`.

### Concern: is `wrapProseBlock` import removal safe?

After removing `toMarkdown` from `ProseBlock`, the import `import { wrapProseBlock } from './prose-markers.js'` in `prose-block.js` becomes unused. Step 2 explicitly instructs: verify with grep first, then remove the import. `prose-markers.js` itself is NOT touched — it remains a standalone exported module tested by `prose-markers.test.js`.

### Concern: markdownit fence-rules retention

The fence-rules in `sieve-block-extension.js:615–640` are intentionally left untouched. They are not dead: they fire when the editor parses raw markdown via the tiptap-markdown extension (e.g., pasting a raw fence). The F-A entry's original statement that they were "only reachable via `buildBlocksHTML`'s `serialisedForm` fallback" was correct at the time of writing; now that `serialisedForm` is gone, their reach is narrower (paste path only), but they are still reachable and correct. Removing them is out of F-A's scope.
