# Post-Migration Feature Opportunities

These features become available once the HTMX migration is complete and Stash is running as a pure Go/Wails application. They are not part of the migration itself — they are the payoff for doing it.

---

## 1. System Tray + Quick Capture

The single biggest UX improvement possible for a daily-driver notes app.

**What it enables:**
- Stash runs persistently in the background. The main window can be closed (not quit) and the app stays alive in the tray.
- A tray menu gives one-click access: Open Stash, New Note, Quit.
- A global shortcut (e.g. `Cmd+Shift+Space`) opens a small **quick-capture window** — frameless, focused, ready to type. You write, hit Enter or `Cmd+S`, the note saves as a buffer, the window closes. No need to open the full app.
- Tray tooltip can show pending AI job count or unread capture count.

**Implementation outline:**
```go
// In options.App
SystemTray: &options.SystemTray{
    Icon: trayIconBytes,
    Menu: trayMenu,
},
OnDomReady: func(ctx context.Context) {
    runtime.WindowHide(ctx) // start hidden, tray brings it up
},
```

**Quick-capture window** is a secondary Wails window (see section 3) — small, fixed-size, no decorations, appears on shortcut, saves a buffer via the existing `BufferService`, SSE notifies the main window sidebar to refresh.

**Why do it after migration:** The quick-capture window needs to make HTTP calls to the same Go router (`POST /api/buffer/new`). That router doesn't exist until the HTMX migration is done.

---

## 2. Native Context Menus

Right-click menus in Stash are currently positioned HTML `<div>`s (~244 lines in `NoteContextMenu.tsx`, replaced by Go templates + small JS during migration). Native OS context menus are a step further.

**What changes:**
- Right-click on a note/folder triggers `runtime.ShowContextMenu()` — an actual OS context menu, not a WebView element
- Items call Go functions directly
- Menus respect system font, size, accessibility settings, and dark/light mode automatically
- No viewport-clamping logic, no z-index issues, no "click outside to close" JS

**Implementation outline:**
```go
contextMenu := menu.NewMenuFromItems(
    menu.Text("Open", nil, func(_ *menu.CallbackData) { app.openNote(uuid) }),
    menu.Text("Rename...", nil, func(_ *menu.CallbackData) { app.renameNote(uuid) }),
    menu.Separator(),
    menu.Text("Delete", nil, func(_ *menu.CallbackData) { app.deleteNote(uuid) }),
)
runtime.ShowContextMenu(ctx, contextMenu, x, y)
```

The HTML element still needs to detect the right-click and call a Go function (via a small JS event listener) to pass the UUID and screen coordinates. The menu itself is then entirely native.

**Trade-off:** Slightly more effort to coordinate between the WebView click event and the Go-side menu. Benefit: zero CSS, zero JS positioning logic, correct OS behaviour on all platforms.

---

## 3. Multiple Windows — Dedicated Capture Window

Wails v2 supports secondary windows via `runtime.WindowCreate()`. Wails v3 makes this significantly cleaner (see section 4).

**The use case:** A dedicated quick-capture window that is:
- Small (400×200), centred, frameless
- Opens on a global shortcut or tray menu click
- Pre-focused (cursor in editor immediately)
- Has no sidebar, no tab bar — just a TipTap editor and a save button
- On save: buffer created, window closes, main window sidebar refreshes via SSE

**Why this is better than a modal in the main window:**
- Works even when the main window is closed/hidden (tray use case)
- Can be on a different Space/desktop than the main window
- Faster to appear — doesn't depend on the main window's WebView being loaded

**Implementation outline (v2):**
```go
runtime.WindowCreate(ctx, &options.App{
    Width: 400, Height: 200,
    Frameless: true,
    AlwaysOnTop: true,
    AssetServer: &assetserver.Options{Assets: captureAssets},
    Bind: []interface{}{captureApp},
})
```

The capture window has its own minimal asset set (just `editor.js` + TipTap, no sidebar or tab bar templates).

---

## 4. Wails v3 — Cross-Platform Builds from Linux CI

Wails v3 is in active use and production-ready for many projects. The architectural improvements most relevant to Stash:

**Cross-compilation from Linux:**
Wails v3 supports building macOS `.app` bundles from a Linux host using `osxcross`. This means your Forgejo instance (running on Linux) can build and sign macOS releases without needing a macOS runner. The workflow:
```
Forgejo runner (Linux) → go build with Wails v3 → macOS .app + Linux binary
```
This is the path to proper CI/CD: push a tag, Forgejo builds all targets, attaches binaries to the release.

**Other v3 improvements relevant to Stash:**
- No more `wailsjs/` auto-generated bindings — you've already eliminated these with the HTMX migration, so upgrading from v2 to v3 becomes trivial
- Cleaner multi-window API — the capture window pattern (section 3) is first-class in v3, not bolted on
- Plugin system — if you ever want to extend Stash with user plugins
- Better Linux WebKit support (important if you want Stash to run well on Linux desktops)

**Upgrade path:** Because the HTMX migration removes all the generated TypeScript bindings, a v2 → v3 upgrade reduces to:
1. Update `go.mod` to v3
2. Update `main.go` Wails init (API changed slightly)
3. Update asset embedding (minor)
4. Done — no frontend changes because there is no generated frontend

**Timing:** Do the HTMX migration first, then evaluate v3. The migration makes the v3 upgrade a half-day job rather than a week.

---

## Suggested Order

| Feature | Depends on | Effort |
|---------|-----------|--------|
| System Tray | Migration complete | Small |
| Quick-capture window | System Tray + `/api/buffer/new` endpoint | Medium |
| Native context menus | Migration complete | Medium |
| Wails v3 upgrade | Migration complete | Small (because no generated bindings) |
| Cross-platform CI on Forgejo | Wails v3 | Medium (CI config) |
