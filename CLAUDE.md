# Sieve

Scratchpad-first thinking tool. Users write freely in untitled buffers; filing/keep/discard decisions happen on close.

**Stack:** Wails v2 + Go + chi + HTMX + vanilla JS + TipTap 2 + Tailwind
**Phase:** Phase 10 (post-migration cleanup). Phase 9 (React removal) is complete — no React, no npm build step.

---

## Key File Locations

> **Go package layout (S-A decomposition, 2026-06-20; DAG corrected 2026-08-12).** `sieve/` is no longer a flat package — it is 6 cohesive packages with an acyclic DAG. The **real** import direction is `domain ← services ← ai ← block ← block/processors`, with the root wiring everything. Read it that way round: `services/` imports nothing from `block/`, and it **cannot** — `block/` holds a concrete `*ai.AIService` (`processor_registry.go`) and `ai/` imports `services/`, so a `services → block` edge would close a cycle. **Put a type shared by a service and a block in `domain/`**, never in `block/`. The root block type is a domain type: `domain.SieveBlock` (with its `Elements`) and `domain.BlockContainer`, beside `Document`, hold a block's own data and every operation on it; `block/` holds what specialises around it — kinds, processors, the registry (`block.Registry`, which owns any reading of a block that depends on what its kind can do), codecs and the shadow document. `sieve/ink/` sits beside `block/processors` — it imports `services/`, `domain/` and `block/` (for its kind) and nothing above it but the composition root imports it; its `link/` imports no Sieve package and `radio/` is the only Bluetooth importer.
>
> The remaining **port interfaces owned by `block/`** (`DocumentsPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`/`PlantumlPort`) keep *processors* off concrete services and make them stubbable in tests — they are not breaking a cycle. `AIPort` was **deleted**: it inverted an edge that never needed inverting (see the note in `processor_registry.go`), which is why `BlockServices.AI` is concrete while its siblings are ports. One port is owned by `services/` instead: `ContainableKinds`, what `BlockContainerService` needs of the kinds a container can hold, expressed in `domain` types and implemented by `block.Registry` — this is what lets a service use kinds without importing `block/`. See `docs/design/archive/specs/2026-06-20-flat-package-decomposition-design.md` for the original split (its DAG predates the `AIPort` removal).

| What | Where |
|------|-------|
| Wails App struct + lifecycle | `app.go` |
| Composition root (DI: wires ports, registers processors) | `sieve/service_provider.go` (package `sieve`, root) |
| **Block model + codec + registry + ports** | `sieve/block/` (DocumentCodec, RegionScanner, ShadowDocument, Registry, ports.go, processor_registry.go) — the kinds and machinery around `domain.SieveBlock` |
| **Block processors** (9 concrete flavours) | `sieve/block/processors/` (code, diagram, log, prose, smart-image/card, web-clip, ai-block, reference) |
| **Domain leaf types** (persistent) | `sieve/domain/` (SieveBlock, Elements, BlockContainer, Document, Buffer, Note, Session, Settings, Categories, ImageAsset, FilingRecommendation, ImageDesc, LinkPreviewResult) |
| **Services** (persistence) | `sieve/services/` (DocumentService, AssetService, StateService, JobTracker, JobEngine, LinkPreviewService, LibraryService, PlantumlService, BlockContainerService) |
| **Block containers** (one block written directly to a file: a `kind:` line, then its YAML map; a sibling of Document) | `sieve/services/block_container_service.go` (BlockContainerService, which parses and renders a `domain.BlockContainer`; it reaches the kinds a container can hold through the `services.ContainableKinds` port, which `block.Registry` implements) |
| **Editor** (the only package that sees both `block/` and `services/`) | `sieve/editor/` (EditorService, Router + NotesSource + BlockSource = address → Node, IdentitySweeper, InspectionEngine + Inspector registry = the text-service lifecycle, SpellInspector = its first producer, FindInspector = find-and-replace, the producer that also writes) |
| **AI subsystem** | `sieve/ai/` (AIService, cli.go=RunCLI [future API-backend swap point], prompts, eval helpers, image_localise) |
| **Ink** (SieveInk companions) | `sieve/ink/` (InkService = dial → replicate → follow, link state, listeners, Settings → Notebooks status, page export; NoteReplicas = a companion's notes as digital-note block containers; DigitalNoteKind = the kind and its `.meta` face; StrokeBasedNote = the replay of a `strokes.jsonl` log and its §4.2 export page; OpenNotes/OpenNote = the notes held open for views, each held by the destinations (sockets) that asked its pages, answering pages and handing out stroke changes at the seq it reflects, restarted when its log is set aside; LiveView = the tablet's live view as a container of its own, kind `ink-live`, its uuid minted per run and stored nowhere — the Router's source for that uuid from the first live note until `LiveGrace` (30 s) after the last, its attrs naming the live note, page and waiting state beside that note's `note`/`note_device`, offered by name to a search that is not durable-only; Notebooks = the Router's source for Digital Notes, registered after the documents and before `BlockSource`: found by name, summary and keywords/categories read from `.meta` alone (`InkService.searchNotebooks`), resolved through `editor.BlockSource` behind the `ink.ContainerNodes` port; LivePen = live records as marks in page units; NoteNamer = names a settled note — no record for `ink.settle_seconds` (default 5 min), live or not, counted across a restart from its face's `modified` — with ONE AI-pool job showing the model its first eight page images through `AIService.DescribeNote` (prompt `note-meta`), keeps the answer in `.meta` and sends it to the tablet as `META`; `NameNow` names one at once — `POST /api/ink/notes/{uuid}/describe`, the `ink-describe` frame, the notebook menus and the Meta panel's button; `InkService.Rename` = a name given by hand (Rename… on the notebook menus, `POST /api/ink/notes/{uuid}/rename`, `.meta` `note_named_by: hand`), which the namer and `NameNow` keep while describing the rest, sent as `META` as the AI's is; a blank one hands naming back; PageTranscripts = a page transcribed on demand by ONE AI-pool job per page through `AIService.TranscribePage` (prompt `page-transcript`), its parts made prose and diagram blocks (PlantUML drawn through `PlantumlService`), kept as `transcript-{page}-{key}.json` and never transcribed twice at one key, a superseded key's transcript dropped; its state none/ready/stale × running × available reaches the note's socket as `ink-transcript-changed`, and `EditorService.NewDocument` copies a transcript into an ordinary note) |
| **Sidebar Notebooks item** | the FIRST item of the library tree, labelled **Notebooks**, present only while Ink is enabled: `frontend/src/templates/ink_sidebar.html` (a folder-like row with its own pen icon in `--theme-accentPrimary` and a live dot while collapsed, no menu of its own; expanded = the Live row (`data-ctx-type="inkLive"`) + the synced notebooks (`data-ctx-type="notebook"`), whose menus — and their tabs' — `context-menu.js` builds), data `inkSidebarView.show` in `requesthandlers/ink.go`. `SideBarHandler.Render` (`sidebar_handler.go`) renders it in place inside `#sidebar-ink`, which refetches ONLY itself (`GET /ui/views/sidebar/ink`, `InkHandler.handleSidebar`) on `sieve:invalidate-ink from:document`, so ink changes never re-render the tree; the tree's own triggers re-render both. Its expansion is a folder's: id `ink` (`inkTreeID`) in `Session.OpenFolders` via `PATCH /api/folder/ink`. Styles: `sidebar.css` (`.ink-tree*`). The sidebar search view does not show it |
| **Ink protocol** | `sieve/ink/link/` — the replication protocol of `docs/ink-contract.md` over any `io.ReadWriter`: pairing key and proofs, sealed frames, records and their codecs, live feed, Session, ScriptedCompanion for tests. Imports no Sieve or Bluetooth package; pins SieveInk's vectors file (`vectors_test.go`) |
| **Ink radio** | `sieve/ink/radio/` — `Radio.Dial` → `Link`: Bluetooth per platform, a TCP radio for development and tests. The only package that imports Bluetooth, pinned by its import-walk test (`imports_test.go`) |
| **Wire contract (single source of truth)** | `sieve/protocol/` — frame + endpoint structs and the `Registry` (channel, direction, type, payload, method/path, response kind); the two WS wires are `GET /api/ws/document/{uuid}` and `GET /api/ws/workspace`. Generator + generated artifacts (`docs/API.md`, `docs/openapi.yaml`, `docs/asyncapi.yaml`, `frontend/src/static/generated/protocol.js`) live under `sieve/protocol/gen/` + `tools/protocolgen/`; rebuild via `go generate ./sieve/protocol` (see Build & Dev) |
| HTTP router assembly (App-bound: index handler + embedded static FS, both passed into `Registry.Mount`) | `handlers.go` (root, `apiHandler`) |
| Request-handler registration — the SOLE route-assembly site, so `chi.Walk` inventories the real surface | `requesthandlers/registry.go` (`Registry.Mount`) |
| One file per HTTP concern | `requesthandlers/*.go` |
| Go HTML templates (HTMX fragments) | `frontend/src/templates/*.html` |
| Static JS/CSS | `frontend/src/static/` |
| App entry point (Go template) | `frontend/src/index.html` |
| **The Lens↔Host wall** | `frontend/src/static/contract/` — the provider hierarchy (`ContainerProvider` → `BlockContainerProvider`/`WholeContentProvider`/`InkContainerProvider` — `ink-container-provider.js`: `loadPage` and the ink feed's event typedefs), `ContainerUpdateListener`, `ContainerFeedListener` (`container-feed-listener.js`: host → lens, what happens to a container that is not its state), `SelectionListener`, the typed `SieveBlock` and `ContractViolation`. A LEAF: it imports nothing, pinned by `frontend/test/contract-purity.test.js` |
| **Lens package** (a container's views) | `frontend/src/static/lens/` holds only `lens.js` (the `Lens` base — provider, mount/unmount + subscription, the `onChanged`→`paint` dispatch, the presence seam), `abstract-editor.js` and `abstract-surface.js` (the surface contract every editor's surfaces implement) at its root. The editor hierarchy is `Lens` → `AbstractEditor` (`abstract-editor.js`: the surface slot, a mode repertoire declared by the subclass — its seedless modes, which need no content seed, flip without the `blocks` capability — dirty/save/selection; it names no mode and imports no ProseMirror, pinned by `lens-isolation.test.js`) → `ProseMirrorEditor` (`lens/document-editor/prosemirror-editor.js`: the TipTap handle and the caret-anchor family) → `NoteEditor` / `ComposerEditor`; `PromptEditor` extends `AbstractEditor` directly. Each concrete lens lives in its own subdirectory so a future lens lands beside the editor, not inside it: `lens/document-editor/` = `ProseMirrorEditor` + `NoteEditor` + the entire PM world (`editor-shell.js` = back-compat `window.SieveEditor` alias, `surfaces/` = the PM quarantine — wysiwyg/markdown surfaces, node-views, `sieve-block-extension.js`, prose machinery), `lens/document-editor/composer/` = `ComposerEditor`, `lens/prompt/` = `PromptEditor`, `lens/outline/` = `OutlineLens`, `lens/block/` = `BlockLens` (the read-only fallback a block container gets when its kind has no lens of its own), `lens/ink/` = `DigitalNoteLens` in two modes, `page` = `PageSurface` (one page at a time as the tablet drew it, read-only; ink arrives as it is written and nothing moves the reader) and `transcript` = `TranscriptSurface` (the page as text and diagrams, drawn read-only through `QuestionListView`, Transcribe this page and New document; Mod+Enter switches), both offering the workspace toolbar a `NotePager` and `TabletOpener` (Open on device at the page shown), and `LiveInkLens` + `LiveSurface` (the Live view: a strict mirror of the tablet's note, page and window, with Open this note), both drawing through `InkSheet` (one page on a sheet: the SVG, committed strokes, the pen live, a whiteboard's `PlaneWindow`; its `SheetPolicy` says whether the view follows the tablet). Both editors mount at `#tiptap-mount`. A lens takes ONE business dependency — a provider — and may import only `contract/` + `renderers/`, pinned TRANSITIVELY by `frontend/test/lens-isolation.test.js` (whose quarantine list names the couplings the #96 cutover left) |
| **Host data plane** | `frontend/src/static/container/` — `ContainerTransport` (owns the DOCUMENT wire: channel-per-uuid, opId ack correlation; transport and NOTHING else — it spells no frame and holds no view of what a document contains) + `BlockChannel`/`WsDial` + `DocumentService` (THE document vocabulary: every frame shape, ack/reply pattern, timeout and both HTTP halves, uuid-addressed and stateless — a wire change is `sieve/protocol/` + this file) + `ContainerModel` (the client's ONE follower of a container) + `ContainerModelFeed`/`ProviderAdapter`/`BlockProviderAdapter`/`WholeContentAdapter`/`InkProviderAdapter` (the wall: guards and ack settling over (model, DocumentService), computing nothing; `ProviderAdapter` delivers every container's feed, and a kind's adapter decides which of its frames become events) |
| **Workspace toolbar** | `frontend/src/static/shell/workspace-toolbar.js` (`WorkspaceToolbar`, constructed by `Workspace` over `#editor-toolbar`: draws the ACTIVE lens's `toolbarContents()`, asked again on its `toolbar-changed` event, refreshed on every other event of its raw stream; names no lens) + `frontend/src/static/renderers/toolbar-button.js` (the widget family a lens and the host both import: `ToolbarButton`, `ToolbarLabel`, `ToolbarSeparator`, `ButtonGroup`). A lens answers with `AbstractEditor.toolbarContents()` = its surface's groups, then `_toolbarGroups()`, which places the ONE `modeToggle()` (face per mode from `_modeToggleFace`) |
| **Workspace wire + host chrome** | `frontend/src/static/shell/` — `WorkspaceService` (owns the WORKSPACE wire, `GET /api/ws/workspace` — one socket, many tenants: tenants claim inbound frame `type` words, unclaimed frames drop; #74 P1) + `CommandService` (a TENANT of it: slash-command dispatch, correlation-id ack routing, cancellation) + `MentionService` (another tenant: the `@` picker's `mention-query`/`mention-result` typeahead; #74 P4) + `InvalidationService` (the push tenant: claims `invalidate`/`jobs-changed`/`container-deleted`, re-dispatches them as DOM events) + `SpellControl` (a SENDER, not a tenant: outbound-only `spell-ignore`/`spell-learn` verbs plus the workspace-scoped `feature-control` toggle; claims no inbound frame words) + `Workspace`/`Tab`/`MountBinding` — the composition root, the only package that constructs lenses; which lens and provider a container gets is `LensTable` (`shell/lens-table.js`), keyed by the kind the server states (`data-kind`), never read off a uuid. Lenses are transport-blind — no fetch/WS outside `container/` and these four for protocol traffic (#49) |
| **Block renderer classes** (look-and-feel, PM-free) | `frontend/src/static/renderers/` — `BlockRenderer` base (its `readOnly` option = the framework flag each kind honours by dropping its own editing/mutating affordances), `RendererStyleRegistry`, `StatusBadge`, `LineGutter`, `QuestionListView` (lens-agnostic drawing of a question's body slot: every element a whole block, read-only), one concrete renderer + sibling `*.styles.js` per kind — prose included (`prose-renderer.js`) — and `block-renderers.js`, the manifest that imports all ten so the registry answers for every kind; the block vocabulary (`block-kinds.js`, `question-list.js` = the composer that mints a question's elements + the fold that classifies them, `action-label.js`, `address-status.js`) and shared utilities (`html-escape.js`, `job-status.js`, `sanctioned-markdown.js`, `highlighting.js`, `quote-anchor.js` = PM-free quote+occurrence text resolution — the marks anchor `TextMarkDecorations` (the base under the spell and find decorations) resolves every pushed mark through, `vendor-libs.js` = bundled non-PM lib seam; `ink-renderer.js` = `InkRenderer`, the Digital Note page → deterministic SVG per `docs/ink-contract.md`, perfect-freehand read through the seam, pinned by the three fixtures' committed `.svg` snapshots under `docs/design/specs/assets/`) live here too |
| **Code formatting** (computes a string, never writes) | `frontend/src/static/renderers/` — `formatter.js` (the `Formatter` typedef: `format`/`supports`/`supportedLanguages`), `prettier-formatter.js` (`PrettierFormatter`: the per-language option table, lazy `import()` of `vendor/prettier.js`), `code-formatting-service.js` (`CodeFormattingService`: canonicalises the language, asks its ordered formatters, first wins — the seam a gofmt- or LLM-backed formatter joins on). Constructed in `Workspace`, handed to lenses through `AbstractEditor` options. The WRITE is `frontend/src/static/lens/document-editor/surfaces/code-format-action.js` (`CodeFormatAction`: the Format menu item both code menus offer, and its tracked `replaceWith` over the node's own range) |
| NodeView PM adapters (thin, composition over a renderer) | `frontend/src/static/lens/document-editor/surfaces/node-views/*-node-view.js` — they are NodeViews, and PM enters the JS graph only in surfaces |
| Custom TipTap extensions (vanilla JS) | `frontend/src/static/lens/extensions.js` — at `lens/` root; imported by `lens/document-editor/note-editor.js`, `lens/document-editor/context-menu.js` and `lens/document-editor/surfaces/wysiwyg-surface.js` |
| Pre-built TipTap core bundle | `frontend/src/static/vendor/tiptap.js` |
| **Identity (all ids)** | `ident/` (`New` = UUIDv7, `Valid`) — a leaf BELOW `store/` and `sieve/`, because `store/` cannot import `sieve/` |
| Store abstraction + FileStore | `store/interfaces.go`, `store/owned_assets.go` (`store.OwnedAssets`: asset writes for any MetaStorable), `store/filestore/` |
| File watcher | `watcher/` (package `watcher`: `NotesWatcher`, `New`) |
| Tech debt register | `docs/TECH-DEBT.md` |
| **CI / release workflows** | `.forgejo/workflows/` (`ci.yml` = the 4 test jobs, all inside the `sieve-ci` image; `publish-ci-image.yml` = builds and publishes that image; `release.yml` = Linux) — the ONLY directory Forgejo reads (it stops at the first of `.forgejo/`, `.gitea/`, `.github/` that exists). `.github/workflows/release.yml` = macOS build only (no Mac build agent on Forgejo). Local runs: `docs/how-to-test-ci-locally.md` |
| **Editor interaction contract (NORMATIVE)** | `docs/editor-interaction-contract.md` |
| **Docs layout** | `docs/` root = long-lived contracts, behaviour specs, living registers, how-tos. `docs/design/` = design history: brainstorms + `specs/` + `plans/` (legacy) + `archive/`. `docs/design/specs/` = design/decision docs (thin: problem, decision, architecture, rationale); header carries `Tracked: #N` when work is active. Plans are Forgejo issues, NOT files (epic issue + per-phase issues for large work; drafted in scratchpad → posted via `tea api`; reviewed on the issue) — `docs/design/plans/` holds legacy plans only, never add to it. Completed/superseded specs are stamped with a status banner and `git mv`'d to `docs/design/archive/specs/` in the same change that closes their issue. |
| Current milestone plan | `docs/FEATURE-BACKLOG.md` (PHASE9 completed → `docs/design/archive/PHASE9-PLAN.md`) |
| **How to build a Sieve block** | `docs/how-to-intelligent-fenced-blocks.md` (current) — supersedes `docs/how-to-sieve-block-framework.md` (STALE, banner'd, pending rewrite) |
| **How to build a fenced block** | `docs/how-to-intelligent-fenced-blocks.md` |
| **How to write idiomatic JS (NORMATIVE for new JS)** | `docs/how-to-idiomatic-js.md` |
| TipTap/PM vendor seam (the ONLY PM read point) | `frontend/src/static/lens/document-editor/surfaces/tiptap-vendor.js` — `lens/document-editor/surfaces/` is THE PM package; `base/` holds only `icons.js`/`globals.js` (X-C quarantine) |

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

**Prettier bundle:** rebuild only when `prettier`/`prettier-plugin-java` change: `npm run
bundle:prettier` in `frontend/`. It emits `vendor/prettier.js` (ESM — `import.meta` is
load-bearing) and copies the Java parser's two `.wasm` files BESIDE it, because the plugin
locates them with `new URL(name, import.meta.url)`; all three are committed. Nothing references
it from `index.html`: `PrettierFormatter` `import()`s it on the first Format click. The bundle
does not run under Node (web-tree-sitter's Node path breaks when bundled), so tests inject the
npm packages through `PrettierFormatter`'s loader instead. `tree-sitter-java_orchard.wasm` is
`tree-sitter-java-orchard`'s compiled grammar (MIT), a devDependency of the plugin that npm
never installs and esbuild never reads — so it is credited from what is on disk: its MIT text
is committed beside it as `vendor/tree-sitter-java_orchard-MIT.txt` and its version is read
from the plugin's own pin (`tools/gencredits` `javaGrammarEntry`).

**Third-party credits:** `third-party-licenses.json` (repo root, go:embed'ed, rendered by the
Help → Open Source Licenses dialog) is GENERATED — never hand-edit. Regenerate only when deps change (`go.mod`,
`frontend/package.json`, bundle entries): `nix develop -c go run ./tools/gencredits`
(needs network on first run). The tool fails the run if a copyleft license appears in a
bundled component. Output must be deterministic across toolchains, and BOTH halves of the
Go stdlib entry are pinned to make it so: the **version** comes from go.mod's `go`
directive (not `go env GOVERSION`), and the **license text** comes from `$GOROOT/LICENSE`
only — never a walk of GOROOT, which holds ~20 vendored licenses whose shallowest is
BoringSSL's (nix omits the top-level LICENSE, so a walk shipped OpenSSL's text as the Go
stdlib's; fixed `b7e8967`, pinned by `tools/gencredits/main_test.go`, with
`tools/gencredits/go-license.txt` as the fallback for toolchains that omit the file) —
CI's `credits` job regenerates and diffs, failing
the pipeline if a dep change lands without a regen; releases ship the committed artifact
and never regenerate. Sieve itself is Apache-2.0 (`LICENSE` + `NOTICE` at root).

**Release:** `tools/release.sh <version>` — bumps `sieveVersion` in `flake.nix` (the number
a Nix install reports and stamps into `main.version` as `<version>+<commit>`), commits, tags
`v<version>` and pushes both atomically. Never tag by hand: the Forgejo release workflow
refuses a tag whose number differs from that constant, and v0.34.0–v0.36.0 were lost that way. The Go
module set is pinned by `vendorHash` in the same file; the credits CI job fails when a
`go.mod`/`go.sum` change lands without the matching bump (the correct hash is in its log).

**CI image:** `stephen/sieve-ci` is a child of ci-base (stephen/ci-base#13): `Containerfile`
starts from ci-base `latest` (agy, claude-code, tea, git) and adds this devShell's whole
closure and every locked flake input, so a CI job enters the shell with no network.
`.forgejo/workflows/publish-ci-image.yml` rebuilds it Monday nights, on any push to main
changing `flake.nix`/`flake.lock`/`Containerfile`, and on dispatch, probes the new tag and
only then moves `latest`; every job in `ci.yml` runs in it as `nix develop -c <cmd>`, with no
setup-go, no setup-node and no apt. `ci.yml` is deliberately NOT `--offline`: a commit that
changes the flake runs once against the previous image, Nix fetches the difference, and the
next run is warm once publish has moved `latest`. The publish probe is where `--offline` is
enforced.

**Wire contract:** `sieve/protocol/` is the single source of truth for every WS frame and typed
JSON endpoint. Any change to one — a new frame, a changed field, a new endpoint — must regenerate
its artifacts: `nix develop -c env CGO_ENABLED=0 go generate ./sieve/protocol` (the `CGO_ENABLED=0`
must be set INSIDE `nix develop` — the devShell hook resets it to 1 on entry). This rebuilds
`docs/API.md`, `docs/openapi.yaml`, `docs/asyncapi.yaml`, and `frontend/src/static/generated/protocol.js`.
An artifacts-currency test fails the whole suite if the committed files drift from what the
declarations now generate.

**Embeds** (in `embeds.go` — go:embed paths are relative to the declaring file and cannot climb, so these stay at root and are threaded into `newAPIHandler`):
- `//go:embed frontend/src/templates` → Go templates
- `//go:embed frontend/src/static` → static files served at `/ui/static/`
- `//go:embed frontend/src/index.html` → app shell

---

## Architecture in One Paragraph

`main.go` constructs the `JobTracker`, the `WorkspaceBroadcast` (the workspace wire's fan-out primitive) and the `App`, then builds the root `apiHandler` (`handlers.go`). `apiHandler` owns the chi router and the index wiring (it stays in package main because it reads live `App` store state); it delegates registration of every route — the per-concern `RequestHandler`s (one struct per concern in `requesthandlers/`), `/ui/static/*`, `/mcp`, and `/` — to `requesthandlers.Registry.Mount`, the sole route-assembly site. The file watcher lives in package `watcher` (`watcher.New`), constructed by `App` at startup. Handlers call `sieve.ServiceProvider` (the composition root, package `sieve`) which constructs the concrete services and wires them into `block.BlockServices` as **port interfaces**. The block type is `domain.SieveBlock`; the block model around it (`block/`: DocumentCodec, RegionScanner, ShadowDocument, the processor registry) is a leaf that depends only on `domain/` — processors and services depend on it, never the reverse. `ai/` (AIService + CLI) provides the concrete `*ai.AIService` held by `block.BlockServices.AI` (`AIPort` was deleted — see the DAG callout above). The Store abstraction (`store.Store`) is the only layer that touches disk — `filestore.FileStore` implements it. The frontend is HTMX: Go templates render HTML fragments on request; workspace broadcasts (`invalidate`, `jobs-changed`, `container-deleted`) re-dispatch as DOM events that trigger HTMX swaps. Its JS is five packages behind one firewall (#96), `contract ← {renderers, container, lens, shell}` · `renderers ← lens` · `{container, lens} ← shell`: `contract/` is the leaf both sides import (the Lens↔Host wall), `container/` is the host data plane (`ContainerTransport` owns the wire; `ContainerModel` is the client's single follower of a container), `renderers/` is PM-free block look-and-feel, `lens/` holds the views, and `shell/` is the composition root that mounts them. A mount is a HOST verb: `MountBinding` binds one uuid, hands the lens a provider reading that model, and the lens reads-and-paints on `onChanged` — so mutation ORIGIN (a lens verb, a menu, an AI job, the watcher) is indistinguishable by construction. TipTap runs as a class-based lens (`AbstractEditor` + concrete `NoteEditor`/`PromptEditor`, `frontend/src/static/lens/`) mounted in `#tiptap-mount`.

---

## Design Principles

- **JS is written with the same OOP discipline as Go (2026-07-08).** "Vanilla JS" is a LANGUAGE choice — plain JavaScript, no React/JSX/TypeScript (complexity the maintainer doesn't carry); build steps (esbuild, tailwind) and libraries are fine and already exist. It is never an excuse for loose function bags: new JS is real ES classes with constructors and `#private` fields; shared values are `Object.freeze`d; public contracts carry JSDoc types checkable via `// @ts-check` (`tsc --noEmit` — types in comments, code stays JS). No new IIFE namespace bags, no state as module-scope `var`s, no `window.*` buses — the existing ones are quarantined debt (X-C, epic #31), not precedent. Idioms + enforcement: `docs/how-to-idiomatic-js.md`. Architectural context: `docs/design/specs/2026-07-08-workspace-editor-component-model.md` §Design discipline.
- **No loose/free functions (OOP cohesion).** Behaviour belongs as a **method on the type or service that owns its data** — not a package-level `func`. If a function genuinely has no owning type, attach it to a Utilities service; it does not float. Dangling package-level symbols hide their callers, which is exactly what made the S-A package split painful. Data mutations live with the data (e.g. block ops + snapshots are `ShadowDocument` methods; serialize/deserialize are `BlockProcessor`/`DocumentCodec` methods; paste-matching is a registry method `FirstPasteMatch`). **Known backlog applying this:** `block/`'s codec/parser still has free funcs (`scanProseRegion`, `mdParser`, goldmark helpers, `handle_gc`'s `gcRefs`/`gcAliases`) and `ai/eval` helpers — attach them to their owning type as opportunity allows.
- **Test code is production code (2026-08-30).** Nothing novel: the standard
  discipline — DRY, refactored, DELETED when superseded — applies to a test
  suite exactly as to the code it exercises. It is written down because the
  delivery loop drifts from it systematically: an implementing agent only ever
  ADDS tests (adding is safe, deleting feels risky, and an agent never feels
  maintenance pain), which is how the epics reached ~10:1 insertions over
  deletions. Rules: EXTEND the suite file that already covers the area — a
  parallel file cloning its scaffolding is the failure mode; table-drive
  per-kind/per-case variants; a NEW test file only for a genuinely new unit;
  a contract change that deletes no tests is suspect — the superseded pinning
  went somewhere. Briefs to implementing agents must carry these rules and
  require reporting which existing tests were leveraged or updated and why any
  new file exists. Consolidation backlog: #127.
- **Comments: source code is source code (2026-08-26).** A doc comment is a
  straight **definition and explanation of what you are looking at** — what it is,
  what it does, what it requires of a caller, what it guarantees. That is all it is
  for.

  **The line is DEFINING versus NARRATING, not long versus short.** Prose that
  DEFINES is valid at any length: what this is, the forms it takes, what a caller
  must respect, a constraint that makes the obvious usage wrong, a deliberate
  absence in the design. `sieve/domain/address.go`'s type godoc runs to twenty
  lines and every line earns its place. Prose that NARRATES is invalid at any
  length: how we got here, what was rejected and why, what it used to be called,
  which issue or phase moved it, why a reviewer's objection did not apply. Cut it
  even when it is two sentences.

  So when you meet a long comment, do not ask "is this too long". Ask: **is this
  defining the thing, or telling its story?**

  **History and archaeology belong in git. The design record belongs in the issue.
  Durable prose belongs in `docs/`. Source code holds the contract.**

  **If you find yourself writing what would be considered prose in a code comment,
  either the code is too complex and warrants the essay, or you are writing in the
  wrong place.** That is a diagnostic and it applies to the narrating kind only:
  either go and simplify the code, or go and write the thought in `docs/` or the
  issue. Neither is fixed by writing more comment.

  JSDoc and `// @ts-check` annotations stay, however verbose — types, parameters
  and returns ARE the contract. Verbosity in service of the contract is not the
  problem; stories are.

  **Never write a comment to answer a code review.** If a reviewer asks "why not
  X", the answer goes in the issue or the design doc. Each defence is individually
  reasonable; the accumulation leaves a file arguing with a reviewer instead of
  telling a caller what to do.

  The test: **would a competent reader get this WRONG without it?** If the answer
  is no, the comment does not exist in a shorter form — **delete the block, do not
  shorten it.** Rewriting prose more tersely while keeping every block is the
  failure mode that made #104 necessary; it recovers about half of what deleting
  does. Never instruct anyone — human or agent — to "match the surrounding comment
  density"; that propagates the worst example nearby.

  **Measure prose against code, never total comment against code.** Tags
  (`@param`, `@type`, `@typedef`) and their `/** */` scaffolding are structural and
  load-bearing under `// @ts-check` — a types-only file such as `contract/` reads
  90% comment and is correct. Only prose is discretionary. Never delete a tag to
  move a percentage.

  Full rule, worked example, and how to run a pass safely (including the
  three-way mechanical verification a comment-only change must pass):
  `docs/how-to-idiomatic-js.md` §8 (language-neutral, applies to Go too).

- **Tests live with the type they exercise.** A test that touches a type's internals (`Attrs`, unexported methods, the mutex) is white-box and belongs **in that type's package**. Cross-package tests use the public method API only — never add a construction seam to poke across a package boundary. Editor-mechanic tests use a **FakeBlock**; only prose-*specific* tests need the real `ProseProcessor` (which lives in `block/processors/`).

---

## Non-Obvious Rules

- **Backend is the document source of truth** — any op that mutates the doc **in Go** (paste, extract, transform, promote, AI-block create) renders by **placing the server's authoritative node at the server's index** as a **tracked** PM transaction: insert at `docPosForBlockIndex(msg.index)`, or replace-by-block-id for transform. The frontend reads the caret to pick an index and sends it to Go; Go creates there and echoes `msg.index` back. JS must NOT compute doc state/position or splice JS-chosen content (retired `replaceSource`/`sieveInsertPos`-range path); it only places the server's node. **Do NOT full-reload (`softReloadContent`) for an operation — `renderBlocksIntoEditor`'s `replaceWith + addToHistory:false` wipes undo history.** Full reload is only for genuine doc *loads* (open/restore/library-switch/AI whole-doc). Prose the editor already holds is skipped (baseline, no re-insert); scroll-to-new is universal.
- **All ids are UUIDs, minted only by `ident.New`** (#75) — documents and blocks alike. Ids are **opaque**: no kind prefix, nothing may infer a block's kind from its id, and nothing displays one. A block id lives in TWO places and both must be written together — the `SieveBlock.ID` field *and* `Attrs["id"]` — because the WYSIWYG wire and the fenced serializer read it out of `Attrs`; use `SieveBlock.Reidentify`, never a bare field assignment. Legacy short handles are upgraded by `BlockIdentityMigrator` on the document load path (`NewShadow`), never inside `DocumentCodec.Deserialize`, which stays a pure parse; `EditorService.open` flushes that upgrade synchronously so ids are stable from first open. `/migrate-ids` sweeps documents nobody has opened.
- **An alias is a NAME, not an identity** — durable, given only by a deliberate act (a declared name, a domain-meaningful handle), unique only *within* its document, and never auto-minted or garbage-collected. Migration creates none. Cross-document coordinates use `domain.Address`, an RFC 3986 authority-form URI whose authority is the container — `sieve://{container}[/{leaf}][?version={n}]`, plus the relative `/{leaf}` resolved against the current container. A leaf is a block uuid, an alias or an asset key, and **which one is decided container-side at lookup**, never inferred from the address. There is deliberately no container-less leaf form, so an alias cannot leave its document. **An asset-bearing attr stores the ABSOLUTE address** — smart-image `src`, diagram `svgAsset` and a held reference's `uri` are written as `sieve://{document}/{key}`, never `/{key}`, so the text reads the same wherever it is copied; `domain.ResolveAssetReference` still reads every legacy spelling and `AssetURIMigrator` lifts them to absolute on load.
- **`user_intent` is user-owned** — AI must never write `Tab.UserIntent`. It signals "keep" or "trash" and is set only by explicit user action.
- **Frontmatter** — stripped before content reaches TipTap; re-prepended on save. Never pass raw frontmatter to the editor.
- **CLI stdin** — `sieve/cli.go` `RunCLI` passes prompts via stdin to `claude --print --no-session-persistence`. Never use `sh -c` with a double-quoted prompt — backticks in fenced code blocks get shell-expanded and silently erased.
- **CLI timeout** — 60 s default, `cli_timeout_long` in settings.json; `prompt_timeouts` overrides it per prompt name (e.g. `{"note-meta": 120}`).
- **No React** — Phase 9 is done. Do not introduce React, JSX.
- ** Any npm dependencies must be Vanilla JS and discuss first.
- **`window.sieve*` globals** — thin JS wrappers over Go HTTP calls (tech debt X-B); they exist in `frontend/src/index.html`. New work should use direct `hx-post`/`hx-get` attributes instead.
- **Workspace broadcasts, not SSE** — SSE is retired. `GET /api/ws/workspace` fans a broadcast to every connected socket via `WorkspaceBroadcast`: `invalidate` (topic-as-data — `notes`, `session`, `prompts`, `library`, `intent`), `jobs-changed` (the whole job snapshot, pushed on connect and on every change), and `container-deleted` (a container is gone; the client reconciles what it still holds for that uuid). The frontend's `InvalidationService` re-dispatches these as page-global DOM events on `document` — `sieve:invalidate-{topic}` and `sieve:jobs-changed` — and hypermedia refetch triggers read `hx-trigger="sieve:invalidate-{topic} from:document"` (`from:document` is load-bearing: an event dispatched on `document` never reaches `body`, so `from:body` silently never fires).
- **Wire contract upkeep is mandatory** — any WS frame or typed JSON endpoint change goes through `sieve/protocol` (add/edit the struct + its godoc/`doc:"…"` tags) and then `nix develop -c env CGO_ENABLED=0 go generate ./sieve/protocol` (CGO_ENABLED=0 set INSIDE `nix develop` — the devShell hook resets it to 1 on entry). Go speaks frame types and topics only through `sieve/protocol` constants; JS speaks them only through the generated `frontend/src/static/generated/protocol.js` — a string literal on either side is how the wire drifts from the registry. The generated-artifacts-currency test fails the whole suite on drift, and the `sieve/protocol` contract test suite is part of the definition of done for any API-touching change.
- **Editor interaction contract** — `docs/editor-interaction-contract.md` is NORMATIVE. New block kinds declare `interactionPolicy` (see `frontend/src/static/lens/interaction-policy.js` DEFAULT_POLICY); per-renderer `handleKeyDown` for Tab/Enter/Home/arrows is FORBIDDEN — the shared policy extension owns them (Tab = priority-50 backstop after native keymaps; Enter family = pre-core via editorProps; the module header explains why). Any interaction change MUST update the contract doc in the same change. Key chords: Shift+Enter = universal block escape; Mod+Enter = mode toggle for kinds declaring `modEnterTogglesMode` + `onModEnter`.
