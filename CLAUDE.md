# Sieve

Scratchpad-first thinking tool. Users write freely in untitled buffers; filing/keep/discard decisions happen on close.

**Stack:** Wails v2 + Go + chi + HTMX + vanilla JS + TipTap 2 + Tailwind
**Phase:** Phase 10 (post-migration cleanup). Phase 9 (React removal) is complete — no React, no npm build step.

---

## Key File Locations

> **Go package layout (S-A decomposition, 2026-06-20; DAG corrected 2026-08-12).** `sieve/` is no longer a flat package — it is 6 cohesive packages with an acyclic DAG. The **real** import direction is `domain ← services ← ai ← block ← block/processors`, with the root wiring everything. Read it that way round: `services/` imports nothing from `block/`, and it **cannot** — `block/` holds a concrete `*ai.AIService` (`processor_registry.go`) and `ai/` imports `services/`, so a `services → block` edge would close a cycle. **Put a type shared by a service and a block in `domain/`**, never in `block/`.
>
> The remaining **port interfaces owned by `block/`** (`DocumentsPort`/`NodesPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`/`PlantumlPort`) keep *processors* off concrete services and make them stubbable in tests — they are not breaking a cycle. `AIPort` was **deleted**: it inverted an edge that never needed inverting (see the note in `processor_registry.go`), which is why `BlockServices.AI` is concrete while its siblings are ports. See `docs/design/archive/specs/2026-06-20-flat-package-decomposition-design.md` for the original split (its DAG predates the `AIPort` removal).

| What | Where |
|------|-------|
| Wails App struct + lifecycle | `app.go` |
| Composition root (DI: wires ports, registers processors) | `sieve/service_provider.go` (package `sieve`, root) |
| **Block model + codec + registry + ports** | `sieve/block/` (SieveBlock, DocumentCodec, RegionScanner, ShadowDocument, ports.go, processor_registry.go) |
| **Block processors** (8 concrete flavours) | `sieve/block/processors/` (code, diagram, log, prose, smart-image/card, web-clip, ai-block) |
| **Domain leaf types** (persistent) | `sieve/domain/` (Document, Buffer, Note, Session, Settings, Categories, ImageAsset, FilingRecommendation, ImageDesc, LinkPreviewResult) |
| **Services** (persistence) | `sieve/services/` (DocumentService, AssetService, StateService, JobTracker, JobEngine, LinkPreviewService, LibraryService, PlantumlService) |
| **Editor** (the only package that sees both `block/` and `services/`) | `sieve/editor/` (EditorService, Router + NotesSource = address → Node, IdentitySweeper) |
| **AI subsystem** | `sieve/ai/` (AIService, cli.go=RunCLI [future API-backend swap point], prompts, eval helpers, image_localise) |
| HTTP router assembly (App-bound: index + /sse + /static wiring) | `handlers.go` (root, `apiHandler`) |
| Request-handler registration (builds & mounts all handlers) | `requesthandlers/registry.go` (`Registry.Mount`) |
| One file per HTTP concern | `requesthandlers/*.go` |
| Go HTML templates (HTMX fragments) | `frontend/src/templates/*.html` |
| Static JS/CSS | `frontend/src/static/` |
| App entry point (Go template) | `frontend/src/index.html` |
| TipTap editor component hierarchy | `frontend/src/static/editor/abstract-editor.js` (base) + `note-editor.js`/`prompt-editor.js` (concrete) + `editor-shell.js` (back-compat `window.SieveEditor` alias); mounted at `#tiptap-mount` |
| **Protocol services (wire owners)** | `frontend/src/static/block/block-service.js` (owns the DOCUMENT wire: channel-per-uuid, opId ack correlation, routing index + id→SieveBlock truth-mirror) + `document-service.js` (load/save/raw-content family, export, paste pipelines) + `workspace-service.js` (owns the SESSION wire — one socket, many tenants: tenants claim inbound frame `type` words, unclaimed frames drop; #74 P1) + `command-service.js` (a TENANT of it: slash-command dispatch, correlation-id ack routing, cancellation) + `mention-service.js` (the second tenant: the `@` picker's `mention-query`/`mention-result` typeahead; #74 P4). Surfaces/editors are transport-blind — no fetch/WS outside these five for protocol traffic (#49) |
| **Block renderer classes** (look-and-feel, PM-free) | `frontend/src/static/block/renderers/` — `BlockRenderer` base, `RendererStyleRegistry`, `StatusBadge`, `LineGutter`, one concrete renderer + sibling `*.styles.js` per migrated kind; shared utilities live here too (`html-escape.js`, `job-status.js`, `sanctioned-markdown.js`, `highlighting.js`, `vendor-libs.js` = bundled non-PM lib seam) |
| NodeView PM adapters (thin, composition over a renderer) | `frontend/src/static/editor/surfaces/node-views/*-node-view.js` (moved+renamed from `processors/*-renderer.js` 2026-07-21 — they are NodeViews, and PM enters the JS graph only in surfaces) |
| Custom TipTap extensions (vanilla JS) | `frontend/src/static/editor/extensions.js` |
| Pre-built TipTap core bundle | `frontend/src/static/vendor/tiptap.js` |
| **Identity (all ids)** | `ident/` (`New` = UUIDv7, `Valid`) — a leaf BELOW `store/` and `sieve/`, because `store/` cannot import `sieve/` |
| Store abstraction + FileStore | `store/interfaces.go`, `store/filestore/` |
| SSE hub | `sse/` (package `sse`: `Hub`, `NewHub`) |
| File watcher | `watcher/` (package `watcher`: `NotesWatcher`, `New`) |
| Tech debt register | `docs/TECH-DEBT.md` |
| **Editor interaction contract (NORMATIVE)** | `docs/editor-interaction-contract.md` |
| **Docs layout** | `docs/` root = long-lived contracts, behaviour specs, living registers, how-tos. `docs/design/` = design history: brainstorms + `specs/` + `plans/` (legacy) + `archive/`. `docs/design/specs/` = design/decision docs (thin: problem, decision, architecture, rationale); header carries `Tracked: #N` when work is active. Plans are Forgejo issues, NOT files (epic issue + per-phase issues for large work; drafted in scratchpad → posted via `tea api`; reviewed on the issue) — `docs/design/plans/` holds legacy plans only, never add to it. Completed/superseded specs are stamped with a status banner and `git mv`'d to `docs/design/archive/specs/` in the same change that closes their issue. |
| Current milestone plan | `docs/FEATURE-BACKLOG.md` (PHASE9 completed → `docs/design/archive/PHASE9-PLAN.md`) |
| **How to build a Sieve block** | `docs/how-to-intelligent-fenced-blocks.md` (current) — supersedes `docs/how-to-sieve-block-framework.md` (STALE, banner'd, pending rewrite) |
| **How to build a fenced block** | `docs/how-to-intelligent-fenced-blocks.md` |
| **How to write idiomatic JS (NORMATIVE for new JS)** | `docs/how-to-idiomatic-js.md` |
| TipTap/PM vendor seam (the ONLY PM read point) | `frontend/src/static/editor/surfaces/tiptap-vendor.js` — editor/surfaces/ is THE PM package; `base/` holds only `icons.js`/`globals.js` (X-C quarantine; `fenced-block-base.js` dissolved into `block/renderers/` by #49 P5) |

---

## Code Navigation
Prefer the `language-server` MCP tools over grep/bash for code navigation tasks:
- Use `get_references` to find usages of a symbol
- Use `get_definition` to navigate to a definition
- Use `get_diagnostics` for compiler errors
- Only fall back to grep if the language server tool fails

---

## Build & Dev

Dev env is a **nix flake** (`nix develop`, or `direnv`/`.envrc` = `use flake`). The
flake's devShell ships a `wails` wrapper (a real store package, `wailsWrapped`) that
injects `-tags webkit2_41` into `dev`/`build` transparently — so bare `wails dev`
works. `shell.nix` is gone; `nix develop` is the sole entry point.

```bash
wails dev        # hot-reload; flake wrapper adds -tags webkit2_41 transparently
wails build      # production binary
go build ./...   # compile check — no npm step required
```

**Tailwind:** `npx tailwindcss -i frontend/src/static/input.css -o frontend/src/static/tailwind.css`
— content paths must include `frontend/src/templates/**/*.html` and `frontend/src/index.html`.

**TipTap bundle:** rebuild only when TipTap core/deps change: `npm run bundle:tiptap` in `frontend/`.
Custom extensions live in `extensions.js` (vanilla JS) — they are NOT in the bundle.

**Third-party credits:** `third-party-licenses.json` (repo root, go:embed'ed, rendered by the
Help → Open Source Licenses dialog) is GENERATED — never hand-edit. Regenerate only when deps change (`go.mod`,
`frontend/package.json`, bundle entries): `nix develop -c go run ./tools/gencredits`
(needs network on first run). The tool fails the run if a copyleft license appears in a
bundled component. Output must be deterministic across toolchains, and BOTH halves of the
Go stdlib entry are pinned to make it so: the **version** comes from go.mod's `go`
directive (not `go env GOVERSION`), and the **license text** comes from `$GOROOT/LICENSE`
only — never a walk of GOROOT, which holds ~20 vendored licenses whose shallowest is
BoringSSL's (nix omits the top-level LICENSE, so a walk shipped OpenSSL's text as the Go
stdlib's; fixed `b7e8967`, pinned by `tools/gencredits/go_license_test.go`, with
`tools/gencredits/go-license.txt` as the fallback for toolchains that omit the file) —
CI's `credits` job regenerates and diffs, failing
the pipeline if a dep change lands without a regen; releases ship the committed artifact
and never regenerate. Sieve itself is Apache-2.0 (`LICENSE` + `NOTICE` at root).

**Embeds** (in `embeds.go` — go:embed paths are relative to the declaring file and cannot climb, so these stay at root and are threaded into `newAPIHandler`):
- `//go:embed frontend/src/templates` → Go templates
- `//go:embed frontend/src/static` → static files served at `/static/`
- `//go:embed frontend/src/index.html` → app shell

---

## Architecture in One Paragraph

`main.go` constructs the SSE hub (`sse.NewHub`, package `sse`) and the `App`, then builds the root `apiHandler` (`handlers.go`). `apiHandler` owns the chi router and the index/`/sse`/`/static` wiring (it stays in package main because it reads live `App` store state); it delegates registration of the per-concern `RequestHandler`s (one struct per concern in `requesthandlers/`) to `requesthandlers.Registry.Mount`. The file watcher lives in package `watcher` (`watcher.New`), constructed by `App` at startup. Handlers call `sieve.ServiceProvider` (the composition root, package `sieve`) which constructs the concrete services and wires them into `block.BlockServices` as **port interfaces**. The block model (`block/`: SieveBlock, DocumentCodec, RegionScanner, ShadowDocument) is a leaf that depends only on `domain/` — processors and services depend on it, never the reverse. `ai/` (AIService + CLI) implements `block.AIPort`. The Store abstraction (`store.Store`) is the only layer that touches disk — `filestore.FileStore` implements it. The frontend is HTMX: Go templates render HTML fragments on request; SSE events (`notes:changed`, `session:changed`, etc.) trigger HTMX swaps. TipTap runs as a class-based editor component (`AbstractEditor` + concrete `NoteEditor`/`PromptEditor`, `frontend/src/static/editor/`) mounted in `#tiptap-mount`.

---

## Design Principles

- **JS is written with the same OOP discipline as Go (2026-07-08).** "Vanilla JS" is a LANGUAGE choice — plain JavaScript, no React/JSX/TypeScript (complexity the maintainer doesn't carry); build steps (esbuild, tailwind) and libraries are fine and already exist. It is never an excuse for loose function bags: new JS is real ES classes with constructors and `#private` fields; shared values are `Object.freeze`d; public contracts carry JSDoc types checkable via `// @ts-check` (`tsc --noEmit` — types in comments, code stays JS). No new IIFE namespace bags, no state as module-scope `var`s, no `window.*` buses — the existing ones are quarantined debt (X-C, epic #31), not precedent. Idioms + enforcement: `docs/how-to-idiomatic-js.md`. Architectural context: `docs/design/specs/2026-07-08-workspace-editor-component-model.md` §Design discipline.
- **No loose/free functions (OOP cohesion).** Behaviour belongs as a **method on the type or service that owns its data** — not a package-level `func`. If a function genuinely has no owning type, attach it to a Utilities service; it does not float. Dangling package-level symbols hide their callers, which is exactly what made the S-A package split painful. Data mutations live with the data (e.g. block ops + snapshots are `ShadowDocument` methods; serialize/deserialize are `BlockProcessor`/`DocumentCodec` methods; paste-matching is a registry method `FirstPasteMatch`). **Known backlog applying this:** `block/`'s codec/parser still has free funcs (`scanProseRegion`, `mdParser`, goldmark helpers, `handle_gc`'s `gcRefs`/`gcAliases`) and `ai/eval` helpers — attach them to their owning type as opportunity allows.
- **Tests live with the type they exercise.** A test that touches a type's internals (`Attrs`, unexported methods, the mutex) is white-box and belongs **in that type's package**. Cross-package tests use the public method API only — never add a construction seam to poke across a package boundary. Editor-mechanic tests use a **FakeBlock**; only prose-*specific* tests need the real `ProseProcessor` (which lives in `block/processors/`).

---

## Non-Obvious Rules

- **Backend is the document source of truth** — any op that mutates the doc **in Go** (paste, extract, transform, promote, AI-block create) renders by **placing the server's authoritative node at the server's index** as a **tracked** PM transaction: insert at `docPosForBlockIndex(msg.index)`, or replace-by-block-id for transform. The frontend reads the caret to pick an index and sends it to Go; Go creates there and echoes `msg.index` back. JS must NOT compute doc state/position or splice JS-chosen content (retired `replaceSource`/`sieveInsertPos`-range path); it only places the server's node. **Do NOT full-reload (`softReloadContent`) for an operation — `renderBlocksIntoEditor`'s `replaceWith + addToHistory:false` wipes undo history.** Full reload is only for genuine doc *loads* (open/restore/library-switch/AI whole-doc). Prose the editor already holds is skipped (baseline, no re-insert); scroll-to-new is universal.
- **All ids are UUIDs, minted only by `ident.New`** (#75) — documents and blocks alike. Ids are **opaque**: no kind prefix, nothing may infer a block's kind from its id, and nothing displays one. A block id lives in TWO places and both must be written together — the `SieveBlock.ID` field *and* `Attrs["id"]` — because the WYSIWYG wire and the fenced serializer read it out of `Attrs`; use `reidentify`, never a bare field assignment. Legacy short handles are upgraded by `BlockIdentityMigrator` on the document load path (`NewShadow`), never inside `DocumentCodec.Deserialize`, which stays a pure parse; `EditorService.open` flushes that upgrade synchronously so ids are stable from first open. `/migrate-ids` sweeps documents nobody has opened.
- **An alias is a NAME, not an identity** — durable, given only by a deliberate act (a declared name, a domain-meaningful handle), unique only *within* its document, and never auto-minted or garbage-collected. Migration creates none. Cross-document coordinates use `domain.Address` (`container:{uuid}[@v{n}]`, `block:{uuid}`, `block:{container-uuid}[@v{n}]/{handle}`); there is deliberately no bare `block:{alias}` form, so an alias cannot leave its document.
- **`user_intent` is user-owned** — AI must never write `Tab.UserIntent`. It signals "keep" or "trash" and is set only by explicit user action.
- **Frontmatter** — stripped before content reaches TipTap; re-prepended on save. Never pass raw frontmatter to the editor.
- **CLI stdin** — `sieve/cli.go` `RunCLI` passes prompts via stdin to `claude --print --no-session-persistence`. Never use `sh -c` with a double-quoted prompt — backticks in fenced code blocks get shell-expanded and silently erased.
- **CLI timeout** — 20s default, configurable via `cli_timeout` in settings.json.
- **No React** — Phase 9 is done. Do not introduce React, JSX.
- ** Any npm dependencies must be Vanilla JS and discuss first.
- **`window.sieve*` globals** — thin JS wrappers over Go HTTP calls (tech debt X-B); they exist in `frontend/src/index.html`. New work should use direct `hx-post`/`hx-get` attributes instead.
- **SSE events** — `notes:changed`, `session:changed`, `prompts:changed`, `editor:saved`, `ai:progress`. Broadcast via `hub.broadcast(event, data)` in Go handlers.
- **Editor interaction contract** — `docs/editor-interaction-contract.md` is NORMATIVE. New block kinds declare `interactionPolicy` (see `frontend/src/static/editor/interaction-policy.js` DEFAULT_POLICY); per-renderer `handleKeyDown` for Tab/Enter/Home/arrows is FORBIDDEN — the shared policy extension owns them (Tab = priority-50 backstop after native keymaps; Enter family = pre-core via editorProps; the module header explains why). Any interaction change MUST update the contract doc in the same change. Key chords: Shift+Enter = universal block escape; Mod+Enter = mode toggle for kinds declaring `modEnterTogglesMode` + `onModEnter`.
