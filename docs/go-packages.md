# The Go packages

What each Go package holds and what it may import. The rules a change must respect are in
`CLAUDE.md` § Go package layout; this file is the fuller map. The original split is
`docs/design/archive/specs/2026-06-20-flat-package-decomposition-design.md` (its DAG predates the
removal of `AIPort`).

## 1. The DAG under `sieve/`

```
domain ← services ← ai ← block ← block/processors
                    ↑       ↑
        command, mcp        editor, ink, protocol
```

The root package `sieve` (`service_provider.go`) is the composition root and imports all of them.

| Package | Imports (within `sieve/`) |
|---|---|
| `domain` | nothing |
| `services` | `domain` |
| `command` | `domain`, `services` |
| `mcp` | `domain`, `services` |
| `ai` | `command`, `domain`, `lang`, `services` |
| `block` | `ai`, `domain`, `fencedblock` |
| `block/processors` | `block`, `domain`, `lang` |
| `editor` | `ai`, `block`, `domain`, `fencedblock`, `services` |
| `ink` | `block`, `domain`, `services`, `ink/link`, `ink/radio` |
| `ink/link`, `ink/radio`, `lang`, `fencedblock` | nothing |
| `protocol` | `block`, `domain` |

Regenerate this table with
`go list -f '{{.ImportPath}}: {{join .Imports " "}}' ./sieve/...`.

### Why `services/` cannot import `block/`

`block/` holds a concrete `*ai.AIService` (`processor_registry.go`) and `ai/` imports `services/`,
so a `services → block` edge closes a cycle. A type shared by a service and a block goes in
`domain/`.

### Ports

- **Owned by `block/`** (`ports.go`): `DocumentsPort`, `AssetsPort`, `StatePort`,
  `LinkPreviewPort`, `PlantumlPort`. They keep *processors* off concrete services and make them
  stubbable in tests; they are not breaking a cycle. `BlockServices.AI` is concrete while its
  siblings are ports, because the `block → ai` edge never needed inverting (see the note in
  `processor_registry.go`).
- **Owned by `services/`**: `ContainableKinds` — what `BlockContainerService` needs of the kinds a
  container can hold, expressed in `domain` types and implemented by `block.Registry`. This is what
  lets a service use kinds without importing `block/`.
- **Owned by `ink/`**: `ContainerNodes`, behind which `Notebooks` resolves a note through
  `editor.BlockSource`.

## 2. What each package holds

### `sieve/domain/` — persistent leaf types

`SieveBlock` (with its `Elements`) and `BlockContainer`, beside `Document`, hold a block's own data
and every operation on it. Also `Address`, `Buffer`, `Note`, `Session`, `Settings`, `Categories`,
`ImageAsset`, `FilingRecommendation`, `ImageDesc`, `LinkPreviewResult`, `Candidate`.

### `sieve/services/` — persistence

`DocumentService`, `AssetService`, `StateService`, `JobTracker`, `JobEngine`, `LinkPreviewService`,
`LibraryService`, `PlantumlService`, `BlockContainerService`.

A **block container** is one block written directly to a file: a `kind:` line, then its YAML map;
a sibling of `Document`. `BlockContainerService` parses and renders a `domain.BlockContainer`.

### `sieve/block/` — the kinds and machinery around `domain.SieveBlock`

`DocumentCodec`, `RegionScanner`, `ShadowDocument`, `Registry` (which owns any reading of a block
that depends on what its kind can do), `ports.go`, `processor_registry.go`.

### `sieve/block/processors/` — one processor per kind

code, diagram, log, prose, smart-image, smart-card, web-clip, ai-block, reference.

### `sieve/ai/`

`AIService`; `cli.go` = the CLI runner (`execCLIRunner.Run`) and the per-backend argument
renderers, the point at which an API backend would be swapped in, and `Run`, one call to it;
`task.go` = `Task` (one kind of AI job, declared by `PromptService` in `prompts.go`), `Prompt`
(its layers) and each task's typed data; `PromptService` also stores each task's addendum (`{task}.addendum.md` in the Prompts category), the one text the Prompts dialog edits and layer 4 of the task's prompt; eval helpers; `image_localise`.

### `sieve/editor/`

- `EditorService`.
- `Router` + `NotesSource` + `BlockSource` = address → Node.
- `IdentitySweeper`.
- `InspectionEngine` + the `Inspector` registry = the text-service lifecycle. `SpellInspector` is
  its first producer; `FindInspector` is find-and-replace, the producer that also writes.

### `sieve/ink/`

`docs/how-ink-works.md`.

### `sieve/protocol/` — the wire contract

The single source of truth for every WS frame and typed JSON endpoint: the frame and endpoint
structs and the `Registry` (channel, direction, type, payload, method/path, response kind). The
two WS wires are `GET /api/ws/document/{uuid}` and `GET /api/ws/workspace`.

The generator is `sieve/protocol/gen/` + `tools/protocolgen/`. `go generate ./sieve/protocol`
rebuilds `docs/API.md`, `docs/openapi.yaml`, `docs/asyncapi.yaml` and
`frontend/src/static/generated/protocol.js`.

## 3. Outside `sieve/`

| Package | What it is |
|---|---|
| `main` (`main.go`, `app.go`, `handlers.go`, `embeds.go`) | `main.go` constructs the `JobTracker`, the `WorkspaceBroadcast` (the workspace wire's fan-out primitive) and the `App`, then builds the root `apiHandler`. `apiHandler` owns the chi router and the index wiring; it stays in package main because it reads live `App` store state, and it passes the index handler and the embedded static FS into `Registry.Mount`. |
| `requesthandlers/` | One struct per HTTP concern. `registry.go` (`Registry.Mount`) is the SOLE route-assembly site, so `chi.Walk` inventories the real surface. |
| `ident/` | All ids: `New` = UUIDv7, `Valid`. A leaf BELOW `store/` and `sieve/`, because `store/` cannot import `sieve/`. |
| `store/` | `interfaces.go` (`store.Store`, the only layer that touches disk), `owned_assets.go` (`store.OwnedAssets`: asset writes for any MetaStorable), `filestore/` (`FileStore`). |
| `watcher/` | `NotesWatcher`, `New`; constructed by `App` at startup. |
