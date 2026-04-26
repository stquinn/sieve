# Phase 9: Full React Removal & Pure Go Build

## Status Legend
- [ ] Not started
- [~] In progress
- [x] Complete

---

## Context

Phases 1–8 migrated all UI panels to HTMX/vanilla JS, but React's `App.tsx` (975 lines) still serves as the orchestration layer: tab state, session persistence, AI service calls, editor initialization, layout management, and SSE connection. The `frontend/` directory still exists with a full npm/Vite build chain producing `frontend/dist/` which Go embeds as `//go:embed all:frontend/dist`. TipTap extensions are TypeScript compiled via esbuild into `ui/static/vendor/tiptap.js`.

**Goal:** Delete `frontend/` entirely. `go build` produces the binary with no npm step. TipTap extensions become plain vanilla JS living alongside `editor.js`.

**Tech Debt Retired:** 2-A, 2-B, 2-D, 2-E, 4-C, 5-A, 5-B, 5-D, 6-A, 6-B, X-A, X-B

---

## Step 1 — Convert TipTap Extensions to Vanilla JS

**Goal:** Move all custom TipTap extensions out of the TypeScript/esbuild pipeline into a plain `ui/static/extensions.js` file. This unblocks deletion of the npm build chain.

### Background

All 6 custom extensions are already framework-agnostic TypeScript — no React imports, no JSX. They use vanilla TipTap `Node.create()` / `Extension.create()` / `Mark.create()` APIs and vanilla DOM NodeViews. Conversion is mechanical: strip TypeScript types, replace `import` statements with references to `window.TipTap.*` (already exposed by the tiptap core bundle).

The current build flow:
1. `frontend/src/extensions/*.ts(x)` — TypeScript source
2. `frontend/src/tiptap-bundle-entry.ts` — exports everything (core + custom)
3. `npm run bundle:tiptap` (esbuild) → `ui/static/vendor/tiptap.js` (736KB)
4. `editor.js` destructures from `window.TipTap`

After this step:
1. `ui/static/extensions.js` — all 6 extensions as plain JS, references `window.TipTap.*`
2. `ui/static/vendor/tiptap.js` — rebuilt to contain TipTap core + 3rd-party deps ONLY (no custom extensions); update `tiptap-bundle-entry.ts` to remove custom exports, run `npm run bundle:tiptap` one final time
3. `editor.js` — imports extensions from `window` (set by `extensions.js` loading before it)

### Files to Convert

| Source | Target | Notes |
|---|---|---|
| `frontend/src/extensions/AiBlock.tsx` (212 lines) | `ui/static/extensions.js` | Already vanilla NodeView (`makeAiBlockNodeView`); strip TS types |
| `frontend/src/extensions/AiShortcuts.ts` (39 lines) | `ui/static/extensions.js` | Simple Extension.create with keyboard shortcuts |
| `frontend/src/extensions/BlockNode.tsx` (95 lines) | `ui/static/extensions.js` | Vanilla NodeView already |
| `frontend/src/extensions/CodeBlockWithAttrs.ts` (178 lines) | `ui/static/extensions.js` | Extends CodeBlockLowlight; vanilla NodeView |
| `frontend/src/extensions/ImageWithAttrs.ts` (175 lines) | `ui/static/extensions.js` | Extends Image; drag-resize NodeView; absorb `resolveDisplaySrc` from `ImageNodeView.tsx` |
| `frontend/src/extensions/Search.ts` (177 lines) | `ui/static/extensions.js` | ProseMirror plugin; `extension.storage` contract must be preserved for `editor.js` to read search state |

**Dead files — do NOT convert:**
- `frontend/src/extensions/CodeBlockNodeView.tsx` — React NodeView, already unused
- `frontend/src/extensions/ImageNodeView.tsx` — only exports `resolveDisplaySrc()`, absorbed into ImageWithAttrs

### tasks
- [x] 1.1 Create `ui/static/extensions.js` with all 6 extensions as vanilla JS
- [x] 1.2 Expose extensions on `window.TipTap.*` so `editor.js` finds them as `T.*` (no editor.js changes needed)
- [x] 1.3 Update `frontend/src/tiptap-bundle-entry.ts` to remove custom extension exports; add base API exports (Node, Extension, mergeAttributes, Plugin, PluginKey, Decoration, DecorationSet, CodeBlockLowlight, Image, NodeRange)
- [x] 1.4 Run `npm run bundle:tiptap` one final time → 718.6KB (was 753KB)
- [x] 1.5 `editor.js` already uses `T.*` — no changes needed
- [x] 1.6 Add `<script src="/static/extensions.js">` to `frontend/dist/index.html` (between tiptap.js and editor.js)
- [ ] 1.7 Smoke-test: open a note, verify AI blocks render, code blocks highlight, images load, search works

---

## Step 2 — Create `ui/index.html` Entry Point

**Goal:** Replace `frontend/dist/index.html` (React root) with a pure HTML file served by Go. No React, no Vite build artifacts.

### Background

Currently `main.go` embeds `frontend/dist/` and Wails serves `index.html` from it. The React app mounts into `<div id="root">`. After this step, Go embeds `ui/` and serves `ui/index.html` which has the full layout skeleton already rendered.

### What `ui/index.html` Contains

```html
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/static/tailwind.css">
  <link rel="stylesheet" href="/theme.css">
  <link rel="stylesheet" href="/static/sidebar.css">
</head>
<body hx-ext="sse" sse-connect="/sse">
  <!-- Layout skeleton with initial state from Go session -->
  <div id="app-layout" class="...">
    <div id="htmx-sidebar" hx-get="/api/sidebar" hx-trigger="load" ...></div>
    <div id="main-area">
      <div id="htmx-tabbar" hx-get="/api/tabbar" hx-trigger="load" ...></div>
      <div id="editor-container" data-active-uuid="{{.ActiveUUID}}"></div>
      <div id="htmx-meta" ...></div>
      <div id="prompts-panel" ...></div>
    </div>
  </div>
  <!-- Scripts -->
  <script src="/static/htmx.min.js"></script>
  <script src="/static/vendor/tiptap.js"></script>
  <script src="/static/extensions.js"></script>
  <script src="/static/editor.js"></script>
  <script src="/static/tabbar.js"></script>
  <script src="/static/sidebar.js"></script>
</body>
</html>
```

The file is a Go template rendered by `GET /` handler with session data (active UUID, layout visibility, widths).

### Go Changes

- Add `GET /` route in `handlers.go` that renders `ui/index.html` template with current session
- Update `main.go` embed: `//go:embed all:frontend/dist` → `//go:embed all:ui`
- Update `muxHandler` fallthrough to serve `ui/index.html` for unmatched routes (instead of Wails React fallback)

### tasks
- [ ] 2.1 Create `ui/index.html` as Go template with layout skeleton
- [ ] 2.2 Add `GET /` handler in `handlers.go` that renders it with session state
- [ ] 2.3 Update `main.go` embed directive to `//go:embed all:ui`
- [ ] 2.4 Update `muxHandler` in `main.go` to serve `ui/index.html` as fallthrough
- [ ] 2.5 Test: `go build` succeeds, app launches, initial layout renders correctly

---

## Step 3 — Go Handlers for Remaining React Operations

**Goal:** Replace every `window.sieve*` global that calls into React state with an HTMX endpoint that mutates Go session and returns OOB HTML fragments.

### Current React Operations to Replace

| `window.sieve*` global | New endpoint | Response |
|---|---|---|
| `sieveOpenNote(id)` | `POST /api/note/open/{id}` | OOB: tabbar + fire `editor:load` |
| `sieveNewNote()` | `POST /api/note/new` | Creates note, opens tab; OOB: tabbar + editor load |
| `sieveCloseTab(id)` | Already HTMX in tabbar.js — verify complete |
| `sieveReorderTabs(from, to)` | Already HTMX in tabbar.js — verify complete |
| `sieveCloseAllTabs()` | `POST /api/tabs/closeAll` | Clears tabs, opens blank; OOB: tabbar + editor |
| `sieveDeleteNote(id)` | `DELETE /api/note/{id}` | Removes tab if open; OOB: tabbar + sidebar |
| `sieveToggleSidebar()` | `POST /api/session/sidebar/toggle` | OOB: layout class/style update |
| `sieveToggleMeta()` | `POST /api/session/meta/toggle` | OOB: layout class/style update |
| `sieveTogglePrompts()` | `POST /api/session/prompts/toggle` | OOB: layout class/style update |
| Layout resize (widths) | `POST /api/session/layout` | 204 fire-and-forget |
| `sieveOnSettingsChanged()` | `POST /api/session/refresh` | OOB: theme reload |
| `sieveSetMetaDirty(dirty)` | `POST /api/meta/dirty` | OOB: meta panel badge |

### AI Operations

`AiService.ts` (165 lines) is deleted. AI calls become direct HTTP POSTs from vanilla JS:

| Current | New |
|---|---|
| `window.sieveSmartFile(id)` | `POST /api/ai/smartFile/{id}` |
| `window.sieveSmartMetadata(id)` | `POST /api/ai/smartMetadata/{id}` |
| `window.sieveKeepAndSmartFile(uuid)` | `POST /api/ai/keepAndFile/{uuid}` |
| `window.sieveSmartFileActive()` | `POST /api/ai/smartFile/active` |

Go handlers call the existing `EvalService`/`PromptService` methods directly. SSE streams progress back to the editor.

### Session Persistence

`persistSession()` in App.tsx is eliminated. Go session is mutated server-side on every operation. The existing Go `Session` struct (`stash.Session`) already tracks tabs, activeIdx, openFolders, layout dimensions.

### tasks
- [ ] 3.1 Add `POST /api/note/open/{id}` handler
- [ ] 3.2 Add `POST /api/note/new` handler
- [ ] 3.3 Add `POST /api/tabs/closeAll` handler
- [ ] 3.4 Add `DELETE /api/note/{id}` handler
- [ ] 3.5 Add `POST /api/session/sidebar/toggle`, `/meta/toggle`, `/prompts/toggle` handlers
- [ ] 3.6 Add `POST /api/session/layout` handler (saves widths/heights to session)
- [ ] 3.7 Add `POST /api/ai/smartFile/{id}`, `/smartMetadata/{id}`, `/keepAndFile/{uuid}` handlers
- [ ] 3.8 Add `POST /api/session/refresh` (re-render theme etc. after settings change)
- [ ] 3.9 Update `ui/static/sidebar.js`, `tabbar.js` to use new endpoints instead of `window.sieve*` calls
- [ ] 3.10 Update Wails menu callbacks in `main.go` to call Go functions directly (not `window.sieve*` JS evals)

---

## Step 4 — Prompts Panel

**Goal:** Port the prompts panel from React to Go template + HTMX.

### tasks
- [ ] 4.1 Create `ui/templates/prompts.html` Go template
- [ ] 4.2 Add `GET /api/prompts` handler returning prompts list fragment
- [ ] 4.3 Integrate into `ui/index.html` layout (initially hidden, toggled by session state)
- [ ] 4.4 Connect resize to `POST /api/session/layout`
- [ ] 4.5 SSE `prompts:changed` event refreshes prompts panel declaratively

---

## Step 5 — Fix Remaining Tech Debt

### X-A: `<style>` blocks in `sidebar.html`
- [x] 5.1 Move inline `<style>` from `ui/templates/sidebar.html` → `ui/static/sidebar.css`
- [x] 5.2 Add `<link rel="stylesheet" href="/static/sidebar.css">` in `ui/index.html`

### 2-E: Declarative SSE
- [x] 5.3 Replace manual `htmx.ajax()` SSE listener with `sse-swap="notes:changed"` on `#htmx-sidebar`
- [x] 5.4 Replace manual `htmx.ajax()` SSE listener with `sse-swap="prompts:changed"` on `#prompts-panel`

### 6-A: CSS variable copying for dialogs
- [x] 5.5 Fix Settings and Help `<dialog>` CSS variable inheritance (remove JS variable-copy loop)
- [x] 5.6 Ensure `:root` variables cascade into `<dialog>` via explicit pass-through in `tailwind.css` (implemented in index.html)

---

## Step 6 — Update `wails.json`

**Goal:** Remove all frontend build commands so Wails doesn't try to run npm.

```json
{
  "frontend:install": "",
  "frontend:build": "",
  "frontend:dev:watcher": "",
  "frontend:dev:serverUrl": ""
}
```

- [ ] 6.1 Update `wails.json` to blank out frontend build fields
- [ ] 6.2 Verify `wails dev` starts cleanly without npm errors

---

## Step 7 — Delete `frontend/`

Run only after `go build` succeeds and full smoke test passes.

```
rm -rf frontend/src/
rm -rf frontend/dist/
rm -rf frontend/node_modules/
rm -rf frontend/wailsjs/
rm frontend/package.json frontend/package-lock.json
rm frontend/tsconfig.json frontend/vite.config.ts
rmdir frontend/
```

Also remove `frontend/src/lib/tiptap-bundle-entry.ts` — the esbuild entry point is no longer needed.

- [ ] 7.1 Delete `frontend/src/` directory
- [ ] 7.2 Delete `frontend/dist/` directory
- [ ] 7.3 Delete `frontend/node_modules/` directory
- [ ] 7.4 Delete remaining frontend config files
- [ ] 7.5 Confirm `go build ./...` still succeeds after deletion
- [ ] 7.6 Confirm `wails build` produces a working binary

---

## Verification Checklist

Run through these after Step 7:

- [ ] `go build ./...` succeeds with no `frontend/` directory
- [ ] `wails build` produces a single binary
- [ ] App launches; initial layout matches persisted session (sidebar/meta visible, correct widths)
- [ ] Opening a note loads content in TipTap; edits autosave
- [ ] TipTap extensions work: AI blocks render correctly, code blocks syntax-highlight, images display, drag-resize works, search highlights text
- [ ] Sidebar SSE refresh works when a file changes on disk
- [ ] Tab bar: open, close, reorder, close-all all work
- [ ] Settings dialog opens with correct theme; saving settings applies changes
- [ ] Help dialog opens
- [ ] Quick switcher finds notes by fuzzy search
- [ ] AI smart-file completes a round trip (progress shown, note filed)
- [ ] `du -sh .` shows no `node_modules` in the repo
- [ ] `wails dev` starts without npm-related errors

---

## File Reference

### Files to Create
- `ui/index.html` — pure HTML entry point (replaces React root)
- `ui/static/extensions.js` — all 6 TipTap extensions as vanilla JS
- `requesthandlers/note_handler.go` — open note, new note, delete note
- `requesthandlers/session_handler.go` — toggle sidebar/meta/prompts, layout resize
- `requesthandlers/ai_handler.go` — smartFile, smartMetadata, keepAndFile
- `ui/templates/prompts.html` — prompts panel template
- `ui/static/sidebar.css` — moved from inline `<style>` in sidebar.html

### Files to Modify
- `main.go` — embed path (`all:frontend/dist` → `all:ui`), muxHandler fallthrough
- `wails.json` — remove frontend build commands
- `handlers.go` — add new routes, update embed reference
- `ui/static/editor.js` — use `window.SieveExtensions.*`, remove React bridge assumptions
- `ui/static/tabbar.js` — remove `window.sieve*` calls, use HTMX endpoints
- `ui/static/sidebar.js` — remove `window.sieve*` calls, use HTMX endpoints
- `ui/templates/sidebar.html` — remove inline `<style>` block
- `frontend/src/tiptap-bundle-entry.ts` — remove custom extension exports (before final bundle)

### Files to Delete (Step 7)
- `frontend/` — entire directory (src, dist, node_modules, wailsjs, config files)
