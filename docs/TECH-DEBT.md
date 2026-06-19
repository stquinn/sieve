# Tech Debt Register

Current-era items. React-migration debt was retired with Phase 9 (React removal complete).
Phase 10 retiring: X-B (`window.sieve*` globals — remaining are Wails-bound or structural seams), P-B (PENDING stale detection — moved to `fenced-block-base.js` `isJobActive`), P-C (`serializeWebClipYaml` indent — fixed to 4-space), X-A (`<style>` re-injection — moved to `settings.css`).
Each entry records what the debt is, why it was deferred, and what retires it.

---

## P-A: OS file drag-and-drop not implemented

**What:** Dragging files from the OS file manager onto the Sieve window does nothing. Wails `DragAndDrop` config and an `OnFileDrop` Go handler are needed.

**Why deferred:** Separate feature; no blocking dependency.

**Retires when:** Implemented as a follow-on feature.

## B-A: Prose block ids are frontend-minted, not backend-authoritative

**What:** New prose blocks get their durable `blockId` minted on the **frontend** (`prose-block.js` `mintProseId` in the `blockId` minting plugin, via `mintActions`), then sent on `create-block`. Every **structured** Sieve Block instead gets its id from the **backend** (`GenerateBlockIDFor`, e.g. `EditorService.CreateBlock`) — the backend is the sole id authority and the frontend only ever receives the id. Prose is therefore inconsistent with the rest of the block model: the frontend invents a durable identity that should originate in Go.

**Why deferred (2026-06-19, user decision):** The backend-authoritative path for *native* prose needs an async `create-block` → mint → ack round-trip plus a per-node "pending" state (so the debounced observer doesn't double-create a node whose id is in flight). That state machine lands in the highest-churn area of the editor (two prior reverts). Mid-arc on a long, high-risk migration, the pragmatic call was to keep the frontend-mint model (which is synchronous and already working) and record the inconsistency here. `ApplyOp` create-block already mints server-side when the id is absent, so the backend is a correct floor regardless.

**Retires when:** D-r.4's frontend mint is replaced by a backend-authoritative flow: `create-block` carries content + index + a transient correlation **token** (not a durable id) and marks the node pending; `HandleBlockOp` mints the id and the WS layer acks `{token → blockId}` back via `writeMsg`; the frontend applies the backend's id (a backend-sourced attribute update) and clears pending; the observer skips pending nodes. The `splitBlock` duplicate is then handled by **clearing** the copied id (reuse `mintActions` detection) so the new half becomes id-less → `create-block`, rather than re-minting locally.

## B-B: AI ref chain resolves to `doc`; answer blocks split the target (native-prose targeting) — ✅ RETIRED 2026-06-19 (D-r.7)

**RETIRED:** Fixed by D-r.7 (commits "D-r.7 (1/3)…(3/3)" on `feature/refactor_editor_layout`), implementing the approved spec via TDD. (1) prose identity unified `blockId` → `id` (PM-attr layer only; disk markers carry the value, round-trip untouched). (2) `resolveAiTarget` keys on node *character* — `isFlowingText`(paragraph/heading) → `doc`; every other top-level node (unit) or NodeSelection → that block by id; non-empty TextSelection → `==` + ref chain of every crossed top-level block (`topLevelIdsBetween`). (3) one `blockInsertPos(state,isInline)` (inline → caret, NodeSelection → after node, else `$to.after(1)`) replaces the scattered `sieveInsertPos = selection.to` and the old `aiInsertPos`; all six additive create sites route through `captureInsertPos`/`kindIsInline`. `applyTargetHighlight` dropped the `blockRef` wrap (just applies `==`). vitest: `prose-identity` (4), `ai-target` (20), `block-insert-pos` (6) all green; in-app CDP gate confirmed answers land after the block (no split) and a selection refs its block id (not `doc`). The `blockRef` node-type retirement remains Stage E. **B-A (frontend-minted prose ids) is still open.**

<details><summary>Original defect (historical)</summary>

**What:** The AI targeting/insert layer (`ai-target.js` `resolveAiTarget`/`findBlockTarget`/`aiInsertPos`, `extensions.js` `buildAiContext`/`applyTargetHighlight`) predates the node-granular prose pivot. It recognizes a block only when the node is `blockRef` or `sieve-*` and reads `attrs.id`. Native prose is now a top-level node carrying `attrs.blockId`, so: (1) a **text selection** in prose refs `doc` instead of the block(s) it crosses (`resolveAiTarget`'s selection branch returns no id → `buildAiContext` falls to `'doc'`), and (2) `aiInsertPos` finds no `blockRef`/`sieve-*` ancestor → returns the caret → the Ask/Explain answer **splits** the target paragraph instead of landing as a sibling after it. (Originally recorded as the `project_ai_targeting_blockref_defect` memory.)

**Why deferred:** Block-level addressing needed prose ids, which only landed with D-r.4 minting; doing the rewire before that would have been built on sand.

**Retires when:** The **approved design** [`docs/superpowers/specs/2026-06-19-unified-block-targeting-design.md`](superpowers/specs/2026-06-19-unified-block-targeting-design.md) is implemented (folded into the block-document-model plan as task set **D-r.7**): unify the prose identity attr `blockId` → `id`; resolve targets by node *character* (NodeSelection/unit → that block by id, TextSelection → `==` + ref chain of every crossed block, bare caret in flowing text → `doc`); and route every additive block insert through one `blockInsertPos` (inline → caret, block → after the enclosing top-level node) so answers never split.

</details>
