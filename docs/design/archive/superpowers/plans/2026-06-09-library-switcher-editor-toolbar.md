# Library Switcher + Editor Toolbar Implementation Plan

> **STATUS: DONE** — shipped; LibraryHandler + library_chip.html + #editor-toolbar all live in codebase. Archived 2026-07-07.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a recent-libraries switcher with status-bar chip, a docked editor toolbar with formatting/insert/AI-filing actions, and refresh the Tools menu to match.

**Architecture:** Library switching reuses the existing `SelectVault`/`startup()` plumbing; `GlobalConfig` gains a `RecentLibraries` list and the `.sieve` marker file gains a `Name` field for future user-set names. Switching is guarded: a `window.sieveSwitchLibrary(path)` JS wrapper waits for active AI jobs (polling `window.__sieveActiveJobs`, showing the existing pending-close overlay) and flushes the editor before handing off to the Go binding, which calls `Editor.FlushAll()` before reinitializing. The toolbar is static HTML in `index.html` with inline style show/hide driven by `session.ShowToolbar`, toggled by a new endpoint following the exact pattern of the existing sidebar/meta toggles. AI filing actions appear on the toolbar right side (hidden at Tier 1 via CSS) and in the Tools menu — complementary paths to the same actions.

**Tech Stack:** Go (Wails v2, chi), HTMX, vanilla JS, TipTap, Tailwind/CSS variables

---

## File Map

| File | Change |
|------|--------|
| `config.go` | `LibraryEntry`, `libraryDisplayName`, `AddRecent` on `GlobalConfig` |
| `config_test.go` | Tests for `libraryDisplayName` and `AddRecent` |
| `store/filestore/marker.go` | Add `Name` field to `storeMeta`; add `ReadLibraryName(root)` |
| `app.go` | `SwitchLibrary` (with `FlushAll` guard), call `AddRecent` + broadcast `library:changed` in `startup()`, rebuild menu after switch |
| `main.go` | `buildMenu`: File menu library entries, View `⌘⇧T`, Tools menu refresh |
| `handlers.go` | Register `LibraryHandler`; pass `GetLibraryInfo` func pointer |
| `requesthandlers/library_handler.go` | New — `GET /api/library/current` |
| `frontend/src/templates/library_chip.html` | New — status bar chip fragment |
| `sieve/session.go` | Add `ShowToolbar bool` |
| `requesthandlers/session_handler.go` | Add `POST /api/session/toolbar/toggle` |
| `frontend/src/index.html` | Toolbar HTML, `ShowToolbar` in template data, status bar chip mount, toolbar JS |
| `frontend/src/static/shell.css` | Toolbar CSS |
| `frontend/src/static/editor.js` | `syncToolbar()` wired into selection/transaction handlers |
| `frontend/src/templates/tabbar.html` | Remove Help `?` button |

---

## Task 1: libraryDisplayName helper + data model

**Files:**
- Modify: `config.go`
- Create: `config_test.go`

- [ ] **Write the failing test** in `config_test.go`:

```go
package main

import "testing"

func TestLibraryDisplayName(t *testing.T) {
    tests := []struct {
        path string
        want string
    }{
        {"/home/user/notes", "Notes"},
        {"/home/user/production-notes", "Production Notes"},
        {"/home/user/devTesting", "Dev Testing"},
        {"/home/user/work_notes", "Work Notes"},
        {"/home/user/myKnowledgeBase", "My Knowledge Base"},
        {"/home/user/my-dev_notes", "My Dev Notes"},
    }
    for _, tt := range tests {
        got := libraryDisplayName(tt.path)
        if got != tt.want {
            t.Errorf("libraryDisplayName(%q) = %q, want %q", tt.path, got, tt.want)
        }
    }
}

func TestAddRecent(t *testing.T) {
    c := GlobalConfig{}

    c.AddRecent("/a/notes")
    if len(c.RecentLibraries) != 1 || c.RecentLibraries[0].Path != "/a/notes" {
        t.Fatalf("expected 1 entry, got %v", c.RecentLibraries)
    }

    // dedup: adding same path moves it to front
    c.AddRecent("/b/other")
    c.AddRecent("/a/notes")
    if len(c.RecentLibraries) != 2 || c.RecentLibraries[0].Path != "/a/notes" {
        t.Fatalf("dedup failed: %v", c.RecentLibraries)
    }

    // trim to 8
    for i := 0; i < 10; i++ {
        c.AddRecent(fmt.Sprintf("/x/lib%d", i))
    }
    if len(c.RecentLibraries) != 8 {
        t.Fatalf("expected 8 entries, got %d", len(c.RecentLibraries))
    }
}
```

- [ ] **Run test to confirm it fails:**

```bash
cd /home/stephen/Development/projects/sieve && go test -run 'TestLibraryDisplayName|TestAddRecent' . 2>&1 | head -20
```
Expected: `FAIL` — functions undefined.

- [ ] **Implement in `config.go`** — add after the `GlobalConfig` struct:

```go
// LibraryEntry is one entry in the recent-libraries list.
type LibraryEntry struct {
    Path string `json:"path"`
    Name string `json:"name"`
}

// libraryDisplayName converts a filesystem path to a display-friendly library name.
// It reads the folder basename and splits on hyphens, underscores, and camelCase
// boundaries, then title-cases each word.
func libraryDisplayName(path string) string {
    base := filepath.Base(path)
    // insert spaces before uppercase runs following lowercase (camelCase)
    var runes []rune
    prev := rune(0)
    for _, r := range base {
        if unicode.IsUpper(r) && unicode.IsLower(prev) {
            runes = append(runes, ' ')
        }
        runes = append(runes, r)
        prev = r
    }
    // replace hyphens and underscores with spaces
    s := strings.NewReplacer("-", " ", "_", " ").Replace(string(runes))
    // title-case each word
    words := strings.Fields(s)
    for i, w := range words {
        if len(w) > 0 {
            words[i] = strings.ToUpper(w[:1]) + strings.ToLower(w[1:])
        }
    }
    return strings.Join(words, " ")
}

// AddRecent prepends path to RecentLibraries, deduplicates by path, and trims
// the list to 8 entries. Does not save — caller must call config.Save().
func (c *GlobalConfig) AddRecent(path string) {
    entry := LibraryEntry{Path: path, Name: libraryDisplayName(path)}
    filtered := make([]LibraryEntry, 0, len(c.RecentLibraries))
    for _, e := range c.RecentLibraries {
        if e.Path != path {
            filtered = append(filtered, e)
        }
    }
    c.RecentLibraries = append([]LibraryEntry{entry}, filtered...)
    if len(c.RecentLibraries) > 8 {
        c.RecentLibraries = c.RecentLibraries[:8]
    }
}
```

Add `RecentLibraries []LibraryEntry` to the `GlobalConfig` struct:

```go
type GlobalConfig struct {
    LastStorePath   string         `json:"lastStorePath"`
    RecentLibraries []LibraryEntry `json:"recentLibraries,omitempty"`
}
```

Add required imports to `config.go`: `"unicode"` (already has `"strings"`, `"path/filepath"`).

- [ ] **Run tests to confirm they pass:**

```bash
go test -run 'TestLibraryDisplayName|TestAddRecent' . -v
```
Expected: both PASS.

- [ ] **Compile check:**

```bash
go build ./...
```

- [ ] **Commit:**

```bash
git add config.go config_test.go
git commit -m "feat: add LibraryEntry, libraryDisplayName, and AddRecent to GlobalConfig"
```

---

## Task 2: .sieve Name field + ReadLibraryName

**Files:**
- Modify: `store/filestore/marker.go`

The `.sieve` file at the library root gains a `Name` field so a human-readable name can travel with the library. For now it is populated with the derived basename name at creation; future "Rename Library" will write to it directly.

- [ ] **Add `Name` to `storeMeta`** in `store/filestore/marker.go`:

```go
type storeMeta struct {
    Version   int    `json:"version"`
    Created   string `json:"created"`
    Migration string `json:"migration"`
    Name      string `json:"name,omitempty"`
}
```

- [ ] **Add `ReadLibraryName` function** in `store/filestore/marker.go`:

```go
// ReadLibraryName returns the human-readable library name stored in the .sieve
// marker at root, or an empty string if absent or unreadable.
func ReadLibraryName(root string) string {
    m, err := (&FileStore{root: root}).readStoreMarker()
    if err != nil {
        return ""
    }
    return m.Name
}
```

- [ ] **Compile check:**

```bash
go build ./...
```

- [ ] **Commit:**

```bash
git add store/filestore/marker.go
git commit -m "feat: add Name field to .sieve marker and ReadLibraryName helper"
```

---

## Task 3: SwitchLibrary + startup() wiring

**Files:**
- Modify: `app.go`

- [ ] **In `startup()`, find the block where `LastStorePath` is saved** (around line 198) and extend it to also call `AddRecent` and broadcast `library:changed`:

```go
// replace existing:
//   config.LastStorePath = a.storePath
//   ...config.Save()...
// with:
config := LoadGlobalConfig()
config.LastStorePath = a.storePath
config.AddRecent(a.storePath)
if err := config.Save(); err != nil {
    logger.Warn("startup: failed to save global config", "err", err)
}
a.hub.broadcast("library:changed", "")
```

- [ ] **Add `SwitchLibrary` Wails binding** to `app.go` (after `CreateVault`):

```go
// SwitchLibrary switches to an existing library at path without opening a file
// dialog. Used by the File > Open Recent submenu.
func (a *App) SwitchLibrary(path string) (string, error) {
    if a.ctx == nil {
        return "", fmt.Errorf("app context not initialized")
    }
    if err := ValidateStore(path); err != nil {
        return "", fmt.Errorf("invalid library: %w", err)
    }
    a.storePath = path
    a.startup(a.ctx)
    if a.storePath == "" {
        return "", fmt.Errorf("failed to load the selected library")
    }
    runtime.MenuSetApplicationMenu(a.ctx, buildMenu(a))
    return path, nil
}
```

- [ ] **Compile check:**

```bash
go build ./...
```

- [ ] **Commit:**

```bash
git add app.go
git commit -m "feat: add SwitchLibrary binding and wire AddRecent+SSE into startup()"
```

---

## Task 3b: Library switch safety — flush + job-wait

**Files:**
- Modify: `app.go`
- Modify: `frontend/src/index.html`

Switching libraries is semantically equivalent to closing the app and reopening it. The frontend must wait for active AI jobs and flush the editor. The Go binding must flush the autosave queue. This task adds that safety before any UI that triggers a switch is wired up.

- [ ] **Add `FlushAll` call to `SwitchLibrary` in `app.go`** — insert before `a.storePath = path`:

```go
func (a *App) SwitchLibrary(path string) (string, error) {
    if a.ctx == nil {
        return "", fmt.Errorf("app context not initialized")
    }
    if err := ValidateStore(path); err != nil {
        return "", fmt.Errorf("invalid library: %w", err)
    }
    // Flush any pending autosave before reinitializing the store.
    if a.ServiceProvider != nil && a.ServiceProvider.Editor != nil {
        a.ServiceProvider.Editor.FlushAll()
    }
    a.storePath = path
    a.startup(a.ctx)
    if a.storePath == "" {
        return "", fmt.Errorf("failed to load the selected library")
    }
    runtime.MenuSetApplicationMenu(a.ctx, buildMenu(a))
    return path, nil
}
```

- [ ] **Add `window.sieveSwitchLibrary` helper to `frontend/src/index.html`** — place inside the `DOMContentLoaded` listener, near the existing `app:closing` handler:

```js
// ── Library switch safety wrapper ─────────────────────────────────────────
// All library-switch entry points (menu, chip, toolbar) go through this
// function. It mirrors the app:closing flow: waits for active AI jobs,
// flushes the editor, then delegates to the Go binding.
window.sieveSwitchLibrary = async function(path) {
  var overlay = document.getElementById('pending-close-overlay');
  var overlayTitle  = overlay && overlay.querySelector('.pending-close-title');
  var overlayBody   = overlay && overlay.querySelector('.pending-close-body');

  // Wait for any active AI jobs.
  await new Promise(function(resolve) {
    function check() {
      if (window.__sieveActiveJobs > 0) {
        if (overlay) overlay.style.display = 'flex';
        if (overlayTitle) overlayTitle.textContent = 'Switching library…';
        if (overlayBody)  overlayBody.textContent  = 'Waiting for AI tasks to finish';
        setTimeout(check, 500);
      } else {
        resolve();
      }
    }
    check();
  });

  // Flush editor.
  if (window._editorSave) window._editorSave();
  await new Promise(function(r) { setTimeout(r, 300); });

  try {
    var result = await window.go.main.App.SwitchLibrary(path);
    if (result) location.reload();
  } catch (e) {
    console.error('[sieve] SwitchLibrary failed', e);
    if (overlay) overlay.style.display = 'none';
    alert('Could not switch to that library:\n' + e);
  }
};

// Wrapper for SelectVault (file picker) — same safety, no path arg.
window.sieveSelectLibrary = async function() {
  var overlay = document.getElementById('pending-close-overlay');
  var overlayTitle = overlay && overlay.querySelector('.pending-close-title');
  var overlayBody  = overlay && overlay.querySelector('.pending-close-body');

  await new Promise(function(resolve) {
    function check() {
      if (window.__sieveActiveJobs > 0) {
        if (overlay) overlay.style.display = 'flex';
        if (overlayTitle) overlayTitle.textContent = 'Switching library…';
        if (overlayBody)  overlayBody.textContent  = 'Waiting for AI tasks to finish';
        setTimeout(check, 500);
      } else {
        resolve();
      }
    }
    check();
  });

  if (window._editorSave) window._editorSave();
  await new Promise(function(r) { setTimeout(r, 300); });

  try {
    var path = await window.go.main.App.SelectVault();
    if (path) location.reload();
  } catch (e) {
    if (overlay) overlay.style.display = 'none';
  }
};
```

- [ ] **Update all existing `SelectVault` call sites in `index.html`** to use `sieveSelectLibrary()` instead:

Find: `window.go.main.App.SelectVault().then(function(p){ if(p) location.reload() })`
Replace with: `window.sieveSelectLibrary()`

This includes the bootstrap screen buttons (`sieveSelectVault`, `sieveCreateVault` — leave `CreateVault` as-is, it creates a new empty library with no state to flush).

- [ ] **Compile check:**

```bash
go build ./...
```

- [ ] **Commit:**

```bash
git add app.go frontend/src/index.html
git commit -m "feat: add library switch safety — flush autosave and wait for AI jobs before switching"
```

---

## Task 4: Library HTTP handler + chip template

**Files:**
- Create: `requesthandlers/library_handler.go`
- Create: `frontend/src/templates/library_chip.html`

- [ ] **Create `requesthandlers/library_handler.go`:**

```go
package requesthandlers

import (
    "html/template"
    "net/http"

    "github.com/go-chi/chi/v5"
)

// LibraryHandler serves the status-bar library chip fragment.
type LibraryHandler struct {
    Tmpl           *template.Template
    GetLibraryInfo func() (path, name string)
}

func (h *LibraryHandler) RegisterPaths(r chi.Router) {
    r.Get("/api/library/current", h.handleLibraryCurrent)
}

func (h *LibraryHandler) handleLibraryCurrent(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Cache-Control", "no-store")
    w.Header().Set("Content-Type", "text/html; charset=utf-8")

    path, name := h.GetLibraryInfo()
    if name == "" {
        name = "Library"
    }
    _ = path

    data := struct{ Name string }{Name: name}
    if err := h.Tmpl.ExecuteTemplate(w, "library_chip.html", data); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
    }
}
```

- [ ] **Create `frontend/src/templates/library_chip.html`:**

```html
{{define "library_chip.html"}}
<span id="library-chip"
  class="status-chip status-chip--library"
  title="Current library — click to switch"
  onclick="window.sieveSelectLibrary()"
  hx-get="/api/library/current"
  hx-trigger="sse:library:changed"
  hx-target="#library-chip"
  hx-swap="outerHTML">
  <span class="lib-dot"></span>{{.Name}}
</span>
{{end}}
```

- [ ] **Compile check:**

```bash
go build ./...
```

- [ ] **Commit:**

```bash
git add requesthandlers/library_handler.go frontend/src/templates/library_chip.html
git commit -m "feat: add LibraryHandler and library chip template"
```

---

## Task 5: Wire library into handlers.go + File menu + status bar chip

**Files:**
- Modify: `handlers.go`
- Modify: `main.go`
- Modify: `frontend/src/index.html`

- [ ] **Register `LibraryHandler` in `handlers.go`** — in `newAPIHandler`, after the existing handler registrations:

```go
// import "sieve/store/filestore" is already present
libraryHandler := &requesthandlers.LibraryHandler{
    Tmpl: tmpl,
    GetLibraryInfo: func() (string, string) {
        path := app.storePath
        name := filestore.ReadLibraryName(path)
        if name == "" {
            name = libraryDisplayName(path)
        }
        return path, name
    },
}
libraryHandler.RegisterPaths(r)
```

Note: `libraryDisplayName` is in `config.go` (package `main`) — this closure is defined in `handlers.go` which is also `package main`, so it can call it directly.

- [ ] **Add library entries to the File menu in `main.go` — `buildMenu`**, immediately after the `file.AddSeparator()` that follows "Close Tab":

```go
file.AddSeparator()
// All library switch calls go through the safety wrapper defined in index.html.
file.AddText("Open Library…", keys.Combo("o", keys.CmdOrCtrlKey, keys.ShiftKey),
    js("window.sieveSelectLibrary()"))

// Build Open Recent submenu from GlobalConfig
recentMenu := file.AddSubmenu("Open Recent")
cfg := LoadGlobalConfig()
for _, entry := range cfg.RecentLibraries {
    entryPath := entry.Path // capture loop variable
    entryName := entry.Name
    recentMenu.AddText(entryName, nil, func(_ *menu.CallbackData) {
        logger.Info("menu: switching library", "path", entryPath)
        runtime.WindowExecJS(app.ctx,
            fmt.Sprintf(`window.sieveSwitchLibrary(%q)`, entryPath))
    })
}
if len(cfg.RecentLibraries) > 0 {
    recentMenu.AddSeparator()
}
recentMenu.AddText("Open Other Library…", nil,
    js("window.sieveSelectLibrary()"))

file.AddText("Create New Library…", nil,
    js("window.go.main.App.CreateVault().then(function(p){ if(p) location.reload() })"))
file.AddSeparator()
```

- [ ] **Add status bar chip mount in `frontend/src/index.html`** — replace the empty `<div class="status-bar__left"></div>` with:

```html
<div class="status-bar__left">
  <div hx-get="/api/library/current" hx-trigger="load" hx-swap="innerHTML"></div>
</div>
```

- [ ] **Compile check and confirm menu appears:**

```bash
go build ./...
```

Launch `wails dev`, open File menu, confirm "Open Library…", "Open Recent", "Create New Library…" appear. Confirm status bar shows library name.

- [ ] **Commit:**

```bash
git add handlers.go main.go frontend/src/index.html
git commit -m "feat: wire library handler, File menu entries, and status bar chip"
```

---

## Task 6: Session ShowToolbar + toggle endpoint

**Files:**
- Modify: `sieve/session.go`
- Modify: `requesthandlers/session_handler.go`

- [ ] **Write failing test** — add to `sieve/session_test.go` (create if it doesn't exist):

```go
package sieve

import "testing"

func TestParseSession_ShowToolbar(t *testing.T) {
    data := []byte(`{"showToolbar": true, "activeIdx": 0}`)
    s := ParseSession(data)
    if !s.ShowToolbar {
        t.Fatal("expected ShowToolbar=true")
    }

    empty := ParseSession(nil)
    if empty.ShowToolbar {
        t.Fatal("expected ShowToolbar=false by default")
    }
}
```

- [ ] **Run test to confirm it fails:**

```bash
go test ./sieve/ -run TestParseSession_ShowToolbar -v
```
Expected: FAIL — field missing.

- [ ] **Add `ShowToolbar` to `Session` in `sieve/session.go`:**

```go
type Session struct {
    ActiveIdx         int      `json:"activeIdx"`
    Tabs              []Tab    `json:"tabs"`
    Window            Window   `json:"window,omitempty"`
    SidebarWidth      int      `json:"sidebarWidth,omitempty"`
    MetaWidth         int      `json:"metaWidth,omitempty"`
    ShowSidebar       bool     `json:"showSidebar"`
    ShowMeta          bool     `json:"showMeta"`
    ShowPrompts       bool     `json:"showPrompts"`
    PromptsHeight     int      `json:"promptsHeight,omitempty"`
    OpenFolders       []string `json:"openFolders,omitempty"`
    LastSettingsPanel string   `json:"lastSettingsPanel,omitempty"`
    ShowToolbar       bool     `json:"showToolbar,omitempty"`
}
```

- [ ] **Run test to confirm it passes:**

```bash
go test ./sieve/ -run TestParseSession_ShowToolbar -v
```
Expected: PASS.

- [ ] **Add toolbar toggle handler to `requesthandlers/session_handler.go`:**

Add `POST /api/session/toolbar/toggle` to `RegisterPaths`:

```go
r.Post("/api/session/toolbar/toggle", h.handleToolbarToggle)
```

Add the handler method:

```go
func (h *SessionHandler) handleToolbarToggle(w http.ResponseWriter, r *http.Request) {
    session := h.ServiceProvider.State.LoadSession()
    session.ShowToolbar = !session.ShowToolbar
    _ = h.ServiceProvider.State.SaveSession(session)

    display := "none"
    if session.ShowToolbar {
        display = "flex"
    }
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    fmt.Fprintf(w, `<style id="layout-overrides-toolbar" hx-swap-oob="true">#editor-toolbar { display: %s; }</style>`, display)
}
```

- [ ] **Compile check:**

```bash
go build ./...
```

- [ ] **Commit:**

```bash
git add sieve/session.go requesthandlers/session_handler.go sieve/session_test.go
git commit -m "feat: add ShowToolbar to Session and toolbar toggle endpoint"
```

---

## Task 7: Toolbar CSS

**Files:**
- Modify: `frontend/src/static/shell.css`

- [ ] **Add the following CSS block to `shell.css`** — append after the existing rules:

```css
/* ── Editor Toolbar ──────────────────────────────────────────────────────── */

#editor-toolbar {
  /* initial display controlled by inline style from template;
     toggled by /api/session/toolbar/toggle OOB style swap */
  align-items: center;
  height: 32px;
  background: var(--theme-bgDark);
  border-bottom: 1px solid var(--theme-border);
  padding: 0 8px;
  gap: 1px;
  flex-shrink: 0;
  overflow: hidden;
}

.tb-group { display: flex; align-items: center; gap: 1px; }

.tb-sep {
  width: 1px; height: 16px;
  background: var(--theme-border);
  margin: 0 5px;
  flex-shrink: 0;
}

.tb-btn {
  height: 24px; min-width: 24px; padding: 0 5px;
  border: none; border-radius: 3px; background: transparent;
  color: var(--theme-textDim); font-size: 11px; font-weight: 600;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  white-space: nowrap; flex-shrink: 0;
}
.tb-btn:hover  { background: var(--theme-border); }
.tb-btn.active { background: var(--theme-border); color: var(--theme-accentPrimary); }

/* Sieve block insert pills */
.tb-insert {
  font-size: 10px; font-weight: 700; letter-spacing: .02em;
  padding: 0 7px; height: 22px; border-radius: 3px;
  background: color-mix(in srgb, var(--theme-accentCyan) 12%, transparent);
  color: var(--theme-accentCyan);
}
.tb-insert:hover {
  background: color-mix(in srgb, var(--theme-accentCyan) 22%, transparent);
}

/* AI filing actions — right side */
.tb-ai-actions {
  margin-left: auto;
  display: flex; align-items: center; gap: 2px;
}
.tb-help { margin-left: 4px; }

/* Hide AI buttons entirely when no CLI is configured */
.tier-dumb .tb-ai-actions { display: none; }

.tb-ai {
  font-size: 10px; font-weight: 700; letter-spacing: .02em;
  padding: 0 8px; height: 22px; border-radius: 3px;
  background: color-mix(in srgb, var(--theme-accentPrimary) 12%, transparent);
  color: var(--theme-accentPrimary);
}
.tb-ai:hover {
  background: color-mix(in srgb, var(--theme-accentPrimary) 22%, transparent);
}
.tb-ai-keep {
  background: color-mix(in srgb, var(--theme-accentGreen) 12%, transparent);
  color: var(--theme-accentGreen);
}
.tb-ai-keep:hover {
  background: color-mix(in srgb, var(--theme-accentGreen) 22%, transparent);
}

/* Status bar library chip */
.status-chip--library {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--theme-bgAlt);
  border: 1px solid var(--theme-border);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px; font-weight: 600;
  color: var(--theme-accentPrimary);
  cursor: pointer; user-select: none;
}
.status-chip--library:hover { background: var(--theme-border); }
.lib-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--theme-accentGreen); flex-shrink: 0;
}
```

- [ ] **Rebuild Tailwind** (CSS variables don't need Tailwind, but run if you added any Tailwind classes):

```bash
cd /home/stephen/Development/projects/sieve/frontend && npx tailwindcss -i src/static/input.css -o src/static/tailwind.css 2>&1 | tail -3
```

- [ ] **Commit:**

```bash
git add frontend/src/static/shell.css
git commit -m "feat: add toolbar and library chip CSS"
```

---

## Task 8: Toolbar HTML + template data wiring

**Files:**
- Modify: `frontend/src/index.html`
- Modify: `handlers.go`

- [ ] **Add `ShowToolbar` to the index template data struct in `handlers.go`** — in the `data := struct{...}{...}` block inside `handleIndex` (around line 214):

Add field to the struct definition:
```go
ShowToolbar      bool
```

Add value:
```go
ShowToolbar:      session.ShowToolbar,
```

- [ ] **Insert toolbar HTML in `frontend/src/index.html`** — between the closing `</div>` of `#htmx-tabbar` and the opening of `.editor-area`:

```html
<div id="editor-toolbar" style="display:{{if .ShowToolbar}}flex{{else}}none{{end}}">
  <!-- Text formatting -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="bold"    title="Bold (⌘B)"><b>B</b></button>
    <button class="tb-btn" data-cmd="italic"  title="Italic (⌘I)"><i>I</i></button>
    <button class="tb-btn" data-cmd="strike"  title="Strikethrough"><s>S</s></button>
    <button class="tb-btn" data-cmd="code"    title="Inline code" style="font-family:monospace">&lt;&gt;</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Headings -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="h1" title="Heading 1" style="font-weight:800">H1</button>
    <button class="tb-btn" data-cmd="h2" title="Heading 2" style="font-weight:700">H2</button>
    <button class="tb-btn" data-cmd="h3" title="Heading 3" style="font-weight:600">H3</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Lists -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="bulletList"  title="Bullet list">&#8801;</button>
    <button class="tb-btn" data-cmd="orderedList" title="Ordered list" style="font-size:10px">1.</button>
    <button class="tb-btn" data-cmd="taskList"    title="Task list">&#9745;</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Block elements -->
  <div class="tb-group">
    <button class="tb-btn" data-cmd="blockquote"     title="Blockquote">&#8220;</button>
    <button class="tb-btn" data-cmd="insertTable"    title="Insert 3&#xD7;3 table" style="font-size:13px">&#8862;</button>
    <button class="tb-btn" data-cmd="horizontalRule" title="Horizontal rule">&#8212;</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Sieve block inserts -->
  <div class="tb-group">
    <button class="tb-btn tb-insert" data-insert="code"     title="Insert code block">{ } Code</button>
    <button class="tb-btn tb-insert" data-insert="diagram"  title="Insert diagram">&#9671; Diagram</button>
    <button class="tb-btn tb-insert" data-insert="web-clip" title="Insert web clip">&#11041; Clip</button>
    <button class="tb-btn tb-insert" data-insert="ai-block" title="Insert AI block">&#10022; AI</button>
  </div>
  <div class="tb-sep"></div>
  <!-- Image upload -->
  <div class="tb-group">
    <button class="tb-btn tb-insert" id="tb-image-btn" title="Insert image from file">&#128444; Image</button>
    <input id="tb-image-input" type="file" accept="image/*" style="display:none">
  </div>
  <!-- AI filing actions (right-aligned; hidden at Tier 1 via .tier-dumb CSS) -->
  <div class="tb-ai-actions">
    <button class="tb-btn tb-ai"      data-ai="smartMetadata"  title="Smart Metadata (&#8984;&#8679;M)">&#10009; Metadata</button>
    <button class="tb-btn tb-ai"      data-ai="smartFile"      title="Smart File (&#8984;&#8679;E)">&#11041; File</button>
    <button class="tb-btn tb-ai tb-ai-keep" data-ai="keepAndSmartFile" title="Keep &amp; Smart File (&#8984;&#8679;&#9166;)">&#10003; Keep &amp; File</button>
  </div>
  <!-- Help (relocated from tab bar) -->
  <div class="tb-help">
    <button class="tb-btn" id="tb-help-btn" title="Help (&#8984;/)">?</button>
  </div>
</div>
```

- [ ] **Compile check:**

```bash
go build ./...
```

Open `wails dev`, toggle toolbar via the endpoint or a quick browser console `htmx.ajax('POST','/api/session/toolbar/toggle',{swap:'none'})` and confirm the toolbar appears/disappears.

- [ ] **Commit:**

```bash
git add handlers.go frontend/src/index.html
git commit -m "feat: add toolbar HTML and wire ShowToolbar into index template"
```

---

## Task 9: Toolbar JS — command dispatch + image upload

**Files:**
- Modify: `frontend/src/index.html`

Add the following JS block inside the existing `<script>` section in `index.html`, within the `DOMContentLoaded` listener (or directly adjacent to the existing toolbar/editor setup code):

- [ ] **Add toolbar click dispatch handler:**

```js
// ── Toolbar command dispatch ──────────────────────────────────────────────
document.getElementById('editor-toolbar')?.addEventListener('click', function(e) {
  var btn = e.target.closest('[data-cmd],[data-insert],[data-ai],[id="tb-image-btn"],[id="tb-help-btn"]');
  if (!btn) return;

  // Help button
  if (btn.id === 'tb-help-btn') {
    htmx.ajax('GET', '/api/help', { target: '#help-dialog-content', swap: 'innerHTML' })
        .then(function() { document.getElementById('help-dialog').showModal(); });
    return;
  }

  // Image file picker
  if (btn.id === 'tb-image-btn') {
    document.getElementById('tb-image-input').click();
    return;
  }

  // AI filing actions
  var ai = btn.dataset.ai;
  if (ai && window.SieveAI) {
    window.SieveAI[ai]();
    return;
  }

  // Sieve block inserts
  var insert = btn.dataset.insert;
  if (insert) {
    document.dispatchEvent(new CustomEvent('sieve:create-block', { detail: { kind: insert } }));
    return;
  }

  // TipTap formatting commands
  var editor = window.__tiptap;
  if (!editor) return;
  var cmd = btn.dataset.cmd;
  var c = editor.chain().focus();
  switch (cmd) {
    case 'bold':           c.toggleBold().run(); break;
    case 'italic':         c.toggleItalic().run(); break;
    case 'strike':         c.toggleStrike().run(); break;
    case 'code':           c.toggleCode().run(); break;
    case 'h1':             c.toggleHeading({ level: 1 }).run(); break;
    case 'h2':             c.toggleHeading({ level: 2 }).run(); break;
    case 'h3':             c.toggleHeading({ level: 3 }).run(); break;
    case 'bulletList':     c.toggleBulletList().run(); break;
    case 'orderedList':    c.toggleOrderedList().run(); break;
    case 'taskList':       c.toggleTaskList().run(); break;
    case 'blockquote':     c.toggleBlockquote().run(); break;
    case 'insertTable':    c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
    case 'horizontalRule': c.setHorizontalRule().run(); break;
  }
});
```

- [ ] **Add image file input handler** (in the same `DOMContentLoaded` block):

```js
// ── Toolbar image upload ──────────────────────────────────────────────────
document.getElementById('tb-image-input')?.addEventListener('change', function(e) {
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var uuid = document.getElementById('tiptap-mount')?.getAttribute('data-uuid');
  if (!uuid || uuid.startsWith('prompt:')) return;
  var reader = new FileReader();
  reader.onload = function(ev) {
    // Reuse the existing smart-paste endpoint — SmartImageProcessor handles images
    if (typeof sieveInsertPos !== 'undefined' && window.__tiptap) {
      window.sieveInsertPos = window.__tiptap.state.selection.to;
    }
    fetch('/api/editor/smart-paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: uuid, entries: [{ mimeType: file.type, content: ev.target.result }] }),
    }).catch(function(err) { console.error('[toolbar] image upload failed', err); });
  };
  reader.readAsDataURL(file);
  e.target.value = ''; // reset so the same file can be re-selected immediately
});
```

Note: `sieveInsertPos` is declared in `editor.js` scope; this code must run in the same page context. If the variable is not in scope, use `window.__tiptap.state.selection.to` directly in the fetch handler above (already shown).

- [ ] **Compile check:**

```bash
go build ./...
```

Launch `wails dev`, enable toolbar, confirm Bold button works and Insert Table inserts a table.

- [ ] **Commit:**

```bash
git add frontend/src/index.html
git commit -m "feat: add toolbar JS dispatch, image upload, and help button handlers"
```

---

## Task 10: Toolbar active-state sync

**Files:**
- Modify: `frontend/src/static/editor.js`

- [ ] **Add `syncToolbar` function** to `editor.js` — place it near the top of the file alongside other utility functions:

```js
function syncToolbar(editor) {
  var toolbar = document.getElementById('editor-toolbar');
  if (!toolbar || toolbar.style.display === 'none') return;
  var map = {
    bold:        ['bold'],
    italic:      ['italic'],
    strike:      ['strike'],
    code:        ['code'],
    h1:          ['heading', { level: 1 }],
    h2:          ['heading', { level: 2 }],
    h3:          ['heading', { level: 3 }],
    bulletList:  ['bulletList'],
    orderedList: ['orderedList'],
    taskList:    ['taskList'],
    blockquote:  ['blockquote'],
  };
  toolbar.querySelectorAll('[data-cmd]').forEach(function(btn) {
    var args = map[btn.dataset.cmd];
    if (args) btn.classList.toggle('active', editor.isActive.apply(editor, args));
  });
}
```

- [ ] **Wire `syncToolbar` into the TipTap event handlers in `editor.js`**. Find where the editor is created (`new Editor({...})` or the equivalent). Locate the existing `selectionUpdate` and `transaction` handlers and add `syncToolbar(editor)` calls:

```js
editor.on('selectionUpdate', function({ editor }) {
  // ... existing code ...
  syncToolbar(editor);
});

editor.on('transaction', function({ editor }) {
  // ... existing code ...
  syncToolbar(editor);
});
```

If these handlers don't yet exist, add them to the editor creation options:

```js
onSelectionUpdate({ editor }) { syncToolbar(editor); },
onTransaction({ editor })    { syncToolbar(editor); },
```

- [ ] **Compile check and manual test:**

```bash
go build ./...
```

Launch `wails dev`, enable toolbar, place cursor in bold text — confirm the B button highlights. Click Heading 1 — confirm H1 button highlights.

- [ ] **Commit:**

```bash
git add frontend/src/static/editor.js
git commit -m "feat: add syncToolbar() and wire into TipTap selectionUpdate/transaction"
```

---

## Task 11: Tab bar cleanup + View menu + Tools menu

**Files:**
- Modify: `frontend/src/templates/tabbar.html`
- Modify: `main.go`

- [ ] **Remove Help button from `frontend/src/templates/tabbar.html`** — delete lines 57–62 (the `<button>` with `onclick` calling `/api/help`):

```html
{{/* REMOVE this block: */}}
<button
  onclick="htmx.ajax('GET','/api/help',{target:'#help-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('help-dialog').showModal()})"
  aria-label="Keyboard shortcuts (Ctrl+/)"
  title="Shortcuts (Ctrl+/)"
  class="px-3 bg-transparent border-none h-full text-tn-muted hover:text-tn-text hover:bg-tn-bg-alt text-[14px] leading-none shrink-0 transition-colors"
>?</button>
```

Help remains accessible via: toolbar `?` button, `⌘/` keyboard shortcut (Help menu), and the Help menu item.

- [ ] **Update `buildMenu` in `main.go`**:

**View menu** — add toolbar toggle after the existing view items. Find the block ending with `view.AddText("Quick Switcher", ...)` and add:

```go
view.AddSeparator()
view.AddText("Show Toolbar", keys.Combo("t", keys.CmdOrCtrlKey, keys.ShiftKey),
    js("htmx.ajax('POST','/api/session/toolbar/toggle',{swap:'none'})"))
```

**Tools menu** — replace the existing two-item tools block entirely:

```go
tools := appMenu.AddSubmenu("Tools")
tools.AddText("Smart Metadata", keys.Combo("m", keys.CmdOrCtrlKey, keys.ShiftKey),
    js("window.SieveAI?.smartMetadata()"))
tools.AddSeparator()
tools.AddText("Smart File", keys.Combo("e", keys.CmdOrCtrlKey, keys.ShiftKey),
    js("window.SieveAI?.smartFile()"))
tools.AddText("Keep & Smart File", keys.Combo("return", keys.CmdOrCtrlKey, keys.ShiftKey),
    js("window.SieveAI?.keepAndSmartFile()"))
```

- [ ] **Compile check:**

```bash
go build ./...
```

Launch `wails dev`. Confirm:
- Tab bar no longer has `?` button
- View menu has "Show Toolbar ⌘⇧T"
- Tools menu has "Smart Metadata", separator, "Smart File", "Keep & Smart File"
- `⌘⇧T` toggles the toolbar
- `⌘/` still opens Help

- [ ] **Commit:**

```bash
git add frontend/src/templates/tabbar.html main.go
git commit -m "feat: remove Help from tabbar, add toolbar toggle to View menu, refresh Tools menu"
```

---

## Task 12: Tailwind rebuild + final smoke test

**Files:**
- Modify: `frontend/src/static/tailwind.css` (generated)

- [ ] **Rebuild Tailwind** to pick up any new classes in templates:

```bash
cd /home/stephen/Development/projects/sieve/frontend && npx tailwindcss -i src/static/input.css -o src/static/tailwind.css
```

- [ ] **Full compile:**

```bash
cd /home/stephen/Development/projects/sieve && go build ./...
```
Expected: no errors.

- [ ] **Run all tests:**

```bash
go test ./... 2>&1 | tail -20
```
Expected: all pass.

- [ ] **Smoke test in `wails dev`** — work through this checklist:

  - [ ] File menu: "Open Library…" opens a picker; "Open Recent" shows current library; "Create New Library…" works
  - [ ] Status bar: library chip shows current library name; updates after switching
  - [ ] View › Show Toolbar (⌘⇧T): toolbar appears/disappears; state persists after reload
  - [ ] Toolbar formatting: Bold, Italic, H1, H2, H3, Bullet/Ordered/Task list all work; active state highlights correctly
  - [ ] Toolbar inserts: Table inserts a 3×3 table; Code/Diagram/Clip/AI blocks insert correctly
  - [ ] Toolbar image: clicking "Image" opens file picker; selecting an image inserts a SmartImage block
  - [ ] Toolbar AI actions (requires CLI configured): Metadata, File, Keep & File all trigger correctly
  - [ ] Tier 1 (comment out CLI in settings): AI toolbar section is hidden
  - [ ] Tools menu: Smart Metadata ⌘⇧M, Smart File ⌘⇧E, Keep & Smart File ⌘⇧↵ all work
  - [ ] Help: `?` in toolbar opens help modal; ⌘/ still works; tab bar no longer has `?`

- [ ] **Commit if clean:**

```bash
git add frontend/src/static/tailwind.css
git commit -m "chore: rebuild Tailwind after toolbar template additions"
```
