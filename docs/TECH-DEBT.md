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

### 4-A: Meta panel does not auto-refresh after save or AI evaluation
**What:** `refreshMetaPanel` is only called on tab change and `showMeta` toggle. After autosave (version/modified bump) or AI eval (AI fields update), the meta panel shows stale data until the user switches tabs.

**Why deferred:** The SSE infrastructure for post-save events is Phase 5 work (editor island emits `editor:saved`). Once that exists, the meta panel can subscribe to it.

**Retires in:** Phase 5.

---

### 4-B: Version restore updates `dataService` but TipTap does not visually reload
**What:** `editor:restore` event updates `dataService.current.setBody(uuid, body)` but TipTap's in-memory content is not updated. The editor will show stale content until the tab is reloaded.

**Why deferred:** TipTap is still driven by React (EditorPanel). The fix is `editor.commands.setContent(body)` which requires access to the TipTap instance — that's the Phase 5 editor island.

**Retires in:** Phase 5.

---

### 4-C: `MetaPanel` import comment left in App.tsx
**What:** `import { MetaPanel }` replaced with a comment. File still exists at `frontend/src/components/MetaPanel.tsx`.

**Retires in:** Phase 9 — delete import comment and file.

---

## Cross-cutting debt

### X-A: `<style>` blocks injected on every HTMX swap
**What:** `sidebar.html` includes a `<style>` block that gets re-injected into the DOM on every sidebar refresh, accumulating duplicate `<style>` nodes over time.

**Fix:** Move sidebar-specific styles to `ui/static/sidebar.css`, load once via `<link>`. The sidebar JS (`sidebar.js`) already loads this way.

**Retires in:** Phase 9 / any cleanup pass.

---

### X-B: `window.sieve*` globals namespace is informal
**What:** All HTMX↔React bridges are attached to `window` ad-hoc (`window.sieveOpenNote`, `window.sieveCloseTab`, etc.). There's no type safety or discoverability.

**Why acceptable now:** They're transitional scaffolding. Each one disappears as the component it bridges is migrated.

**Retires in:** Progressively through Phases 5–8; gone entirely by Phase 9.
