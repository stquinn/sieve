# Vision: Sieve as a Go Server + S3-Backed Web App

## What This Is

A long-horizon architectural direction, not a near-term goal. The purpose of writing it down is to ensure day-to-day decisions don't accidentally close off this path. It costs nothing to keep the door open; it costs a lot to reopen it once shut.

---

## The Core Idea

Sieve today is a Wails desktop app — a Go HTTP server wrapped in a WebView, talking to a local filesystem. The observation is that the "desktop" part is increasingly thin:

- All meaningful logic lives in the Go HTTP layer
- The frontend is HTMX + vanilla JS — browser-native, no desktop APIs
- The store is already abstracted behind a `store.Store` interface
- The AI integration runs server-side

Strip Wails, point the store at S3, and Sieve becomes a web app accessible from any browser or mobile device — with no fundamental architectural change to the application logic.

---

## What Changes

### Wails → Go HTTP server

`wails.Run()` becomes `http.ListenAndServe()`. The `App` struct lifecycle hooks (`startup`, `domReady`, `beforeClose`) move to standard server startup/shutdown. This is a `main.go` and `app.go` change, not an application change.

After the current `window.sieve*` cleanup and Wails binding replacement work, the delta is approximately one focused day.

### FileStore → S3Store

The `store.Store` interface is the only layer that touches disk. An `S3Store` implementation is a drop-in. The rest of the application — handlers, services, editor, templates — does not change.

**S3 versioning** replaces the current custom document version store. Every save is an object version; history and restore become S3 API calls.

**Assets** (images, attachments) are stored in S3 but served proxied through Go. S3 is not exposed publicly.

### File Watcher → Gone

`watcher.go` exists to detect changes made to files outside Sieve. In a server model, Sieve owns all writes — there are no external editors. The watcher is removed, not replaced.

### `window.runtime.*` → Browser equivalents

A handful of Wails-specific JS calls:

| Wails call | Replacement |
|------------|-------------|
| `window.runtime.BrowserOpenURL(url)` | `target="_blank"` or `GET /api/open-url` redirect |
| `window.runtime.ShowInExplorer(path)` | Removed — no browser equivalent |

---

## What Stays the Same

- The entire HTTP router and all request handlers
- All Go templates and HTMX fragments
- TipTap, vanilla JS extensions, the editor island
- The AI CLI integration (`sieve/cli.go`) — runs server-side unchanged
- SSE hub — standard HTTP, no Wails dependency
- The `store.Store` interface and all code above it

---

## What This Enables

**Any browser, any device.** Open `app.sieve.io` (or `localhost:PORT`) and the full editor is there. No install, no desktop app distribution, no auto-update infrastructure.

**Mobile.** A mobile-optimised frontend (or a native app with a web backend) becomes viable once the server exists. The Go layer is already the API.

**Sync across devices.** S3 as the store means files are inherently available everywhere. No sync daemon, no conflict resolution — S3 object versioning handles it.

**Self-hosted.** `docker run sieve` pointing at an S3 bucket or compatible store (Backblaze, MinIO, Cloudflare R2). Single binary, no dependencies.

**Multi-user (longer term).** The store abstraction already separates "a store" from "whose store". Namespacing S3 keys by user ID is the only addition needed. Auth is a separate concern.

---

## Guardrails — What Not To Do

The risk this document is guarding against is making decisions today that foreclose this path tomorrow. The guardrail is about **layers**, not about avoiding desktop features entirely.

Sieve is desktop-first in the short-to-medium term. System tray, quick capture window, native context menus — these are fine. They are UI shell features that wrap the HTTP API without changing it. A web or mobile frontend would call the same endpoints; it just wouldn't have the tray. These features don't close off anything.

What to avoid:

- **Desktop APIs in the service or handler layer** — `window.runtime.*`, Wails IPC, OS-specific calls belong in the UI shell (`app.go`, `main.go`), not in `requesthandlers/` or `sieve/`. If a handler needs to do something desktop-specific, it should accept a callback or interface, not call Wails directly.
- **Writing to the local filesystem outside the store** — all persistence goes through `store.Store`. Don't open files directly in handlers or services.
- **Absolute OS paths crossing layer boundaries** — paths passed between the store and the rest of the app should be store-relative, not absolute OS paths. The store knows where it lives; nothing above it should.
- **Hardcoding single-user assumptions in the API** — avoid making "the store" a package-level singleton if it can be scoped per request or session.

The test: if a new feature works identically when `FileStore` is swapped for `S3Store`, the guardrail is satisfied. Desktop UI sugar that calls the same HTTP endpoints passes automatically.

---

## Desktop Features and the Web Equivalent Problem

Adding native desktop features (system tray, native context menus, OS-level global shortcuts) is fine and expected. The catch is that each native feature needs a web equivalent — or at minimum a graceful no-op — when running as a server.

The solution is a thin `UIShell` interface at the app boundary:

```go
type UIShell interface {
    RegisterShortcut(key string, handler func())
    ShowContextMenu(items []MenuItem, x, y int)
    SetTrayStatus(label string)
}
```

- `WailsShell` — implements via `window.runtime.*`, Wails menus, OS shortcuts
- `WebShell` — implements via HTTP responses, the existing HTML context menu, browser keyboard events. Features with no web equivalent (system tray) are no-ops.

Handlers and services call `UIShell`, never Wails directly. This means native features can be added freely without coupling the application logic to the desktop runtime.

**In practice:** keyboard shortcuts are already browser events and work identically on web. Native context menus are the main switching point — `WailsShell` triggers an OS menu, `WebShell` falls back to the HTML `<div>`-based context menu already in place. The feature set is the same; the chrome is different.

---

## Timeline

Not soon. The current priority order is:

1. AI block fenced JSON migration
2. Rich link cards
3. `window.sieve*` global cleanup + Wails binding replacement
4. Feature backlog (formatting bar, gutter, version diff)

The Go server + S3 direction becomes relevant once the codebase is clean and the desktop app is stable. At that point, the work is incremental — not a rewrite.
