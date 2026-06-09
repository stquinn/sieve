# Design Spec: Library Switcher + Editor Toolbar

Date: 2026-06-09
Status: Approved

---

## Overview

Two independent quality-of-life features that can be built and shipped together in one branch.

1. **Library Switcher** — File menu with Recent Libraries submenu; active library shown as a clickable chip in the status bar. Models the workspace-switching UX familiar from VS Code and other editors.
2. **Editor Toolbar** — A docked toolbar between the tab bar and editor area. Toggleable via View menu (⌘⇧T). Exposes text formatting, headings, lists, table insertion, image-from-file upload, and the four Sieve block-insert types.

---

## Feature 1: Library Switcher

### Data Model

`config.go` — extend `GlobalConfig`:

```go
type LibraryEntry struct {
    Path string `json:"path"`
    Name string `json:"name"` // display-friendly, derived from filepath.Base(path)
}

type GlobalConfig struct {
    LastStorePath   string         `json:"lastStorePath"`
    RecentLibraries []LibraryEntry `json:"recentLibraries,omitempty"`
}
```

`Name` is derived once at write-time from `filepath.Base(path)` using a display-friendly transform:
- Split on `-`, `_`, and camelCase boundaries
- Title-case each word
- Examples: `production-notes` → "Production Notes", `devTesting` → "Dev Testing", `work_notes` → "Work Notes", `notes` → "Notes"

This is a pure Go helper `libraryDisplayName(path string) string` in `config.go`. No user-editable name field — the basename transform is the only source of truth for now.

`GlobalConfig` gets an `AddRecent(path string)` method:
- Derives `Name` from path
- Prepends new entry to `RecentLibraries`
- Removes any existing entry with the same `Path` (dedup)
- Trims to maximum 8 entries
- Saves to disk

### Go Changes

**`config.go`**
- `LibraryEntry` struct
- `libraryDisplayName(path string) string` — the camelCase/hyphen/underscore-aware display name transform
- `AddRecent(path string)` method on `GlobalConfig`

**`app.go`**
- `startup()`: after every successful startup (existing code at line ~199 where `LastStorePath` is saved), call `config.AddRecent(a.storePath)` and broadcast `library:changed` SSE event via `hub.broadcast("library:changed", "")`
- New Wails binding `SwitchLibrary(path string) (string, error)`: validates path via `ValidateStore`, sets `a.storePath = path`, calls `a.startup(a.ctx)`, returns the resolved path or error. Does not open a file dialog.
- New Wails binding `GetCurrentLibrary() LibraryEntry`: returns `LibraryEntry{Path: a.storePath, Name: libraryDisplayName(a.storePath)}`

**`main.go` — `buildMenu`**

Add to the existing `file` submenu (after "Close Tab", before Settings separator):

```
File
  New Note             ⌘N
  Save                 ⌘S
  Close Tab            ⌘W
  ─────────────────────────────
  Open Library…        ⌘⇧O   → SelectVault()
  Open Recent          ▶      → submenu (see below)
  Create New Library…         → CreateVault()
  ─────────────────────────────
  Settings / Preferences …
  Quit
```

The "Open Recent" submenu is rebuilt from `LoadGlobalConfig().RecentLibraries` each time `buildMenu` is called. Each entry calls `SwitchLibrary(entry.Path)` via the Wails JS bridge. The currently active library is not specially marked in the native menu (Wails native menus don't support dynamic checkmarks easily); the status bar chip is the source of active-library identity.

Because Wails v2 menus are static after `wails.Run`, rebuilding the recents submenu after a switch requires calling `runtime.MenuSetApplicationMenu(a.ctx, buildMenu(a))` from within `SwitchLibrary`. Since `buildMenu` and `SwitchLibrary` are both in `package main`, this is a direct call with no package boundary issues.

### HTTP

New endpoint `GET /api/library/current` registered in a new `LibraryHandler` (or added to `MetaHandler`/`SessionHandler`):
- Returns a small HTML fragment: the status bar chip
- Template: `library_chip.html`

```html
{{define "library_chip.html"}}
<span id="library-chip"
  class="status-chip"
  title="Current library — click to switch"
  onclick="window.go.main.App.SelectVault().then(function(p){ if(p) location.reload() })"
  hx-get="/api/library/current"
  hx-trigger="sse:library:changed"
  hx-target="#library-chip"
  hx-swap="outerHTML">
  <span class="lib-dot"></span>
  {{.Name}}
</span>
{{end}}
```

### Frontend (`index.html`)

Status bar left side gets an HTMX-loaded chip:

```html
<div class="status-bar__left">
  <div hx-get="/api/library/current" hx-trigger="load" hx-swap="innerHTML"></div>
</div>
```

Add `.gitignore` entry for `.superpowers/` if not already present.

### SSE

`library:changed` — broadcast after every successful `startup()`. No payload needed; the chip re-fetches `/api/library/current` on receipt.

---

## Feature 2: Editor Toolbar

### Session

`session.go` — add one field:

```go
type Session struct {
    // ... existing fields ...
    ShowToolbar bool `json:"showToolbar,omitempty"`
}
```

Defaults to `false` (toolbar hidden on first launch). Users enable it once and it persists.

### Endpoint

`POST /api/session/toolbar/toggle` — registered in `SessionHandler.RegisterPaths`:
- Loads session, flips `ShowToolbar`, saves session
- Returns HTTP 204 with `HX-Trigger: session:changed`

### HTML Structure (`index.html`)

`#app-root` gains the `toolbar-visible` class when `ShowToolbar` is true:

```html
<div id="app-root" class="theme-{{.ThemeName}} tier-{{.Tier}} {{if .ShowToolbar}}toolbar-visible{{end}}" ...>
```

The template data struct (currently anonymous in the `handleIndex` handler) gains `ShowToolbar bool` passed from `session.ShowToolbar`.

The toolbar HTML is inserted between `#htmx-tabbar` and `.editor-area`:

```html
<div id="editor-toolbar">
  <!-- Text formatting -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="bold"          title="Bold (⌘B)"><b>B</b></button>
    <button class="tb-btn" data-cmd="italic"        title="Italic (⌘I)"><i>I</i></button>
    <button class="tb-btn" data-cmd="strike"        title="Strikethrough"><s>S</s></button>
    <button class="tb-btn" data-cmd="code"          title="Inline code">&lt;&gt;</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Headings -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="h1" title="Heading 1">H1</button>
    <button class="tb-btn" data-cmd="h2" title="Heading 2">H2</button>
    <button class="tb-btn" data-cmd="h3" title="Heading 3">H3</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Lists -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="bulletList"   title="Bullet list">≡</button>
    <button class="tb-btn" data-cmd="orderedList"  title="Ordered list">1.</button>
    <button class="tb-btn" data-cmd="taskList"     title="Task list">☑</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Block elements -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="blockquote"      title="Blockquote">"</button>
    <button class="tb-btn" data-cmd="insertTable"     title="Insert 3×3 table">⊞</button>
    <button class="tb-btn" data-cmd="horizontalRule"  title="Horizontal rule">─</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Sieve block inserts (teal pills) -->
  <div class="tb-group">
    <button class="tb-btn tb-insert" data-insert="code"      title="Insert code block">{ } Code</button>
    <button class="tb-btn tb-insert" data-insert="diagram"   title="Insert diagram block">◇ Diagram</button>
    <button class="tb-btn tb-insert" data-insert="web-clip"  title="Insert web clip">⬡ Clip</button>
    <button class="tb-btn tb-insert" data-insert="ai-block"  title="Insert AI block">✦ AI</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Image upload -->
  <div class="tb-group">
    <button class="tb-btn tb-insert" id="tb-image-btn" title="Insert image from file">🖼 Image</button>
    <input id="tb-image-input" type="file" accept="image/*" style="display:none">
  </div>
  <!-- Help (relocated from tab bar) -->
  <div style="margin-left:auto">
    <button class="tb-btn" id="tb-help-btn" title="Help (⌘/)">?</button>
  </div>
</div>
```

### CSS (`shell.css`)

```css
#editor-toolbar {
  display: none;
  align-items: center;
  height: 32px;
  background: var(--theme-bgDark);
  border-bottom: 1px solid var(--theme-border);
  padding: 0 8px;
  gap: 1px;
  flex-shrink: 0;
}
.toolbar-visible #editor-toolbar { display: flex; }

.tb-group { display: flex; align-items: center; gap: 1px; }
.tb-sep   { width: 1px; height: 16px; background: var(--theme-border); margin: 0 5px; }

.tb-btn {
  height: 24px; min-width: 24px; padding: 0 5px;
  border: none; border-radius: 3px; background: transparent;
  color: var(--theme-textDim); font-size: 11px; font-weight: 600;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.tb-btn:hover { background: var(--theme-border); }
.tb-btn.active { background: var(--theme-border); color: var(--theme-accentPrimary); }

.tb-insert {
  font-size: 10px; font-weight: 700; letter-spacing: .02em;
  padding: 0 7px; height: 22px;
  background: color-mix(in srgb, var(--theme-accentCyan) 12%, transparent);
  color: var(--theme-accentCyan);
}
.tb-insert:hover {
  background: color-mix(in srgb, var(--theme-accentCyan) 22%, transparent);
}
```

### JS (`index.html` inline or separate `toolbar.js`)

Two responsibilities:

**1. Command dispatch** (click handler, wired once on DOMContentLoaded):

```js
document.getElementById('editor-toolbar')?.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-cmd],[data-insert]');
  if (!btn) return;
  var editor = window.__tiptap;
  if (!editor) return;

  var cmd = btn.dataset.cmd;
  var insert = btn.dataset.insert;

  if (insert) {
    document.dispatchEvent(new CustomEvent('sieve:create-block', { detail: { kind: insert } }));
    return;
  }

  // Image upload — feed the file through the existing smart-paste pipeline
  if (btn.id === 'tb-image-btn') {
    document.getElementById('tb-image-input').click();
    return;
  }

  // Help button
  if (btn.id === 'tb-help-btn') {
    htmx.ajax('GET', '/api/help', { target: '#help-dialog-content', swap: 'innerHTML' })
        .then(function() { document.getElementById('help-dialog').showModal(); });
    return;
  }

  var c = editor.chain().focus();
  switch (cmd) {
    case 'bold':          c.toggleBold().run(); break;
    case 'italic':        c.toggleItalic().run(); break;
    case 'strike':        c.toggleStrike().run(); break;
    case 'code':          c.toggleCode().run(); break;
    case 'h1':            c.toggleHeading({ level: 1 }).run(); break;
    case 'h2':            c.toggleHeading({ level: 2 }).run(); break;
    case 'h3':            c.toggleHeading({ level: 3 }).run(); break;
    case 'bulletList':    c.toggleBulletList().run(); break;
    case 'orderedList':   c.toggleOrderedList().run(); break;
    case 'taskList':      c.toggleTaskList().run(); break;
    case 'blockquote':    c.toggleBlockquote().run(); break;
    case 'insertTable':   c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
    case 'horizontalRule': c.setHorizontalRule().run(); break;
  }
});
```

**2. Active-state sync** (called from the existing `selectionUpdate` / `transaction` handler in `editor.js`):

Export or expose a `syncToolbar(editor)` function that iterates over `[data-cmd]` buttons and adds/removes the `active` class:

```js
function syncToolbar(editor) {
  var toolbar = document.getElementById('editor-toolbar');
  if (!toolbar) return;
  var map = {
    bold: ['bold'], italic: ['italic'], strike: ['strike'], code: ['code'],
    h1: ['heading', { level: 1 }], h2: ['heading', { level: 2 }], h3: ['heading', { level: 3 }],
    bulletList: ['bulletList'], orderedList: ['orderedList'], taskList: ['taskList'],
    blockquote: ['blockquote'],
  };
  toolbar.querySelectorAll('[data-cmd]').forEach(function(btn) {
    var args = map[btn.dataset.cmd];
    if (args) btn.classList.toggle('active', editor.isActive(...args));
  });
}
```

`syncToolbar` is called from within the existing `editor.on('selectionUpdate', ...)` and `editor.on('transaction', ...)` callbacks already present in `editor.js`.

**3. Image file input handler** (wired once on DOMContentLoaded):

```js
document.getElementById('tb-image-input')?.addEventListener('change', function(e) {
  var file = e.target.files && e.target.files[0];
  if (!file || !currentUuid) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    sieveInsertPos = window.__tiptap ? window.__tiptap.state.selection.to : null;
    fetch('/api/editor/smart-paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: currentUuid, entries: [{ mimeType: file.type, content: ev.target.result }] }),
    });
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // reset so the same file can be re-selected
});
```

This reuses the exact same server-side `SmartImageProcessor` path as clipboard paste — no new server code needed.

### Menu (`main.go` — `buildMenu`)

Add to the existing `view` submenu (after the existing toggles):

```go
view.AddSeparator()
view.AddText("Show Toolbar", keys.Combo("t", keys.CmdOrCtrlKey, keys.ShiftKey),
    js("htmx.ajax('POST','/api/session/toolbar/toggle',{swap:'none'})"))
```

---

## What Is NOT in Scope

- Library renaming (user-editable name). Basename transform is sufficient for now; can be added later with no schema changes — `Name` field is already present in `LibraryEntry`.
- Toolbar button for Link insertion (complex UX, low priority vs. table).
- Table editing controls (add/remove rows/cols) — toolbar handles insert only; editing relies on TipTap's existing right-click or future gutter work.
- Toolbar visibility per-document or per-mode — it's a global session setting only.

### Help Button Relocation

The existing Help `?` button in the tab bar (`tabbar.html` template or its handler) is removed and replaced by the `?` button at the right end of the editor toolbar. When the toolbar is hidden, the keyboard shortcut `⌘/` (already in the View menu) remains the fallback access path.

---

## Files Changed

| File | Change |
|------|--------|
| `config.go` | `LibraryEntry`, `libraryDisplayName`, `AddRecent` |
| `app.go` | `SwitchLibrary`, `GetCurrentLibrary`, broadcast `library:changed` in `startup()`, rebuild menu after switch |
| `main.go` | `buildMenu`: File menu library entries, View menu toolbar toggle |
| `sieve/session.go` | `ShowToolbar bool` field |
| `requesthandlers/session_handler.go` | `POST /api/session/toolbar/toggle` |
| New `requesthandlers/library_handler.go` | `GET /api/library/current` |
| New `frontend/src/templates/library_chip.html` | Status bar chip template |
| `frontend/src/index.html` | Toolbar HTML block, `toolbar-visible` class on app-root, status bar chip mount, toolbar JS, image file input handler |
| `frontend/src/static/shell.css` | Toolbar CSS |
| `frontend/src/static/editor.js` | `syncToolbar()` call in selectionUpdate/transaction handlers |
| `frontend/src/templates/tabbar.html` | Remove Help `?` button (line ~58) from tab bar |
| `handlers.go` | Register `LibraryHandler` |
