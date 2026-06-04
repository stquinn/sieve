# Sieve

Scratchpad-first thinking tool. Users write freely in untitled buffers; filing/keep/discard decisions happen on close.

**Stack:** Wails v2 + Go + chi + HTMX + vanilla JS + TipTap 2 + Tailwind
**Phase:** Phase 10 (post-migration cleanup). Phase 9 (React removal) is complete — no React, no npm build step.

---

## Key File Locations

| What | Where |
|------|-------|
| Wails App struct + lifecycle | `app.go` |
| All services (DI container) | `sieve/service_provider.go` |
| Session + Settings types | `sieve/session.go`, `sieve/settings.go` |
| HTTP router + handler registration | `handlers.go` |
| One file per HTTP concern | `requesthandlers/*.go` |
| Go HTML templates (HTMX fragments) | `frontend/src/templates/*.html` |
| Static JS/CSS | `frontend/src/static/` |
| App entry point (Go template) | `frontend/src/index.html` |
| TipTap vanilla island | `frontend/src/static/editor.js` |
| Custom TipTap extensions (vanilla JS) | `frontend/src/static/extensions.js` |
| Pre-built TipTap core bundle | `frontend/src/static/vendor/tiptap.js` |
| AI + CLI integration | `sieve/ai_service.go`, `sieve/cli.go` |
| Store abstraction + FileStore | `store/interfaces.go`, `store/filestore/` |
| SSE hub | `sse.go` |
| File watcher | `watcher.go` |
| Tech debt register | `docs/TECH-DEBT.md` |
| Current milestone plan | `docs/PHASE9-PLAN.md` (completed), `docs/FEATURE-BACKLOG.md` |
| Current Guuidance on how to use the Sieve Block Framework | `docs/how-to-sieve-block-framework.md` |
| **How to build a fenced block** | `docs/how-to-intelligent-fenced-blocks.md` |
| Shared fenced block JS base | `frontend/src/static/fenced-block-base.js` |

---

## Code Navigation
Prefer the `language-server` MCP tools over grep/bash for code navigation tasks:
- Use `get_references` to find usages of a symbol
- Use `get_definition` to navigate to a definition
- Use `get_diagnostics` for compiler errors
- Only fall back to grep if the language server tool fails

---

## Build & Dev

```bash
wails dev        # hot-reload; shell.nix adds -tags webkit2_41 transparently
wails build      # production binary
go build ./...   # compile check — no npm step required
```

**Tailwind:** `npx tailwindcss -i frontend/src/static/input.css -o frontend/src/static/tailwind.css`
— content paths must include `frontend/src/templates/**/*.html` and `frontend/src/index.html`.

**TipTap bundle:** rebuild only when TipTap core/deps change: `npm run bundle:tiptap` in `frontend/`.
Custom extensions live in `extensions.js` (vanilla JS) — they are NOT in the bundle.

**Embeds** (in `handlers.go`):
- `//go:embed frontend/src/templates` → Go templates
- `//go:embed frontend/src/static` → static files served at `/static/`
- `//go:embed frontend/src/index.html` → app shell

---

## Architecture in One Paragraph

`main.go` builds a chi router and SSE hub. `handlers.go` registers each `RequestHandler` (one struct per concern in `requesthandlers/`). Handlers call `sieve.ServiceProvider` which owns all services (DocumentService, StateService, AIService, PromptService, AssetService). The Store abstraction (`store.Store`) is the only layer that touches disk — `filestore.FileStore` implements it. The frontend is HTMX: Go templates render HTML fragments on request; SSE events (`notes:changed`, `session:changed`, etc.) trigger HTMX swaps. TipTap runs as a vanilla JS island (`editor.js`) mounted in `#editor-container`.

---

## Non-Obvious Rules

- **`user_intent` is user-owned** — AI must never write `Tab.UserIntent`. It signals "keep" or "trash" and is set only by explicit user action.
- **Frontmatter** — stripped before content reaches TipTap; re-prepended on save. Never pass raw frontmatter to the editor.
- **CLI stdin** — `sieve/cli.go` `RunCLI` passes prompts via stdin to `claude --print --no-session-persistence`. Never use `sh -c` with a double-quoted prompt — backticks in fenced code blocks get shell-expanded and silently erased.
- **CLI timeout** — 20s default, configurable via `cli_timeout` in settings.json.
- **No React** — Phase 9 is done. Do not introduce React, JSX.
- ** Any npm dependencies must be Vanilla JS and discuss first.
- **`window.sieve*` globals** — thin JS wrappers over Go HTTP calls (tech debt X-B); they exist in `frontend/src/index.html`. New work should use direct `hx-post`/`hx-get` attributes instead.
- **SSE events** — `notes:changed`, `session:changed`, `prompts:changed`, `editor:saved`, `ai:progress`. Broadcast via `hub.broadcast(event, data)` in Go handlers.
