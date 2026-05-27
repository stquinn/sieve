# Tech Debt Register

Items accumulated during the React → HTMX migration. Each entry records what the debt is, why it was deferred, and which future phase retires it.

---

## Phase 2 debt — Sidebar

### 2-A: `openFolders` React state is now redundant
**What:** `openFolders` (`useState<Set<string>>`), `openFoldersRef`, `toggleFolder()`, `renameOpenFolder()`, and the `if (session.openFolders) setOpenFolders(...)` restore block all remain in `App.tsx`. Go's `Session.OpenFolders` is now the single source of truth — the sidebar handler reads and writes it directly.

**Why deferred:** `openFoldersRef` is still read by `persistSession` when building the session object for save. Removing it requires either (a) removing `persistSession` entirely or (b) reading open folders from the DOM/Go instead of React state.

**Retires in:** Phase 9 (cleanup) when `persistSession` and all session-sync code is deleted.

---

### 2-B: `getAncestorFolderIDs()` is dead code
**What:** The `getAncestorFolderIDs` function at the top of `App.tsx` is never called. It was used to auto-expand sidebar folders when a note was opened; Go now handles that server-side.

**Retires in:** Phase 9 — delete with the rest of the dead React code.

---

### 2-C: `notes` and `prompts` React state fetched for sidebar are now partially dead
**What:** `const [notes, setNotes]` and `const [prompts, setPrompts]` are fetched via `fNotes`/`fPrompts` on startup and on `notes:changed`/`prompts:changed` events. The sidebar no longer consumes them (Go renders it). Currently only `notes` is passed to `QuickSwitcher`.

**Why deferred:** `QuickSwitcher` is still React (Phase 7). Once it's replaced the fetch and state can be removed.

**Retires in:** Phase 7.

---

### 2-D: `Sidebar.tsx` component import is unused
**What:** `import { Sidebar } from './components/Sidebar'` remains in `App.tsx` but the component is no longer rendered — the sidebar is the HTMX `#htmx-sidebar` div.

**Retires in:** Phase 9 — delete import and file.

---

### 2-E: SSE sidebar refresh uses manual `EventSource` + `htmx.ajax` instead of declarative HTMX
**What:** The `notes:changed` SSE handler manually calls `htmx.ajax('GET', '/api/sidebar', ...)`. The HTMX-native approach is `hx-ext="sse" sse-connect="/sse" sse-swap="notes:changed"` on the sidebar element — zero JavaScript.

**Why deferred:** The SSE connection is also used by Wails `EventsOn` for `notes:changed` and `prompts:changed` to drive `QuickSwitcher` and other React state. Switching to declarative HTMX SSE is cleaner once React consumers are gone.

**Retires in:** Phase 7/9.


### 2-F: Defects: Prompts Side bar and Shortcut no longer work.  Not sure if defect or tech debt but needs to be fixed.  Hover on sidebar doesnt work

---

## Phase 3 debt — Tab Bar

### 3-A: Tab mutations go through JavaScript bridge instead of server round-trips
**What:** Close, select, reorder, and close-all all call `window.sieve*` functions (`sieveCloseTab`, `sieveSelectTab`, `sieveReorderTabs`) which call into React state (`setTabs`, `setActiveIdx`, `smartFileClose`), then save session, then call `refreshTabBar()`. The HTMX-native pattern would be:
```
hx-post="/api/tabs/close?id=..." → Go updates session → SSE fires → tab bar + sidebar re-render
```
No JavaScript bridge, no `refreshTabBar()`, no `persistSession`.

**Why deferred:** The React editor (`EditorPanel.tsx`) reads `tabs[activeIdx]` to know which document to render. Tab mutations must notify React until the editor is a vanilla JS island.

**Retires in:** Phase 5. Once the editor loads via a `editor:load` DOM event, tab operations become pure `hx-post` calls to Go.

---

### 3-B: `TabState[]`, `tabsRef`, `activeIdxRef` React state and refs are redundant
**What:** All the tab state management in `App.tsx` — `const [tabs, setTabs]`, `const [activeIdx, setActiveIdx]`, `tabsRef`, `activeIdxRef`, and all the `useEffect` sync hooks — exists solely to drive the React editor. Go's `Session.Tabs` and `Session.ActiveIdx` are the real source of truth.

**Retires in:** Phase 5.

---

### 3-C: `tabsToSession()` and `persistSession` are tab-bar-specific workarounds
**What:** `tabsToSession()` and every `persistSession(...)` call site are needed because React state must be synced to Go session on every mutation. Once Go owns the mutations (3-A), session is always up to date server-side without any client-side sync.

**Retires in:** Phase 5.

---

### 3-D: `tabbar.js` drag-drop currently re-inits on every tab bar refresh
**What:** `sieveTabBarInit()` is called after every `htmx:afterSettle` event on `#htmx-tabbar` to re-attach drag and overflow handlers to the newly swapped DOM. This is necessary now but is a symptom of the JS-bridge architecture. In a pure HTMX tab bar, drag-drop would use `hx-post` and the server would handle reordering — eliminating the need for client-side drag state entirely, or reducing it to a thin UX-only layer.

**Retires in:** Phase 5 (can slim tabbar.js to ~30 lines of drag UX only).

---

### 3-E: `closeAllTabsRef`, `deleteNoteByIdRef`, `selectTabByIdRef`, `closeTabByIdRef`, `reorderTabsRef`, `showHelpRef` stable ref pattern
**What:** Six `useRef` + `useEffect` pairs exist solely to give `tabbar.js` stable function handles into React state. This entire pattern disappears when tab operations are server-driven.

**Retires in:** Phase 5.

### 3-F: defects: 
    - hover on tab doesnt do anything.
    - close all doesnt do smart save on buffer

---

## Phase 4 debt — Meta Panel

### ~~4-A~~ RETIRED (Phase 5)
`editor:saved` event is now dispatched by `SieveEditor` after each autosave. App.tsx listens and calls `refreshMetaPanel`.

### ~~4-B~~ RETIRED (Phase 5)
`editor:restore` now calls `window.sieveEditor?.setContent(body)` which delegates to `editor.commands.setContent()` in the vanilla island.

---

### 4-C: `MetaPanel` import comment left in App.tsx
**What:** `import { MetaPanel }` replaced with a comment. File still exists at `frontend/src/components/MetaPanel.tsx`.

**Retires in:** Phase 9 — delete import comment and file.

---

## Phase 5 debt — Editor Island

### 5-A: `@tiptap/react` still in package.json
**What:** `@tiptap/react` is no longer imported by any source file but remains listed in `frontend/package.json`. The dead React NodeView files (`CodeBlockNodeView.tsx`, old `AiBlock.tsx` bits) can also be cleaned up.

**Why deferred:** Removing the package requires a full `npm install` cycle which is low priority.

**Retires in:** Phase 9.

---

### 5-B: Dead React component files not yet deleted
**What:** `EditorPanel.tsx`, `MarkdownEditor.tsx`, `AskPopup.tsx`, `LinkBubbleMenu.tsx`, `CodeBlockNodeView.tsx` are no longer imported but remain on disk.

**Retires in:** Phase 9.

---

### 5-D: TipTap bundle is a pre-built binary artifact
**What:** `ui/static/vendor/tiptap.js` is produced by a one-time esbuild run (`npm run bundle:tiptap` in `frontend/`). It must be rebuilt whenever a TipTap extension changes. It is committed to the repo as a static file.

**Why deferred:** The extensions are still TypeScript; esbuild is the bridge until they are rewritten as plain JS and folded directly into `editor.js`.

**Retires in:** Phase 9 — as each extension is rewritten to plain JS it moves into `editor.js`. When all extensions are plain JS the bundle shrinks to TipTap core only, which can be replaced with a pre-built npm artifact and esbuild disappears entirely.

---

### 5-E: `/api/asset/save` endpoint not yet implemented
**What:** `editor.js` POSTs image-paste data to `/api/asset/save` but no Go handler exists yet. Image paste falls back to embedding the base64 data URL inline.

**Retires in:** Phase 5 follow-up.

---

### 5-C: OS file drag-and-drop not implemented
**What:** Wails `DragAndDrop: &options.DragAndDrop{EnableFileDrop: true}` + `OnFileDrop` Go callback was deferred. Dragging files from Finder/Explorer onto the window does not save them as assets.

**Why deferred:** Requires Go-side Wails config + handler; separate feature.

**Retires in:** Phase 5 follow-up or Phase 9.

---

## Phase 6 debt — Modals, Settings, Help

### 6-A: CSS variables copied ad-hoc via JS bridge
**What:** `sieveOpenSettings` and `sieveHelp` in `App.tsx` iterate over computed styles to replicate CSS variables onto the native `<dialog>` wrappers.
**Why deferred:** Top-layer boundary isolation prevents `:root` cascade inheritance securely.
**Retires in:** Phase 9.

### 6-B: Client-side UI state toggling
**What:** `switchSettingsTab` in `settings.html` changes tab selection states purely on the frontend.
**Why deferred:** Avoids additional Go handlers until global state isolation triggers naturally.
**Retires in:** Phase 9.

---

## Cross-cutting debt

### X-A: `<style>` blocks injected on every HTMX swap
**What:** `sidebar.html` includes a `<style>` block that gets re-injected into the DOM on every sidebar refresh, accumulating duplicate `<style>` nodes over time.

**Fix:** Move sidebar-specific styles to `ui/static/sidebar.css`, load once via `<link>`. The sidebar JS (`sidebar.js`) already loads this way.

**Retires in:** Phase 9 / any cleanup pass.

---

### X-B: `window.sieve*` globals namespace is temporary scaffolding
**What:** Interactions for tabs, sidebar, settings, and AI operations route through global `window.sieve*` functions (defined in `ui/index.html`). While they now delegate to pure Go HTTP endpoints via `window.htmx.ajax` or `fetch` rather than React state, the intermediate JS layer is tech debt. The ideal state is declarative `hx-post`/`hx-get` attributes directly on the DOM.

**Why acceptable now:** Rapidly unhooks React without breaking hardcoded triggers in legacy files (`tabbar.js`, `sidebar.js`), templates, or Wails native menus.

**Retires in:** Post-migration cleanup pass (Phase 10). Each global wrapper will be retired by upgrading markup to direct HTMX properties.

---

## Phase 10 debt — Intelligent Fenced Blocks

### ~~X-C~~ RETIRED
AI block now follows Rule 1: `POST /api/ai/ask` and `/api/ai/explain` return `{id, fence}` immediately. JS inserts from Go's canonical fence text (not from a JS-generated YAML). Completion path uses `softReloadContent` (Go writes disk → JS reloads). `serializeAiBlockYaml` kept only for context-menu display; no longer used for persistence.

---

### ~~X-D~~ RETIRED
AI block now follows Rule 7: `GET /api/ai/active` returns in-flight job IDs. `initEditor` fetches both `/api/internalize/active` and `/api/ai/active` in parallel. `window.__sieveActiveAiBlocks` populated on each note load. `isStale()` in `ai-block-extension.js` checks the Set before time-based evaluation.
