# Specification: window.sieve* Global Cleanup

## 1. Background

During the React → HTMX migration, a collection of `window.sieve*` globals were retained in `index.html` as a compatibility shim. They were originally Wails JS bindings; most are now just thin wrappers over `fetch`/`htmx.ajax` calls or JS-to-JS coordination bridges.

These globals are tech debt: they make the call graph implicit, they force unrelated modules to depend on a shared global namespace, and they make templates harder to read (an `onclick` that calls a global is harder to trace than an `hx-post` attribute).

This spec breaks them into three categories with different replacement strategies.

---

## 2. Inventory & Categories

### Category A — Simple HTTP actions (replace with HTMX attributes)

These are wrapper functions that do nothing but POST to a Go endpoint. The template element that calls them can carry the `hx-post` directly.

| Global | Endpoint | Notes |
|--------|----------|-------|
| `sieveSelectTab(id)` / `sieveOpenNote(id)` | `POST /api/tabs/select?id=` | Called from tabbar, sidebar, quickswitcher, prompts templates |
| `sieveNewNote()` | `POST /api/notes/new` | Called from sidebar + tabbar |
| `sieveCloseTab(id)` | `POST /api/tabs/close?id=` | Called from tabbar + context menu |
| `sieveCloseActiveTab()` | `POST /api/tabs/close-active` | Called from keyboard shortcut handler |
| `sieveCloseAllTabs()` | `POST /api/tabs/close-all` | Called from context menu |
| `sieveToggleSidebar()` | `POST /api/ui/sidebar/toggle` | Called from keyboard shortcut |
| `sieveToggleMeta()` | `POST /api/ui/meta/toggle` | Called from keyboard shortcut |
| `sieveTogglePrompts()` | `POST /api/ui/prompts/toggle` | Called from keyboard shortcut |
| `sieveOnSettingsChanged()` | triggers SSE reload | Called from `settings.html` after save |

**Replacement:** add `hx-post` / `hx-trigger` attributes directly to the template elements. Keyboard shortcuts in `index.html` can use `htmx.ajax()` inline or dispatch a custom event (see Category C).

### Category B — Dialog operations (replace with HTMX-loaded dialogs)

These open a JS `prompt()` or a `<dialog>`, collect user input, then POST. The JS prompt is the real problem — it blocks the thread and is unstyled. The right replacement is an HTMX-loaded `<dialog>` fragment.

| Global | Current behaviour | Replacement |
|--------|------------------|-------------|
| `sieveRenameNote(id, name)` | `prompt()` then POST | `hx-get="/api/dialog/rename?id=&name="` loads a `<dialog>` fragment |
| `sieveRenameFolder(id, name)` | `prompt()` then POST | Same pattern |
| `sieveCreateFolder(parentId)` | `prompt()` then POST | Same pattern |
| `sieveOpenDelete(id, name, type)` | Opens `delete-dialog` | Already has a `<dialog>` element — wire directly via `hx-get` |
| `sieveHelp()` | Opens help `<dialog>` | Wire directly |
| `sieveOpenQuickSwitcher()` | Opens quickswitcher `<dialog>` | Wire directly |
| `sieveOpenSettings()` | Opens settings `<dialog>` | Wire directly |

**Replacement:** each context menu item or button gets `hx-get="/api/dialog/..."` which returns the populated `<dialog>` fragment. The dialog's form submit POSTs to the action endpoint. No JS needed.

### Category C — JS-to-JS coordination (replace with custom DOM events)

These are not HTTP calls — they signal state changes between JS modules (editor, tabbar, sidebar, meta panel). Globals are the wrong tool; custom DOM events dispatched on `document` or a shared element are the right one.

| Global | Replaces with |
|--------|--------------|
| `sieveSetMetaDirty(dirty)` | `document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty } }))` |
| `sieveToggleMode()` | `document.dispatchEvent(new CustomEvent('sieve:toggle-mode'))` |
| `sieveToggleAiBlocks()` | `document.dispatchEvent(new CustomEvent('sieve:toggle-ai-blocks'))` |
| `sieveToggleSearch()` | `document.dispatchEvent(new CustomEvent('sieve:toggle-search'))` |
| `sieveTabBarInit()` | Listen to `htmx:afterSettle` on `#htmx-tabbar` instead |
| `sieveSidebarInit()` | Listen to `htmx:afterSettle` on `#htmx-sidebar` instead |
| `sieveInitEditor` | Remains — called from HTMX `hx-on::after-settle` on the editor mount; rename to a module-scoped function, not a global |
| `sieveSave` | `document.dispatchEvent(new CustomEvent('sieve:save'))` — editor.js listens and flushes |
| `sieveEditor` | Internal to `editor.js`. Callers that need to call editor commands should dispatch events; editor.js listens and acts |

### Category D — AI operations (save-then-post)

These save the document first (Go reads from disk), then POST to an AI endpoint. The save returns a Promise so the chain is straightforward.

| Global | Action |
|--------|--------|
| `sieveSmartFile(id)` | Save → `POST /api/ai/smartFile/:id` |
| `sieveSmartMetadata(id)` | Save → `POST /api/ai/smartMetadata/:id` |
| `sieveKeepAndSmartFile(id)` | Save → `POST /api/ai/keepAndFile/:id` |
| `sieveSetEvaluating(id, isEval)` | Sets visual loading state on sidebar item |

**Replacement:** move into `ai-actions.js` as plain named functions — not globals, not event-driven. A single `saveAndPost(url, id)` helper covers all three cases:

```js
function saveAndPost(url, id) {
  const p = window._editorSave ? window._editorSave() : Promise.resolve()
  p.then(() => htmx.ajax('POST', url + id, { swap: 'none' }))
}

export function smartFile(id)        { saveAndPost('/api/ai/smartFile/', id) }
export function smartMetadata(id)    { saveAndPost('/api/ai/smartMetadata/', id) }
export function keepAndSmartFile(id) { saveAndPost('/api/ai/keepAndFile/', id) }
```

Context menu buttons call the module function directly — no global, no event bus:

```html
<button onclick="SieveAI.smartFile('{{.ID}}'); window.sieveCloseMenu()">Smart File</button>
```

`SieveAI` is the module's single named export attached to `window` — one namespace object instead of four globals. `sieveSetEvaluating` becomes internal to the module.

### Category E — Wails native calls (keep, but not as globals)

| Global | Notes |
|--------|-------|
| `sieveShowInFiles(id)` | Calls `window.runtime.ShowInExplorer`. Genuinely needs JS. Move into `sidebar.js` as a module-level function — not a global. |
| `sieveReorderTabs(from, to)` | Called from `tabbar.js` drag handler. Already internal to that module effectively — remove the global, call `htmx.ajax` directly from `tabbar.js`. |

---

## 3. What Stays

After cleanup, the only surviving named globals should be:

| Name | Reason to keep |
|------|---------------|
| `window.sieveInitEditor` | Called by HTMX `hx-on::after-settle` in a template — needs to be resolvable at settle time. Acceptable as a single well-named init hook. |

Everything else either becomes an `hx-` attribute, an HTMX-loaded dialog, a custom DOM event, or a module-internal function.

---

## 4. Implementation Order

Do not attempt all categories at once. Each is independently releasable with no risk to the others.

1. **Category A** — highest value, lowest risk. Pure template changes + verifying endpoint exists. No JS logic touched.
2. **Category C** — medium effort. Swap globals for `dispatchEvent` / `addEventListener` in each module. Test each signal path.
3. **Category B** — requires new dialog fragments in Go templates. Do rename/delete dialogs first (most used), settings/help last.
4. **Category F** — add HTTP handlers before touching the JS. Once endpoints exist, swap `window.go.main.App.*` calls to `fetch()`. `GetLinkTitle` aligns with the rich links spec so build that handler first.
5. **Category D** — requires new `ai-actions.js` module. Do after Category C.
6. **Category E** — trivial, do last as part of general tidying.

---

## 5. Category F — Wails Binding Replacements

Four functions in `editor.js` call `window.go.main.App.*` — the Wails IPC layer — bypassing the HTTP router entirely. These must become HTTP endpoints before the Wails bindings can be removed.

| Wails binding | New HTTP endpoint | Notes |
|---------------|------------------|-------|
| `App.GetLinkTitle(url)` | `GET /api/link-preview?url=&mode=title` | Already specced in `spec-rich-link-cards.md`. Returns just the title for inline smart link paste. Expand to `mode=full` for rich link cards. |
| `App.RefineLanguage(content)` | `POST /api/ai/refine-language` | Body: `{ "content": "..." }`. Returns detected language string. Logic already in `sieve/ai_service.go`. |
| `App.DescribeImage(path)` | `POST /api/ai/describe-image` | Body: `{ "path": "..." }` (store-relative path). Returns `ImageDesc`. Logic already in `sieve/ai_service.go`. |
| `App.DownloadAsset(uuid, url, id)` | `POST /api/assets/download` | Body: `{ "uuid": "...", "url": "...", "id": "..." }`. Returns `AssetDTO`. Logic already in `app.go`. |

**Go side:** each handler is a thin wrapper calling the existing service method — the logic in `app.go` and `sieve/ai_service.go` does not need to change, just exposed via `requesthandlers/` rather than Wails IPC.

**JS side:** each `window.go.main.App.*` call in `editor.js` becomes a `fetch()` to the new endpoint. The callback shape is identical — same `.then(result => ...)` pattern, same ProseMirror transaction inside.

Once all four are replaced, `app.go` can have the Wails-exposed methods removed (or left as dead code until a broader `app.go` cleanup).

---

## 6. File Changes

| File | Change |
|------|--------|
| `frontend/src/index.html` | Remove all `window.sieve*` definitions except `sieveInitEditor`. Keyboard shortcut handlers dispatch custom events instead of calling globals. |
| `frontend/src/templates/*.html` | Replace `onclick="window.sieve*"` with `hx-post`/`hx-get` attributes or `onclick="document.dispatchEvent(...)"` |
| `frontend/src/static/editor.js` | Replace `window.sieveSave`, `window.sieveEditor`, `window.sieveToggleMode` exports with event listeners. Keep `window.sieveInitEditor`. Replace all `window.go.main.App.*` calls with `fetch()`. |
| `frontend/src/static/tabbar.js` | Remove `window.sieveTabBarInit`, `window.sieveCloseTabMenu`. Use `htmx:afterSettle`. |
| `frontend/src/static/sidebar.js` | Remove `window.sieveSidebarInit`. Use `htmx:afterSettle`. Move `sieveShowInFiles` inline. |
| `frontend/src/static/ai-actions.js` | New file. Contains `saveAndPost` helper and smart-file functions. |
| `requesthandlers/link_preview.go` | New handler — `GET /api/link-preview`. Shared with rich links spec. |
| `requesthandlers/ai_inline.go` | New handler — `POST /api/ai/refine-language`, `POST /api/ai/describe-image`. |
| `requesthandlers/assets.go` | New or extended handler — `POST /api/assets/download`. |
