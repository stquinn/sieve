# Sieve

Scratchpad-first thinking tool. Users write freely in untitled buffers; filing/keep/discard decisions happen on close.

**Stack:** Wails v2 + Go + chi + HTMX + vanilla JS + TipTap 2 + Tailwind. No React, no npm build step.

## Keeping this file small

This file is in every session's context. **Budget: under 20 KB** (`wc -c CLAUDE.md`).

- A Key File Locations row is a pointer: what the thing is, where it lives, the doc that describes it. One line.
- How a subsystem works goes in its doc under `docs/` (`go-packages.md`, `frontend-packages.md`, `how-ink-works.md`, `how-the-sidebar-works.md`, or a new one beside them). A procedure goes in a how-to. Design history goes in the issue and git.
- A rule is written here only if a session gets the work wrong without it.
- A feature that adds a type or a file adds a line to the doc, not to this file.

---

## Go package layout

`sieve/` is cohesive packages with an acyclic DAG (the full map is `docs/go-packages.md`). The import direction is
`domain ← services ← ai ← block ← block/processors`, with the root (`sieve`, the composition root) wiring everything.

- `services/` imports nothing from `block/`, and it **cannot**: `block/` holds a concrete `*ai.AIService` (`processor_registry.go`) and `ai/` imports `services/`, so a `services → block` edge closes a cycle. **Put a type shared by a service and a block in `domain/`**, never in `block/`.
- The block type is a domain type: `domain.SieveBlock` (with its `Elements`) and `domain.BlockContainer`, beside `Document`, hold a block's own data and every operation on it. `block/` holds what specialises around it: kinds, processors, the registry (`block.Registry`, which owns any reading of a block that depends on what its kind can do), codecs and the shadow document.
- `editor/` and `ink/` sit above `block/` and `services/`; nothing but the root imports them. `ink/link/` imports no Sieve package and `ink/radio/` is the only Bluetooth importer.
- **Ports owned by `block/`** (`DocumentsPort`/`AssetsPort`/`StatePort`/`LinkPreviewPort`/`PlantumlPort`, `ports.go`) keep *processors* off concrete services and make them stubbable in tests. `BlockServices.AI` is concrete, not a port.
- **One port is owned by `services/`**: `ContainableKinds`, what `BlockContainerService` needs of the kinds a container can hold, expressed in `domain` types and implemented by `block.Registry`. This is how a service uses kinds without importing `block/`.

## Key File Locations

| What | Where |
|------|-------|
| Wails App struct + lifecycle | `app.go`; `main.go` constructs `JobTracker`, `WorkspaceBroadcast`, `App` |
| Composition root (DI: wires ports, registers processors) | `sieve/service_provider.go` (package `sieve`) |
| Domain types (persistent) | `sieve/domain/` — SieveBlock, BlockContainer, Document, Address, Buffer, Note, Session, Settings |
| Services (persistence) | `sieve/services/` — DocumentService, AssetService, StateService, JobTracker, JobEngine, LibraryService, BlockContainerService, … |
| Block containers (one block written to a file: a `kind:` line, then its YAML map) | `sieve/services/block_container_service.go` |
| Block model: codec, registry, ports, shadow document | `sieve/block/` (DocumentCodec, RegionScanner, ShadowDocument, Registry) |
| Block processors, one per kind | `sieve/block/processors/` |
| AI subsystem | `sieve/ai/` (AIService; `cli.go` = the CLI runner and per-backend args; prompts) |
| Editor: EditorService, Router + sources (address → Node), InspectionEngine + inspectors (spell, find) | `sieve/editor/` |
| Slash commands; Sieve's MCP server | `sieve/command/`; `sieve/mcp/` |
| **Ink** (SieveInk companions): InkService, replication, naming, transcripts, the Diary | `sieve/ink/`, `sieve/ink/link/` (protocol), `sieve/ink/radio/` (Bluetooth) — **`docs/how-ink-works.md`**; the contract is `docs/ink-contract.md` |
| **Wire contract** (every WS frame and typed JSON endpoint) | `sieve/protocol/`; generator `sieve/protocol/gen/` + `tools/protocolgen/`. The two wires: `GET /api/ws/document/{uuid}`, `GET /api/ws/workspace` |
| HTTP router assembly | `handlers.go` (`apiHandler`, package main) → `requesthandlers/registry.go` (`Registry.Mount`, the SOLE route-assembly site) |
| One file per HTTP concern | `requesthandlers/*.go` |
| Go HTML templates (HTMX fragments); app shell | `frontend/src/templates/*.html`; `frontend/src/index.html` |
| **Sidebar items** (Notebooks, Diary, Buffers) | `requesthandlers/sidebar_handler.go`, `requesthandlers/ink.go` — **`docs/how-the-sidebar-works.md`** |
| **Frontend JS**: `contract/` (the Lens↔Host wall), `container/` (host data plane), `renderers/` (PM-free look-and-feel), `lens/` (views), `shell/` (composition root, workspace wire) | `frontend/src/static/` — **`docs/frontend-packages.md`** |
| ProseMirror: the ONLY PM package, and its vendor seam | `frontend/src/static/lens/document-editor/surfaces/` (`tiptap-vendor.js`) |
| Identity (all ids) | `ident/` (`New` = UUIDv7, `Valid`) — a leaf below `store/` and `sieve/` |
| Store abstraction + FileStore | `store/interfaces.go`, `store/owned_assets.go`, `store/filestore/` |
| File watcher | `watcher/` |
| CI / release workflows; bundles; credits | `.forgejo/workflows/` — **`docs/how-to-build-and-release.md`**, `docs/how-to-test-ci-locally.md` |
| **Editor interaction contract (NORMATIVE)** | `docs/editor-interaction-contract.md` |
| **How to write idiomatic JS (NORMATIVE for new JS)** | `docs/how-to-idiomatic-js.md` |
| How to build a Sieve block / a fenced block | `docs/how-to-intelligent-fenced-blocks.md` (`how-to-sieve-block-framework.md` is STALE) |
| Tech debt register; feature backlog | `docs/TECH-DEBT.md`; `docs/FEATURE-BACKLOG.md` |

**Docs layout.** `docs/` root = long-lived contracts, behaviour specs, living registers, how-tos. `docs/design/` = design history: brainstorms, `specs/`, `archive/`. A spec in `docs/design/specs/` is thin (problem, decision, architecture, rationale) and its header carries `Tracked: #N` while work is active. **Plans are Forgejo issues, NOT files** (an epic issue + per-phase issues for large work; drafted in scratchpad, posted via `tea api`, reviewed on the issue); never add to `docs/design/plans/`. A completed or superseded spec is stamped with a status banner and `git mv`'d to `docs/design/archive/specs/` in the change that closes its issue.

## Code Navigation

Prefer the `language-server` MCP tools (`references`, `definition`, `diagnostics`, `hover`) over grep for symbols. Fall back to grep only if the language server fails.

## Build & Dev

The dev env is a nix flake: run everything as `nix develop -c <cmd>`. The flake's `wails` wrapper adds `-tags webkit2_41`.

```bash
wails dev        # hot-reload
wails build      # production binary
go build ./...   # compile check — no npm step required
nix develop -c env CGO_ENABLED=0 go test ./...            # CGO_ENABLED=0 must be set INSIDE the shell
nix develop -c env CGO_ENABLED=0 go generate ./sieve/protocol   # after any wire change
```

- `frontend/src/static/tailwind.css` is committed and Tailwind scans the JS too: commit the regenerated file with the change that caused it.
- `third-party-licenses.json` is GENERATED (`go run ./tools/gencredits`) and CI diffs it; a `go.mod`/`go.sum` change also needs the `vendorHash` bump in `flake.nix`.
- Release only through `tools/release.sh <version>`. Never tag by hand.
- Tailwind, the TipTap and Prettier bundles, credits, release, the CI image, embeds: `docs/how-to-build-and-release.md`.

## Architecture in One Paragraph

`main.go` builds the root `apiHandler` (`handlers.go`), which owns the chi router and the index wiring and delegates registration of every route — the per-concern `RequestHandler`s, `/ui/static/*`, `/mcp`, `/` — to `requesthandlers.Registry.Mount`. Handlers call `sieve.ServiceProvider`, which constructs the concrete services and wires them into `block.BlockServices` as port interfaces. The Store abstraction (`store.Store`) is the only layer that touches disk; `filestore.FileStore` implements it. The frontend is HTMX: Go templates render HTML fragments on request, and workspace broadcasts re-dispatch as DOM events that trigger HTMX swaps. Its JS is five packages (`contract ← {renderers, container, lens, shell}` · `renderers ← lens` · `{container, lens} ← shell`). A mount is a HOST verb: `MountBinding` binds one uuid and hands the lens a provider reading that container's model, and the lens reads-and-paints on `onChanged`, so the origin of a mutation is indistinguishable by construction. Editors are class-based lenses mounted in `#tiptap-mount`.

---

## Design Principles

- **JS is written with the same OOP discipline as Go.** "Vanilla JS" is a LANGUAGE choice — plain JavaScript, no React/JSX/TypeScript; build steps (esbuild, tailwind) and libraries are fine. It is never an excuse for loose function bags: new JS is real ES classes with constructors and `#private` fields; shared values are `Object.freeze`d; public contracts carry JSDoc types checkable via `// @ts-check`. No new IIFE namespace bags, no state as module-scope `var`s, no `window.*` buses — the existing ones are quarantined debt (TECH-DEBT X-C), not precedent. Idioms + enforcement: `docs/how-to-idiomatic-js.md`.
- **No loose/free functions (OOP cohesion).** Behaviour belongs as a **method on the type or service that owns its data**, not a package-level `func` — in Go and in JS. A function being pure or easier to test is not a licence to float it. If it genuinely has no owning type, attach it to a Utilities service. Data mutations live with the data (block ops + snapshots are `ShadowDocument` methods; serialize/deserialize are `BlockProcessor`/`DocumentCodec` methods). Known backlog: `block/`'s codec/parser free funcs and the `ai/eval` helpers — attach them to their owning type as opportunity allows.
- **Test code is production code.** DRY, refactored, DELETED when superseded. An implementing agent only ever ADDS tests, so: EXTEND the suite file that already covers the area — a parallel file cloning its scaffolding is the failure mode; table-drive per-kind/per-case variants; a NEW test file only for a genuinely new unit; shared scaffolding goes in the area's test helper, never copied; a contract change that deletes no tests is suspect. Briefs to implementing agents must carry these rules and require reporting which existing tests were leveraged or updated and why any new file exists.
- **Tests live with the type they exercise.** A test that touches a type's internals (`Attrs`, unexported methods, the mutex) is white-box and belongs **in that type's package**. Cross-package tests use the public method API only — never add a construction seam to poke across a package boundary. Editor-mechanic tests use a **FakeBlock**; only prose-*specific* tests need the real `ProseProcessor`.
- **Comments: source code is source code.** A doc comment is a straight **definition and explanation of what you are looking at**: what it is, what it does, what it requires of a caller, what it guarantees.
  - **The line is DEFINING versus NARRATING, not long versus short.** Prose that DEFINES is valid at any length (`sieve/domain/address.go`'s type godoc runs to twenty lines). Prose that NARRATES — how we got here, what was rejected, what it used to be called, which issue moved it — is invalid at any length.
  - **History belongs in git. The design record belongs in the issue. Durable prose belongs in `docs/`. Source code holds the contract.** If you are writing prose in a comment, either the code is too complex or you are writing in the wrong place.
  - **Never write a comment to answer a code review.** The answer goes in the issue or the design doc.
  - The test: **would a competent reader get this WRONG without it?** If no, **delete the block, do not shorten it.** Never instruct anyone to "match the surrounding comment density".
  - JSDoc tags (`@param`, `@type`, `@typedef`) ARE the contract under `// @ts-check` and stay. Measure prose against code, never total comment against code; never delete a tag to move a percentage.
  - Full rule and how to run a comment pass safely: `docs/how-to-idiomatic-js.md` §8 (language-neutral, applies to Go too).

---

## Non-Obvious Rules

- **Backend is the document source of truth** — any op that mutates the doc **in Go** (paste, extract, transform, promote, AI-block create) renders by **placing the server's authoritative node at the server's index** as a **tracked** PM transaction: insert at `docPosForBlockIndex(msg.index)`, or replace-by-block-id for transform. The frontend reads the caret to pick an index and sends it to Go; Go creates there and echoes `msg.index` back. JS must NOT compute doc state/position or splice JS-chosen content. **Do NOT full-reload (`softReloadContent`) for an operation — `renderBlocksIntoEditor`'s `replaceWith + addToHistory:false` wipes undo history.** Full reload is only for genuine doc *loads* (open/restore/library-switch/AI whole-doc). Prose the editor already holds is skipped; scroll-to-new is universal.
- **All ids are UUIDs, minted only by `ident.New`** — documents and blocks alike. Ids are **opaque**: no kind prefix, nothing may infer a block's kind from its id, and nothing displays one. A block id lives in TWO places and both must be written together — the `SieveBlock.ID` field *and* `Attrs["id"]` — because the WYSIWYG wire and the fenced serializer read it out of `Attrs`; use `SieveBlock.Reidentify`, never a bare field assignment. Legacy short handles are upgraded by `BlockIdentityMigrator` on the document load path (`NewShadow`), never inside `DocumentCodec.Deserialize`, which stays a pure parse. `EditorService.open` flushes that upgrade synchronously so ids are stable from first open; `/migrate-ids` sweeps documents nobody has opened.
- **An alias is a NAME, not an identity** — durable, given only by a deliberate act (a declared name, a domain-meaningful handle), unique only *within* its document, never auto-minted or garbage-collected; migration creates none. Cross-document coordinates use `domain.Address`, an RFC 3986 authority-form URI whose authority is the container — `sieve://{container}[/{leaf}][?version={n}]`, plus the relative `/{leaf}` resolved against the current container. A leaf is a block uuid, an alias or an asset key, and **which one is decided container-side at lookup**, never inferred from the address. There is deliberately no container-less leaf form, so an alias cannot leave its document. **An asset-bearing attr stores the ABSOLUTE address** (smart-image `src`, diagram `svgAsset`, a held reference's `uri`): `sieve://{document}/{key}`, never `/{key}`; `domain.ResolveAssetReference` still reads every legacy spelling and `AssetURIMigrator` lifts them on load.
- **`user_intent` is user-owned** — AI must never write `Tab.UserIntent`. It signals "keep" or "trash" and is set only by explicit user action.
- **Frontmatter** — stripped before content reaches TipTap; re-prepended on save. Never pass raw frontmatter to the editor.
- **CLI stdin** — `sieve/ai/cli.go` passes prompts via stdin to `claude --print --no-session-persistence`. Never use `sh -c` with a double-quoted prompt — backticks in fenced code blocks get shell-expanded and silently erased.
- **CLI timeout** — 60 s default, `cli_timeout_long` in settings.json; `prompt_timeouts` overrides it per prompt name (e.g. `{"note-meta": 120}`).
- **Tests never exec an AI CLI** — assert the arg-renderer's output and stub the runner; CI has no `claude`/`agy`/`copilot`.
- **No React, no JSX.** A stock TipTap extension or a small vanilla package is fine; anything pulling in a framework or a large dependency tree is discussed first.
- **`window.sieve*` globals** — thin JS wrappers over Go HTTP calls in `frontend/src/index.html` (tech debt X-B). New work uses `hx-post`/`hx-get` attributes instead.
- **CSS colours are theme variables** — always `--theme-*`, never a hardcoded hex/rgba; a scrim is `color-mix(in srgb, var(--theme-bgDark) N%, transparent)`.
- **Workspace broadcasts, not SSE** — `GET /api/ws/workspace` fans a broadcast to every connected socket via `WorkspaceBroadcast`: `invalidate` (topic-as-data — `notes`, `session`, `prompts`, `library`, `intent`, `ink`), `jobs-changed` (the whole job snapshot, pushed on connect and on every change), and `container-deleted`. `InvalidationService` re-dispatches these as DOM events on `document` — `sieve:invalidate-{topic}` and `sieve:jobs-changed` — and refetch triggers read `hx-trigger="sieve:invalidate-{topic} from:document"` (`from:document` is load-bearing: an event dispatched on `document` never reaches `body`).
- **Wire contract upkeep is mandatory** — any WS frame or typed JSON endpoint change goes through `sieve/protocol` (the struct + its godoc/`doc:"…"` tags) and then `go generate ./sieve/protocol` (command above), which rebuilds `docs/API.md`, `docs/openapi.yaml`, `docs/asyncapi.yaml` and `frontend/src/static/generated/protocol.js`. Go speaks frame types and topics only through `sieve/protocol` constants; JS only through the generated `protocol.js` — a string literal on either side is how the wire drifts. An artifacts-currency test fails the whole suite on drift, and the `sieve/protocol` contract suite is part of done for any API-touching change.
- **Editor interaction contract** — `docs/editor-interaction-contract.md` is NORMATIVE. New block kinds declare `interactionPolicy` (see `DEFAULT_POLICY` in `frontend/src/static/lens/document-editor/interaction-policy.js`); per-renderer `handleKeyDown` for Tab/Enter/Home/arrows is FORBIDDEN — the shared policy extension owns them (Tab = priority-50 backstop after native keymaps; Enter family = pre-core via editorProps; the module header explains why). Any interaction change MUST update the contract doc in the same change. Shift+Enter = universal block escape; Mod+Enter = mode toggle for kinds declaring `modEnterTogglesMode` + `onModEnter`.
