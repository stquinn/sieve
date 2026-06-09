# React → HTMX/Go Migration Plan

## Context

The React frontend (~6,700 LoC, 7 components, 8 lib files, 8 TipTap extensions) has grown into a complex SPA that cannot be maintained with confidence. The Go backend is comparatively clean (~5,900 LoC, clear service layer, well-tested). The original intent — Go as the brain, frontend as a thin wrapper — has been inverted.

The Go backend is already structured perfectly for this migration: 46 methods exposed via Wails bridge, a working `muxHandler` intercepting HTTP requests (already proven for `/theme.css` and image proxy), and services that have no presentation concerns at all. Nothing meaningful needs to change on the Go side.

---

## Target Architecture

```
Wails WebView
  └── muxHandler (expanded)
       ├── /api/*  → chi router → Go handlers → html/template → HTML fragments
       ├── /sse    → Go SSE handler (replaces Wails EventsEmit)
       ├── /theme.css, /stash-image-proxy (unchanged)
       └── /* → embedded static assets (HTMX, Tailwind, vanilla JS island)
```

**On the wire:** HTML fragments, not JSON.  
**State:** DOM + server-side Go struct (Session). DOM *is* the state.  
**Rendering:** `html/template` in Go, not React.  
**Events:** SSE from Go, not `runtime.EventsEmit`.  
**Editor:** TipTap as a vanilla JS island.  
**Styling:** Tailwind + existing CSS variables (themes unchanged).

---

## What Does NOT Change

- All Go service files (`NoteService`, `BufferService`, `AssetService`, `StateService`, `PromptService`, `EvalService`)
- `store/filestore/` storage layer
- `stash/` domain models
- Theme system (CSS variables + JSON)
- Wails window, tray, lifecycle
- TipTap itself (keep it, but remove React adapter)

---

## Keyboard Shortcuts: Native Wails Menu vs JS Handlers

Wails supports native macOS/Windows menu accelerators via `options.App.Menu`. These are strictly better than JS `keydown` handlers for application-level shortcuts:

| Benefit | Native Wails Menu | JS keydown |
|---------|------------------|------------|
| Visible in menu bar (discoverable) | Yes | No |
| Works when WebView lacks focus | Yes | No |
| Triggers Go function directly | Yes | Needs round-trip |
| Accessibility / system integration | Yes | No |
| Context-aware (editor focused?) | No | Yes |

**The split:**

- **Application shortcuts → Wails native menu** (Go functions called directly):
  - New note (`Cmd+N`), Save (`Cmd+S`), Close tab (`Cmd+W`)
  - Quick Switcher (`Cmd+P`), Toggle Sidebar, Quit
  - Smart File (`Cmd+Shift+E`), Toggle Meta Panel

- **Editor formatting shortcuts → TipTap JS** (TipTap already owns these):
  - Bold, Italic, Heading, Code, Link, etc.
  - These need editor context by definition

- **Small vanilla JS handler** (~30 lines) for any remaining in-WebView navigation:
  - Arrow key navigation in QuickSwitcher results
  - `Escape` to close modals/context menus

This eliminates the current 14-shortcut `keydown` handler in App.tsx entirely. The Wails menu replaces the application shortcuts with native OS behaviour; TipTap handles the rest.

---

## The TipTap Island — The Critical Piece

TipTap has a first-class vanilla JS API. The current `EditorPanel.tsx` (542 lines) is mostly React orchestration *around* TipTap, not TipTap itself. In the new world:

- A single `editor.js` (~200-250 lines vanilla JS) initializes TipTap
- DOM-event-based interface:
  - Go/HTMX fires `editor:load` custom event with `{uuid, content}` to load a document
  - TipTap fires `editor:changed` for autosave to POST back
- Autosave: JS `setTimeout` → `fetch('/api/buffer/save', {body: content})`
- Ask/Explain: JS intercepts selection, calls `/api/ask` or `/api/explain`, injects AiBlock

All custom extensions (`AiBlock`, `CodeBlockWithAttrs`, `ImageWithAttrs`, `Search`) are framework-agnostic — `renderHTML`, `parseHTML`, keyboard shortcuts, and commands need zero changes.

The only React-specific piece is `addNodeView()` in `AiBlock`, which uses `ReactNodeViewRenderer`. Replaced by a plain vanilla `NodeView` class with `dom`, `contentDOM`, and `update()` — approximately 35 lines.

---

## HTTP Routing in Wails

The existing `muxHandler` in `main.go` expands into a `chi` router:

```go
r := chi.NewRouter()
r.Get("/sidebar",          handleSidebar)    // returns <ul> fragment
r.Post("/tab/open/{id}",   handleTabOpen)    // returns tab bar + loads editor
r.Post("/tab/close/{id}",  handleTabClose)   // returns updated tab bar
r.Post("/buffer/save",     handleSave)       // autosave POST from editor
r.Get("/meta/{uuid}",      handleMeta)       // returns meta panel fragment
r.Post("/meta/{uuid}/...", handleMetaAction) // intent, restore version, etc.
r.Get("/sse",              handleSSE)        // Server-Sent Events stream
```

HTMX makes standard HTTP requests; Wails' AssetsHandler intercepts them. The existing image proxy and `/theme.css` handler already prove this pattern works.

**Dev mode**: Without a frontend build step, `wails dev` runs the Go app directly and hot-reloads on Go file changes. The Vite watcher disappears — not a loss.

---

## Replacing Wails Events (SSE)

Currently Go emits `notes:changed` via `runtime.EventsEmit`. In HTMX world:

```go
func handleSSE(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "text/event-stream")
    for event := range app.eventBus {
        fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.name, event.data)
    }
}
```

HTMX's built-in SSE extension handles this declaratively: `hx-ext="sse" sse-connect="/sse" sse-swap="notes:changed"` on the sidebar element auto-fetches `/sidebar` and swaps it whenever the event fires. No JS needed.

---

## Migration Phases (Strangler Fig)

### Phase 0 — Rename Stash → Sieve (standalone commit, before any migration work)

Mechanical find-and-replace across the Go codebase. Done as one isolated commit so the migration starts with the right name throughout.

- `go.mod`: `module stash` → `module sieve`
- All Go import paths: `stash/stash` → `sieve/stash` (or rename subdirectory for full consistency)
- `wails.json`: output binary `stash` → `sieve`
- `main.go`: app title `"Stash"` → `"Sieve"`
- `config.go`: env var `STASH_STORE` → `SIEVE_STORE`
- Leave frontend TypeScript untouched — it's being deleted in Phase 9 anyway
- Verify with `go build` before committing
- Rename the repo on Forgejo and GitHub (UI activity — both set up automatic URL redirects), then update local remote: `git remote set-url origin <new-url>`

### Phase 1 — Infrastructure (no visible change)
- Add `chi` router into `muxHandler`
- Add `html/template` rendering helpers in Go
- Add SSE endpoint (wire to existing file-watcher events)
- HTMX via single `<script>` tag (~50kb, no build step)
- Tailwind via CDN JIT (no node_modules)
- Proof of concept: `/sidebar` returns rendered HTML, React sidebar swapped for it
- **Add `SingleInstanceLock`** to `options.App` — if Stash is already running, bring the existing window to the front instead of spawning a second instance fighting over the same vault

### Phase 2 — Sidebar
- Replace `Sidebar.tsx` (533 lines) with Go template + HTMX
- Folder expand/collapse: `hx-get="/folder/{id}/toggle"` → returns updated subtree
- Context menus: ~50 lines vanilla JS for positioning, content served by HTMX
- File watcher → SSE `notes:changed` → HTMX auto-refreshes sidebar
- **Remove**: `StorableDataService.getNotes()`, `getNoteTree()`, Wails `GetNotes()` React call

### Phase 3 — Tab Bar
- Replace `TabBar.tsx` (430 lines) with Go template
- Tab state lives in Go `Session` (already exists in `stash.Session`)
- Overflow dropdown: `hx-get="/tabs/overflow"`
- Tab drag-drop: ~60 lines vanilla JS (simpler than current implementation)
- **Remove**: `TabState[]` React state, all `tabsRef`/`activeIdxRef` ref sync patterns

### Phase 4 — Meta Panel
- Replace `MetaPanel.tsx` (342 lines) with Go template + HTMX tabs
- Version restore: HTMX `hx-confirm` + `hx-post="/meta/{uuid}/restore"`
- Assets tab: standard `<a>` download links
- Status/intent display: Go template conditional rendering
- Straightforward lift — read-heavy, minimal interactivity
- **Remove**: `MetaPanel.tsx`

### Phase 5 — Editor Island
- Keep TipTap, remove React wrapper (`@tiptap/react` package)
- New `editor.js` (~250 lines) initializes editor, handles load/save
- AiBlock `addNodeView()` rewritten as vanilla `NodeView` (~35 lines)
- Paste handling: TipTap `paste`/`drop` events → `fetch('/api/asset/save')`
- Mode toggle (wysiwyg/markdown): small JS toggle
- **Add OS file drag-and-drop**: enable `DragAndDrop: &options.DragAndDrop{EnableFileDrop: true}` in `options.App` with an `OnFileDrop` Go callback — files dragged from Finder/Explorer onto the window are saved as assets and inserted into the active note automatically. Completes the clipboard-paste workflow with the other half users expect.
- **Remove**: `EditorPanel.tsx` (542 lines), `EditorPasteService.ts`, most of `AiService.ts`

### Phase 6 — Modals, Settings, Help
- **Destructive confirms → `runtime.MessageDialog`**: delete note, delete folder, discard buffer — one line of Go, native OS dialog, no HTML needed
- Non-destructive modals (settings, help): native HTML `<dialog>` element
- Settings: standard HTML form, `POST /api/settings`
- Help: static HTML page, opened as `<dialog>`
- **Remove**: `Modal.tsx`, `SettingsModal.tsx`, `HelpModal.tsx`

### Phase 7 — QuickSwitcher
- HTML `<dialog>` with `<input>` + server-side fuzzy search
- `hx-trigger="input changed delay:50ms"` → `/api/search?q=...` → list fragment
- Keyboard navigation: ~80 lines vanilla JS
- **Remove**: `QuickSwitcher.tsx` (165 lines)

### Phase 8 — Keyboard Shortcuts Migration
- Add Wails native menu (`options.App.Menu`) with all application-level shortcuts
- Remove App.tsx `keydown` handler entirely
- Keep TipTap formatting shortcuts (they're already in the extensions)
- Add ~30 lines vanilla JS for QuickSwitcher arrow-key navigation + Escape handling

### Phase 9 — Cleanup
- Delete `frontend/src/` entirely
- Delete `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`
- Delete `node_modules`, `frontend/dist`
- Update `wails.json` to remove frontend build commands
- Update `main.go` to embed static HTML/JS/CSS from `ui/` directory
- Result: pure Go project, `go build` produces the binary

---

## What Shrinks Dramatically

| Current | New |
|---------|-----|
| `App.tsx` 776 lines | ~100 lines `main.html` + SSE listener |
| `StorableDataService.ts` 443 lines | Eliminated — server is source of truth |
| `AiService.ts` 165 lines | ~80 lines vanilla JS (in-flight indicators only) |
| `TabBar.tsx` 430 lines | ~30 lines Go template + 60 lines JS |
| `Sidebar.tsx` 533 lines | ~50 lines Go template |
| `EditorPanel.tsx` 542 lines | `editor.js` ~250 lines vanilla JS |
| `MetaPanel.tsx` 342 lines | ~40 lines Go template |
| 14 keyboard shortcuts in `useEffect` | Wails native menu (Go) + TipTap (already there) |
| 25+ React state vars + 20+ refs | Gone |
| `node_modules` (~200MB) | Gone |
| Vite build step | Gone |
| TypeScript compilation | Gone |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| TipTap `AiBlock` node view | ~35 lines vanilla `NodeView` — small, isolated |
| Image paste/upload | TipTap `paste` event → `fetch('/api/asset/save')` — same logic, no framework |
| HTMX OOB for multi-panel updates | `hx-swap-oob` on sidebar + tab bar + meta returned from one Go response |
| Session restoration on launch | Go renders correct initial HTML on first load — simpler than current restore logic |
| TipTap without `@tiptap/react` | Vanilla JS `new Editor({...})` API is stable and well-documented |
| Wails menu accelerators on all platforms | Test on both macOS and Linux; Wails supports both |

---

## Verification (When Implemented)

- `go build` succeeds with no frontend build step
- `wails build` produces single binary with embedded HTML/JS
- Open/edit/save note round-trip works
- Sidebar updates when file watcher detects changes (SSE test)
- Tab state persists across sessions
- TipTap loads content, autosaves, supports Ask/Explain
- Quick switcher finds notes by fuzzy search
- All application shortcuts trigger via native menu
- AI evaluation + filing workflow completes
- No `node_modules` in repo
