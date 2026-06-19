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
