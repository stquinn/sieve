# Tech Debt Register

Current-era items. React-migration debt was retired with Phase 9 (React removal complete).
Each entry records what the debt is, why it was deferred, and what retires it.

---

## X-B: `window.sieve*` globals are temporary scaffolding

**What:** Interactions for tabs, sidebar, settings, and AI operations route through global `window.sieve*` functions defined in `frontend/src/index.html`. They now delegate to pure Go HTTP endpoints via `fetch` rather than React state, but the intermediate JS layer is tech debt.

**Why deferred:** Rapidly unhooked React without breaking hardcoded triggers in `tabbar.js`, `sidebar.js`, templates, or Wails native menus.

**Retires when:** Each global wrapper is retired by upgrading markup to direct `hx-post`/`hx-get` HTMX attributes.

---

## P-A: OS file drag-and-drop not implemented

**What:** Dragging files from the OS file manager onto the Sieve window does nothing. Wails `DragAndDrop` config and an `OnFileDrop` Go handler are needed.

**Why deferred:** Separate feature; no blocking dependency.

**Retires when:** Implemented as a follow-on feature.

---

## P-B: PENDING block stale detection loses server confirmation on tab switch

**What:** `isStale()` in `ai-block-extension.js` checks `window.__sieveActiveAiBlocks` to confirm a job is still in-flight before showing "stale/interrupted" UI. That Set is populated when a job is *started in the current session*, but is no longer seeded from the server on tab load (the old `/api/ai/active` fetch was removed in favour of SSE). Similarly, `web-clip-extension.js` still references `window.__sieveActiveWebClips` (which no longer exists) — that path is dead.

**Effect:** If you switch away from a tab with a PENDING block and return, the block may briefly show "Request timed out / interrupted" until the completion SSE fires — even if the job is still running. The generous time threshold (`cliTimeoutLong + 30s`) masks this most of the time.

**Why deferred:** A proper fix requires `SieveAI.loadActiveJobs()` to also populate the extension-level Sets, or the extensions to listen directly to `sse:ai:job-started`/`sse:ai:job-ended`. That is a cross-concern change deferred until the stale UX is revisited.

**Retires when:** `loadActiveJobs()` seeds `window.__sieveActiveAiBlocks` from the `/api/ai/active-jobs` response, and the dead `__sieveActiveWebClips` reference is removed from `web-clip-extension.js`.

---

## P-C: `serializeWebClipYaml` uses 2-space block scalar indent

**What:** `serializeWebClipYaml` in `web-clip-extension.js` (used only for context-menu display, never for persistence) indents block scalar lines with 2 spaces instead of 4. The 4-space rule exists to ensure inner `` ``` `` lines can never close the outer fence, but 2-space content `` ` `` lines would still have leading spaces and not match the exact-column-0 closing fence check — so there is no correctness risk.

**Why deferred:** Display-only, no persistence path. Low priority cosmetic inconsistency.

**Retires when:** `serializeWebClipYaml` is updated to 4-space indent for consistency, or removed if the context menu no longer needs it.

---

## X-A: `<style>` blocks re-injected on every HTMX swap

**What:** `sidebar.html` includes a `<style>` block that is re-injected into the DOM on every sidebar refresh, accumulating duplicate `<style>` nodes over time.

**Fix:** Move sidebar-specific styles to `frontend/src/static/sidebar.css` and load once via `<link>`.

**Retires when:** Any cleanup pass touches sidebar templates.
