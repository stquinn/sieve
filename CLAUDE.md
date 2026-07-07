# Sieve

Scratchpad-first thinking tool. Users write freely in untitled buffers; filing/keep/discard decisions happen on close.

**Stack:** Wails v2 + Go + chi + HTMX + vanilla JS + TipTap 2 + Tailwind
**Phase:** Phase 10 (post-migration cleanup). Phase 9 (React removal) is complete — no React, no npm build step.

---

## Key File Locations

> **Go package layout (S-A decomposition, 2026-06-20).** `sieve/` is no longer a flat package — it is 6 cohesive packages with an acyclic DAG: `domain ← block ← {block/processors, services} ← ai ← root`. The cycle is broken by **port interfaces owned by `block/`** (`AIPort`/`DocumentsPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`); concrete services implement them, the root wires them. `block/` imports no service. See `docs/design/archive/superpowers/specs/2026-06-20-flat-package-decomposition-design.md`.

| What | Where |
|------|-------|
| Wails App struct + lifecycle | `app.go` |
| Composition root (DI: wires ports, registers processors) | `sieve/service_provider.go` (package `sieve`, root) |
| **Block model + codec + registry + ports** | `sieve/block/` (SieveBlock, DocumentCodec, RegionScanner, ShadowDocument, ports.go, processor_registry.go, markdown_parser.go) |
| **Block processors** (9 concrete flavours) | `sieve/block/processors/` (code, diagram, log, prose, smart-image/link/card, web-clip, ai-block) |
| **Domain leaf types** (persistent) | `sieve/domain/` (Document, Buffer, Note, Session, Settings, Categories, ImageAsset, FilingRecommendation, ImageDesc, LinkPreviewResult) |
| **Services** (persistence + editor) | `sieve/services/` (DocumentService, AssetService, StateService, JobTracker, LinkPreviewService, LibraryService, EditorService) |
| **AI subsystem** | `sieve/ai/` (AIService, cli.go=RunCLI [future API-backend swap point], prompts, eval helpers, image_localise) |
| HTTP router + handler registration | `handlers.go` |
| One file per HTTP concern | `requesthandlers/*.go` |
| Go HTML templates (HTMX fragments) | `frontend/src/templates/*.html` |
| Static JS/CSS | `frontend/src/static/` |
| App entry point (Go template) | `frontend/src/index.html` |
| TipTap vanilla island | `frontend/src/static/editor.js` |
| Custom TipTap extensions (vanilla JS) | `frontend/src/static/extensions.js` |
| Pre-built TipTap core bundle | `frontend/src/static/vendor/tiptap.js` |
| Store abstraction + FileStore | `store/interfaces.go`, `store/filestore/` |
| SSE hub | `sse.go` |
| File watcher | `watcher.go` |
| Tech debt register | `docs/TECH-DEBT.md` |
| **Editor interaction contract (NORMATIVE)** | `docs/editor-interaction-contract.md` |
| **Docs layout** | `docs/` root = long-lived contracts, behaviour specs, living registers, how-tos. `docs/design/` = design history: brainstorms, one-off specs/plans, `superpowers/{specs,plans}` (write NEW superpowers specs/plans there), `archive/`. Completed/superseded specs & plans are stamped with a status banner and `git mv`'d to `docs/design/archive/superpowers/{specs,plans}/` in the same change that retires their register entry. |
| Current milestone plan | `docs/FEATURE-BACKLOG.md` (PHASE9 completed → `docs/design/archive/PHASE9-PLAN.md`) |
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

`main.go` builds a chi router and SSE hub. `handlers.go` registers each `RequestHandler` (one struct per concern in `requesthandlers/`). Handlers call `sieve.ServiceProvider` (the composition root, package `sieve`) which constructs the concrete services and wires them into `block.BlockServices` as **port interfaces**. The block model (`block/`: SieveBlock, DocumentCodec, RegionScanner, ShadowDocument) is a leaf that depends only on `domain/` — processors and services depend on it, never the reverse. `ai/` (AIService + CLI) implements `block.AIPort`. The Store abstraction (`store.Store`) is the only layer that touches disk — `filestore.FileStore` implements it. The frontend is HTMX: Go templates render HTML fragments on request; SSE events (`notes:changed`, `session:changed`, etc.) trigger HTMX swaps. TipTap runs as a vanilla JS island (`editor.js`) mounted in `#editor-container`.

---

## Design Principles

- **No loose/free functions (OOP cohesion).** Behaviour belongs as a **method on the type or service that owns its data** — not a package-level `func`. If a function genuinely has no owning type, attach it to a Utilities service; it does not float. Dangling package-level symbols hide their callers, which is exactly what made the S-A package split painful. Data mutations live with the data (e.g. block ops + snapshots are `ShadowDocument` methods; serialize/deserialize are `BlockProcessor`/`DocumentCodec` methods; paste-matching is a registry method `FirstPasteMatch`). **Known backlog applying this:** `block/`'s codec/parser still has free funcs (`scanProseRegion`, `mdParser`, goldmark helpers, `handle_gc`'s `gcRefs`/`gcAliases`) and `ai/eval` helpers — attach them to their owning type as opportunity allows.
- **Tests live with the type they exercise.** A test that touches a type's internals (`Attrs`, unexported methods, the mutex) is white-box and belongs **in that type's package**. Cross-package tests use the public method API only — never add a construction seam to poke across a package boundary. Editor-mechanic tests use a **FakeBlock**; only prose-*specific* tests need the real `ProseProcessor` (which lives in `block/processors/`).

---

## Non-Obvious Rules

- **Backend is the document source of truth** — any op that mutates the doc **in Go** (paste, extract, transform, promote, AI-block create) renders by **placing the server's authoritative node at the server's index** as a **tracked** PM transaction: insert at `docPosForBlockIndex(msg.index)`, or replace-by-block-id for transform. The frontend reads the caret to pick an index and sends it to Go; Go creates there and echoes `msg.index` back. JS must NOT compute doc state/position or splice JS-chosen content (retired `replaceSource`/`sieveInsertPos`-range path); it only places the server's node. **Do NOT full-reload (`softReloadContent`) for an operation — `renderBlocksIntoEditor`'s `replaceWith + addToHistory:false` wipes undo history.** Full reload is only for genuine doc *loads* (open/restore/library-switch/AI whole-doc). Prose the editor already holds is skipped (baseline, no re-insert); scroll-to-new is universal.
- **`user_intent` is user-owned** — AI must never write `Tab.UserIntent`. It signals "keep" or "trash" and is set only by explicit user action.
- **Frontmatter** — stripped before content reaches TipTap; re-prepended on save. Never pass raw frontmatter to the editor.
- **CLI stdin** — `sieve/cli.go` `RunCLI` passes prompts via stdin to `claude --print --no-session-persistence`. Never use `sh -c` with a double-quoted prompt — backticks in fenced code blocks get shell-expanded and silently erased.
- **CLI timeout** — 20s default, configurable via `cli_timeout` in settings.json.
- **No React** — Phase 9 is done. Do not introduce React, JSX.
- ** Any npm dependencies must be Vanilla JS and discuss first.
- **`window.sieve*` globals** — thin JS wrappers over Go HTTP calls (tech debt X-B); they exist in `frontend/src/index.html`. New work should use direct `hx-post`/`hx-get` attributes instead.
- **SSE events** — `notes:changed`, `session:changed`, `prompts:changed`, `editor:saved`, `ai:progress`. Broadcast via `hub.broadcast(event, data)` in Go handlers.
- **Editor interaction contract** — `docs/editor-interaction-contract.md` is NORMATIVE. New block kinds declare `interactionPolicy` (see `frontend/src/static/editor/interaction-policy.js` DEFAULT_POLICY); per-renderer `handleKeyDown` for Tab/Enter/Home/arrows is FORBIDDEN — the shared policy extension owns them (Tab = priority-50 backstop after native keymaps; Enter family = pre-core via editorProps; the module header explains why). Any interaction change MUST update the contract doc in the same change. Key chords: Shift+Enter = universal block escape; Mod+Enter = mode toggle for kinds declaring `modEnterTogglesMode` + `onModEnter`.
