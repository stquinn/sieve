# Wails v3 Migration Plan

**Status:** Pre-sprint tech debt — do before feature work begins  
**Estimated effort:** 3–5 hours  
**Goal:** Clean Go-as-controller architecture with native menus, dialogs, and events

---

## Why Now

Every new feature built on v2 would need touching again after migration. The v3 migration *is* the tech debt work — it eliminates the messy seams (SSE, HTMX dialog orchestration, HTTP-based context menu callbacks) and replaces them with a clean native pattern before anything new is built on top.

---

## Architectural Outcome

After migration, the pattern for every user action is:

```
CSS data attr (UUID) → Go callback → load real object →
native dialog if needed → perform action →
app.Event.Emit("notes:changed") → JS re-fetches affected UI region
```

**Go:** owns all logic, menus, context menus, dialogs, confirmations, data operations  
**HTMX + templates:** pure rendering on demand, no logic  
**JS:** TipTap editor + extensions only

### Shell Strategy — Keeping HTMX Transport-Agnostic

HTMX templates must not contain any Wails-specific JS. The goal is that the HTMX layer is identical whether running as a desktop app or a future web server — only the shell beneath it changes.

This means:
- No `@wailsio/runtime` imports in templates or HTMX fragments
- No `Events.On(...)` calls scattered through the frontend
- The `hx-trigger="sse:event-name"` syntax is preserved everywhere

**Events** are bridged via a thin shim (`wails-sse-adapter.js`) that makes Wails native events look like a real SSE connection to HTMX:

```js
// wails-sse-adapter.js — loaded only in desktop builds
import { Events } from '@wailsio/runtime'

class WailsSSEAdapter {
    constructor() {
        this.readyState = 1
        this._subs = {}
        setTimeout(() => this.onopen?.(), 0)
    }
    addEventListener(type, listener) {
        Events.On(type, (e) => {
            listener(new MessageEvent(type, { data: JSON.stringify(e.data) }))
        })
    }
    removeEventListener() {}
    close() {}
}

const Native = window.EventSource
window.EventSource = function(url, opts) {
    if (url === '/sse') return new WailsSSEAdapter()
    return new Native(url, opts)
}
```

HTMX calls `new EventSource('/sse')`, gets the adapter, and its `hx-trigger="sse:notes:changed"` attributes keep working untouched.

**To ship as a web server:** remove the shim and point `/sse` at a real SSE endpoint (the existing `sse.go` can be restored as-is). Zero HTMX template changes.

**Context menus** follow the same principle — `--custom-contextmenu: note-menu` is just a CSS property on the element. Wails reads it natively on desktop. A future web shell would read the same property via a JS `contextmenu` listener and show an HTML menu instead. Templates don't change.

```js
// web-context-menu-shell.js — web equivalent of Wails' native CSS reader
document.addEventListener('contextmenu', (e) => {
    const el = e.target.closest('[style*="--custom-contextmenu"]')
    if (!el) return

    const menuId = el.style.getPropertyValue('--custom-contextmenu').trim()
    const data   = el.style.getPropertyValue('--custom-contextmenu-data').trim()

    if (!menuId) return
    e.preventDefault()

    showHTMLContextMenu(menuId, data, e.clientX, e.clientY)
})
```

`showHTMLContextMenu` fetches `/api/context-menu?menu=note-menu&data=uuid` and renders an HTML menu — which is essentially what the current HTMX implementation already does. The web shell costs one server endpoint (`/api/context-menu`) that returns menu items for a given ID; the desktop shell costs zero because Wails handles it natively via Go callbacks.

The swap point in both cases is a single file — not every callsite.

---

## What Gets Eliminated

| Current | Replaced by |
|---------|-------------|
| `sse.go` + SSE HTTP endpoint | `app.Event.Emit()` native bridge |
| `/api/context-menu` endpoint | `app.RegisterContextMenu()` with CSS data attrs |
| `/api/sidebar/delete-note`, `/api/sidebar/delete-folder` | Go callback → `app.Dialog.Question()` |
| `/api/sidebar/rename-note`, `/api/sidebar/rename-folder` | Go callback → `ShowInputDialog()` |
| `/api/sidebar/create-folder-prompt`, `/api/sidebar/create-folder` | Go callback → `ShowInputDialog()` |
| `/api/sidebar/intent`, `/api/sidebar/move` | Go callbacks |
| HTMX `<dialog>` elements (settings, quick switcher, help) | Custom `WebviewWindow` dialogs |
| `note-context-menu.html`, `folder-context-menu.html` templates | Removed |
| `rename.html`, `delete.html`, `create_folder.html` templates | Removed |
| `hx-ext="sse"` wiring in JS | `WailsSSEAdapter` shim — HTMX templates unchanged |

---

## Migration Steps

### Step 1 — Dependencies

**`shell.nix`**

`pkgs.wails` tracks v2 and won't have a v3 package. Instead, install `wails3` via `go install` inside the shellHook — the nix-shell provides all the CGO dependencies (`webkitgtk_4_1`, `gtk3`, `PKG_CONFIG_PATH` etc.) so the compilation works. Pin to a specific version so the shell is reproducible and the install is a no-op on subsequent entries:

```nix
buildInputs = with pkgs; [
  go
  # wails  ← removed, wails3 installed via go install in shellHook below
  nodejs_22
  pkg-config
] ++ ...

shellHook = ''
  export CGO_ENABLED=1

  if ! command -v wails3 &> /dev/null; then
    echo "Installing wails3..."
    go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha.1
  fi

  # ... rest of shellHook unchanged

  echo "Sieve dev environment ready"
  echo "  go      $(go version)"
  echo "  wails3  $(wails3 version 2>/dev/null || echo 'check wails3 install')"
  echo "  node    $(node --version)"
  echo "  npm     $(npm --version)"
'';
```

Any new developer gets `wails3` automatically on first `nix-shell` entry. To upgrade Wails v3, change the version pin in one place and the next shell entry upgrades it for everyone.

The wrapper script that currently injects `-tags webkit2_41` may still be needed on Linux — confirm by running `wails3 dev` and checking whether it errors without the tag.

**`go.mod`**

```bash
go get github.com/wailsapp/wails/v3@latest
go mod tidy
```

Update `wails.json` config format (frontend section changes).

---

### Step 2 — Rewrite `main.go`

**Before:** `wails.Run(&options.App{...})`  
**After:** `application.New(...)` + `app.Window.NewWithOptions(...)` + `app.Run()`

Menu setup moves from the callback-based v2 API to v3's role + `.OnClick` pattern:

```go
menu := app.NewMenu()

if runtime.GOOS == "darwin" {
    menu.AddRole(application.AppMenu) // Sieve > About, Preferences..., Quit
}
menu.AddRole(application.EditMenu)   // Cut, Copy, Paste, Undo — fixes copy/paste

fileMenu := menu.AddRole(application.FileMenu)
fileMenu.Add("New Note").SetAccelerator("CmdOrCtrl+N").OnClick(...)
fileMenu.Add("Save").SetAccelerator("CmdOrCtrl+S").OnClick(...)
fileMenu.Add("Close Tab").SetAccelerator("CmdOrCtrl+W").OnClick(...)
// No Settings or Quit here on macOS — AppMenu role handles them

// View, Tools menus — same structure, new callback syntax
menu.AddRole(application.WindowMenu)

app.Menu.Set(menu)
```

Key improvement: `AppMenu` role on macOS natively includes "Preferences... (⌘,)" — the Settings placement problem is solved automatically.

---

### Step 3 — Rewrite `app.go`

Remove `ctx context.Context` field and `startup(ctx)` pattern. Replace with service pattern:

```go
type App struct {
    app             *application.Application
    storePath       string
    // ... other fields, no ctx
    ServiceProvider *sieve.ServiceProvider
    // ...
}

func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
    // replaces startup(ctx)
}
```

Update all runtime calls:

| v2 | v3 |
|----|-----|
| `runtime.WindowSetSize(ctx, w, h)` | `window.SetSize(w, h)` |
| `runtime.WindowSetPosition(ctx, x, y)` | `window.SetPosition(x, y)` |
| `runtime.WindowGetSize(ctx)` | `window.Size()` |
| `runtime.WindowGetPosition(ctx)` | `window.Position()` |
| `runtime.EventsEmit(ctx, "notes:changed")` | `a.app.Event.Emit("notes:changed", nil)` |
| `runtime.Quit(ctx)` | `a.app.Quit()` |
| `runtime.OpenDirectoryDialog(ctx, opts)` | `a.app.Dialog.OpenDirectory(opts)` |
| `runtime.MessageDialog(ctx, opts)` | `a.app.Dialog.Info().SetMessage(...).Show()` |
| `runtime.WindowExecJS(ctx, script)` | `window.ExecJS(script)` |

---

### Step 4 — Context Menus

Replace the HTTP-based context menu system with native Wails context menus.

**Go — register menus once at startup:**

```go
noteMenu := app.NewContextMenu()
noteMenu.Add("Keep").OnClick(func(ctx *application.Context) {
    uuid := ctx.ContextMenuData()
    doc, _ := serviceProvider.Documents.LoadByUUID(uuid)
    serviceProvider.Documents.SetUserIntent(doc, "keep")
    app.Event.Emit("notes:changed", nil)
})
noteMenu.Add("Trash").OnClick(...)
noteMenu.AddSeparator()
noteMenu.Add("Rename").OnClick(func(ctx *application.Context) {
    uuid := ctx.ContextMenuData()
    doc, _ := serviceProvider.Documents.LoadByUUID(uuid)
    newName, ok := ShowInputDialog(app, "Rename", doc.Meta().DisplayName())
    if ok {
        serviceProvider.Documents.Rename(doc, newName)
        app.Event.Emit("notes:changed", nil)
    }
})
noteMenu.Add("Delete").OnClick(func(ctx *application.Context) {
    uuid := ctx.ContextMenuData()
    doc, _ := serviceProvider.Documents.LoadByUUID(uuid)
    dialog := app.Dialog.Question().
        SetTitle("Delete Note").
        SetMessage("Delete \"" + doc.Meta().DisplayName() + "\"?")
    deleteBtn := dialog.AddButton("Delete")
    deleteBtn.OnClick(func() {
        serviceProvider.Documents.Delete(doc)
        app.Event.Emit("notes:changed", nil)
    })
    dialog.AddButton("Cancel").SetAsDefault().SetAsCancel()
    dialog.Show()
})
app.RegisterContextMenu("note-menu", noteMenu)

// Similar for folder-menu, prompt-menu
```

**HTML — attach via CSS:**

```html
<!-- In sidebar note template -->
<div style="--custom-contextmenu: note-menu; --custom-contextmenu-data: {{.UUID}}">
    {{.DisplayName}}
</div>
```

Eliminates from the desktop build: `ContextMenuHandler`, all `/api/sidebar/*` action endpoints, context menu templates.

**Web shell note:** The `/api/context-menu` endpoint (which returns menu items) should be retained or kept easy to restore — the web shell JS reads the same `--custom-contextmenu` CSS properties and fetches menu items from this endpoint. The action endpoints (`/api/sidebar/delete-note` etc.) would also be needed on web since Go callbacks don't exist in that context. On desktop these are dead code; on web they're the action handlers. One approach: keep them in the codebase behind a build tag or simply don't delete them — they're cheap to carry and valuable if the web path is ever pursued.

---

### Step 5 — Dialogs

**Confirmations** → `app.Dialog.Question()`  
**Text input (rename, create folder)** → generic `ShowInputDialog` helper using a small frameless `WebviewWindow`

```go
func ShowInputDialog(app *application.Application, prompt, defaultValue string) (string, bool) {
    dialog := app.Window.NewWithOptions(application.WebviewWindowOptions{
        Title:     prompt,
        Width:     400,
        Height:    120,
        Frameless: true,
        Hidden:    true,
    })
    result := make(chan struct{ value string; ok bool }, 1)
    dialog.OnReady(func() {
        dialog.EmitEvent("set-prompt", map[string]string{
            "prompt": prompt, "default": defaultValue,
        })
    })
    app.Event.On("input-submit", func(e *application.CustomEvent) {
        result <- struct{ value string; ok bool }{e.Data.(string), true}
        dialog.Close()
    })
    app.Event.On("input-cancel", func(e *application.CustomEvent) {
        result <- struct{ value string; ok bool }{"", false}
        dialog.Close()
    })
    dialog.Show()
    r := <-result
    return r.value, r.ok
}
```

**Settings, Quick Switcher, Help** → custom `WebviewWindow` instances. These windows can still load content from the existing HTTP endpoints (`/api/settings`, `/api/search-prompt`, `/api/help`) — the endpoints don't change, just the chrome around them.

---

### Step 6 — Events

Replace SSE with native Wails events, bridged to HTMX via a shim so templates stay transport-agnostic.

**Go — emit** (replaces `hub.broadcast(...)`):
```go
app.Event.Emit("notes:changed", nil)
app.Event.Emit("session:changed", nil)
app.Event.Emit("ai:progress", progressData)
```

**JS — `wails-sse-adapter.js`** (loaded once in the desktop build, not in templates):
```js
import { Events } from '@wailsio/runtime'

class WailsSSEAdapter {
    constructor() {
        this.readyState = 1
        setTimeout(() => this.onopen?.(), 0)
    }
    addEventListener(type, listener) {
        Events.On(type, (e) => {
            listener(new MessageEvent(type, { data: JSON.stringify(e.data) }))
        })
    }
    removeEventListener() {}
    close() {}
}

const Native = window.EventSource
window.EventSource = function(url, opts) {
    if (url === '/sse') return new WailsSSEAdapter()
    return new Native(url, opts)
}
```

**HTMX templates — unchanged:**
```html
<!-- These keep working exactly as before -->
<div hx-ext="sse" sse-connect="/sse">
    <div hx-trigger="sse:notes:changed" hx-get="/api/sidebar" hx-target="#htmx-sidebar">
```

**Future web server:** remove `wails-sse-adapter.js`, restore `sse.go`. No template changes.

Eliminates: `sse.go`, `/sse` HTTP endpoint, SSE CORS headers — from the desktop build.

---

### Step 7 — Frontend Bindings

Sieve uses very few Wails JS bindings (mostly `DownloadAsset`, `DescribeImage`, `ShowInFiles`). These move from:

```js
// v2
import { DownloadAsset } from '../wailsjs/go/main/App'
```

to:

```js
// v3
import { DownloadAsset } from './bindings/sieve/app'
```

Run `wails3 generate bindings` after service changes.

---

## What Doesn't Change

- All HTTP request handlers (`requesthandlers/`)  
- Go templates (`frontend/src/templates/`)  
- TipTap editor and extensions (`editor.js`, `extensions.js`)  
- Store layer and all services  
- `//go:embed` usage  
- The custom `muxHandler` / asset serving (v3 supports custom `Assets.Handler`)  
- AI service, CLI integration  

---

## Checklist

- [ ] Update `go.mod` to v3, run `go mod tidy`
- [ ] Rewrite `main.go` — app init, window creation, menu
- [ ] Rewrite `app.go` — remove ctx, update runtime calls, service pattern  
- [ ] Register native context menus, remove `ContextMenuHandler` + endpoints
- [ ] Implement `ShowInputDialog` helper window
- [ ] Replace settings/quick-switcher/help `<dialog>` with `WebviewWindow`
- [ ] Replace SSE hub with `app.Event.Emit`, write `wails-sse-adapter.js` shim
- [ ] Regenerate bindings with `wails3 generate bindings`
- [ ] Remove eliminated templates and endpoints
- [ ] Test: copy/paste, menus, context menus, dialogs, events, vault open
