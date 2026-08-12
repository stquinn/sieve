# API Contract — Single Source of Truth (Design)

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plan
**Companion spec:** `2026-07-04-editor-interaction-contract-design.md`

## Problem

The backend API has no contract documentation of any kind. The surface today:

- ~50 HTTP routes across 13 handler files, with mixed conventions (HTML fragments, JSON, 204s, inline `<style>` responses).
- 8 client→server and 10 server→client WebSocket message types, defined only as string literals matched between a `switch` in `requesthandlers/ws_handler.go` and `onmessage` branches in `frontend/src/static/editor/editor.js`. A typo fails silently.
- 5 SSE events, named at scattered `hub.broadcast` call sites.
- Payload shapes (`BlockOp`, `FrontendBlock`, `ContentEntry`) exist only as Go structs that the JS reverse-engineers from usage.

There is no visibility of what the API is, no way to know when a change breaks it, and no artifact a future web/mobile frontend could build against (long-term direction: Go HTTP server + S3 store + multiple frontends).

## Goals

1. **Single source of truth in Go** — the contract is typed code; documentation and frontend constants are generated from it and cannot drift silently.
2. Full typed treatment for the **WebSocket protocol, SSE events, and JSON endpoints**. HTMX fragment routes get a light auto-generated inventory only (their real contract is the template).
3. Generated human-readable docs (markdown) **and** machine-readable OpenAPI/AsyncAPI YAML.
4. Generated **plain-JS constants module** consumed by the frontend (no build step exists; artifact is committed).
5. A **contract-test suite** that fails when the implementation and the contract diverge.
6. A **dev-only HTML API test ground** served during `wails dev` for visually exploring the API live.
7. **Wire format unchanged** — this formalizes the existing protocol; nothing breaks.

## Non-Goals

- No REST-ification of HTMX endpoints. They stay HTML-over-the-wire.
- No versioning/envelope scheme (single-user desktop app; revisit when a second frontend exists).
- No formal per-kind schema validation for block `Attrs` (stays `map[string]interface{}` on the wire; per-kind fields are *documented*, not enforced — logged as follow-up).
- No Swagger UI / heavy npm tooling.

## Approaches Considered

1. **Annotation-based** (swaggo-style comments on handlers → OpenAPI). Rejected: annotations drift exactly like prose docs, and cover nothing of the WS/SSE protocol — the loosest part.
2. **Schema-first** (hand-write OpenAPI/AsyncAPI, generate Go and JS from it). Rejected: heavy codegen fighting existing, good Go structs.
3. **Protocol package as source of truth.** ✅ Chosen — detailed below.

## Architecture

### The `sieve/protocol` package

A new package `sieve/protocol` is the one place the wire contract is defined:

- **Message structs** for every WS message, both directions (`DocUpdateMsg`, `InsertBlockMsg`, …). They *reference* existing types (`block.BlockOp`, `block.FrontendBlock`, `block.ContentEntry`) — no duplication. Package sits above `block/`/`domain/` in the DAG; nothing below imports it.
- **Constants** — `MsgType*` for WS message types, `Event*` for SSE event names — replacing every string literal on the Go side.
- **Request/response structs** for the ~10 JSON endpoints (`/api/editor/load`, `/save`, `/smart-paste`, `/paste-slice`, `/detect-extractions`, `/api/jobs`, `/api/ai/*`).
- **`ProtocolRegistry`** — the load-bearing piece. A type (not loose functions) whose entries describe each WS message, SSE event, and JSON endpoint: name/type, direction, payload struct (as `reflect.Type`), one-line doc. Generation walks the registry via reflection; nothing is discovered by scraping code.

### Registry-driven dispatch (anti-drift)

`ws_handler.go`'s message dispatch and the SSE broadcast call sites are refactored to go through the registry/constants. A message type that is not registered cannot be dispatched or broadcast — the registry *cannot* fall behind the handlers. Unknown incoming WS types get a typed, logged `error` reply (today they fail silently).

### Generated artifacts (committed, via `go:generate` → `tools/protocolgen`)

| Artifact | Content |
|---|---|
| `docs/API.md` | WS message tables (direction, type, payload fields, purpose), SSE event table, JSON endpoint schemas, **HTMX route inventory** (from `chi.Walk` over the real router: method, path, handler, response kind) |
| `openapi.yaml` | The JSON endpoints |
| `asyncapi.yaml` | WS + SSE channels/messages |
| `frontend/src/static/generated/protocol.js` | Plain ES module exporting message-type and SSE-event constants; `editor.js` switches its string literals to these |

### Dev API test ground

A dev-only route `/api/docs`, gated out of production builds, serving a self-contained vanilla-JS page (no CDN, no Swagger UI):

- Route inventory + message/event catalog rendered from the generated spec JSON.
- **Live SSE feed viewer** — see events fire as you use the app.
- **WS console** — attach to an open document's socket, send protocol messages, inspect replies.

### Contract tests (phase 2 — falls out of the source of truth by construction)

1. **Generated-files-current test** — regenerates all four artifacts into a temp dir and diffs against the committed ones. A protocol change with stale docs/constants fails `go test`.
2. **Registry completeness** — every dispatched WS type and broadcast SSE event exists in the registry and vice versa (mostly guaranteed structurally by registry-driven dispatch; the test closes the remaining gaps).
3. **JSON endpoint contract tests** — `httptest` against the real handlers, responses validated against the generated schemas.

## Keeping It Current (CLAUDE.md update — required outcome)

Once the protocol package lands, `CLAUDE.md` gains a rule block so future feature work maintains the contract:

- Any new/changed WS message, SSE event, or JSON endpoint **must** be added to `ProtocolRegistry`, followed by `go generate` (all four artifacts regenerate) — the generated-files-current test enforces this.
- New WS/SSE code must use `protocol` constants, never string literals (Go or JS).
- The contract-test suite is part of the definition of done for any API-touching change.

## Error Handling

- Unknown WS message type → typed `error` message back + server log (replaces silent drop).
- Generator failures (unregistered struct, unrepresentable type) fail `go generate` loudly with the offending registry entry named.

## Testing

Phase-2 contract tests above, plus unit tests for the registry type and generator emitters (golden-file tests per artifact).

## Implementation Phases (sketch — detail in the plan)

1. `sieve/protocol` package: constants + structs + registry; refactor `ws_handler.go` and SSE call sites onto it. Pure refactor, wire-identical.
2. **API surface consolidation** — see amendment below. Executed against the phase-1 registry + contract tests; frontend `hx-*` attributes and `fetch()` calls updated in the same change.
3. `tools/protocolgen` + the four artifacts + `editor.js` constant switch-over.
4. Contract-test suite.
5. CLAUDE.md upkeep rules.

(The dev API test ground page is no longer a phase of this work — it is a consumer of the finished contract with nothing depending on it; tracked separately in issue #20.)

---

## Amendment 2026-07-07 — API surface consolidation (new phase 2)

### Rationale

Once the phase-1 ProtocolRegistry lands it gives full visibility into all ~54 registered routes — and that visibility immediately reveals systematic endpoint-per-parameter redundancy. Consolidating before generating artifacts (old phase 2, now phase 3) is critical: the generator must never document endpoints that are about to die. Sequencing: build the ProtocolRegistry first (phase 1 provides the contract-test safety net), consolidate against it (phase 2), then generate artifacts and switch frontend constants (phase 3).

### Goal scoping

Original goal 7 ("Wire format unchanged") needs scoping. It holds **absolutely** for the WebSocket/SSE protocol and for **phase 1** (a wire-identical refactor). Phase 2 deliberately changes HTTP routes as a designed consolidation. The frontend's `hx-*` attributes and `fetch()` calls are updated in the same phase-2 change; the contract-test suite (phase 4, previously phase 3) must pass after the consolidation is applied.

### What to leave alone

The ~20 HTMX fragment-view GETs (`/api/sidebar`, `/api/meta`, `/api/tabs`, `/api/settings`, `/api/help`, `/api/search`, `/api/search-prompt`, `/api/sidebar/search`, `/api/prompts`, `/api/editor`, `/api/library/current`, `/api/library/switch-layout`, `/api/jobs`, …) are each legitimately a separate route in HTML-over-the-wire — they carry distinct template context. They receive a light inventory in `API.md` and are not touched by the consolidation.

### Consolidation mapping (verified against `requesthandlers/*.go`)

**1. Session UI toggles → `POST /api/session/toggle/{panel}` (6→1)**

Current routes take the form `/api/session/{panel}/toggle` — six routes: panel = `sidebar`, `meta`, `prompts`, `toolbar`, `linenumbers`, `askpanel`. Consolidate to a single `POST /api/session/toggle/{panel}` where one handler reads `chi.URLParam(r, "panel")`. The two non-toggle session routes (`POST /api/session/layout`, `POST /api/session/refresh`) are unaffected.

**2. Sidebar item CRUD → `POST /api/sidebar/{op}` + `GET /api/sidebar/dialog/{kind}` (~7→~3)**

Current mutation POSTs: `rename-note`, `rename-folder`, `delete-note`, `delete-folder` (4 routes) share identical business logic split only by item type. Consolidate to `POST /api/sidebar/rename` and `POST /api/sidebar/delete`, each accepting `{"id": "...", "type": "note|folder"}` in the body.

Current dialog GETs: `create-folder-prompt`, `delete-prompt`, `rename-prompt` (3 routes) all follow the same confirm-dialog template-render pattern. Consolidate to `GET /api/sidebar/dialog/{kind}` (kind = `create-folder`, `delete`, `rename`).

Notes on exclusions:
- `POST /api/sidebar/revert-prompt` — despite its name this is **not** a dialog fetcher; it is an action endpoint that executes prompt deletion directly. It stays as-is pending a rename cleanup (tracked separately in TECH-DEBT).
- `GET /api/meta/restore-prompt` — follows the same dialog-render pattern but belongs to the meta/versions namespace; **not** included in the sidebar dialog consolidation.
- `POST /api/sidebar/intent`, `POST /api/sidebar/create-folder`, `POST /api/sidebar/move` — distinct operations, unaffected.

**3. AI job triggers → `POST /api/jobs/{kind}/{id}` (3→1)**

Current routes: `POST /api/ai/keepAndFile/{uuid}`, `POST /api/ai/smartFile/{id}`, `POST /api/ai/smartMetadata/{id}`. Note the existing `{uuid}`/`{id}` parameter-name inconsistency. Consolidate to `POST /api/jobs/{kind}/{id}` (kind = `keep-and-file`, `smart-file`, `smart-metadata`). New job kinds added by the communal JobEngine declare a kind; the single route handles them without minting new endpoints.

**4. True duplicates to collapse**

- `DELETE /api/note/{id}` and `POST /api/sidebar/delete-note` are two live code paths to the same deletion operation. Retire `POST /api/sidebar/delete-note` (subsumed by the sidebar CRUD consolidation above); `DELETE /api/note/{id}` is the canonical path.
- `POST /api/editor/smart-paste` and `POST /api/editor/paste-slice`: paste-slice already delegates to `HandlePaste` server-side. Consolidate to `POST /api/editor/paste` with a payload discriminant (`{"kind": "smart"|"slice", ...}`).

### Guardrail

Target: ≤ 30 operational routes after consolidation (excluding the ~20 fragment-view GETs and the WS/asset endpoints). Do **not** collapse into a generic `POST /api/do {action}` RPC — typed request structs are the point of the contract work.

### Split (2026-07-07)

The dev API test ground (`/api/docs`) is tracked separately in issue #20 — it is pure tooling, a consumer of the finished contract, and no phase of this work depends on it.

---

## Amendment 2026-08-12 — the session channel's frame vocabulary (#74 P3)

The `sieve/protocol` package does not exist yet, so this section is the contract
of record for the **session channel** (`/api/ws?session=1`, Go's `__session__`
sentinel) until phase 1 lands and these become `ProtocolRegistry` entries. Every
frame below is registered when it does; nothing here is a new convention.

The session channel is **not** a second document channel. It carries workspace
traffic — request/reply, no shadow, no claim-on-write — and it has **many
tenants**: the frontend's `WorkspaceService` owns the one socket and routes
inbound frames by their `type` word to the tenant claiming it (`CommandService`,
the `@`-mention picker).

### Client → server

| Type | Payload | Purpose |
|---|---|---|
| `ping` | — | Liveness; answered with `pong`. |
| `command` | `family`, `cmd`, `args.text`, `context`, **`attachments`**, `correlationId` | Dispatch a slash command. |
| `command-cancel` | `correlationId` | Cancel an in-flight command. |
| `mention-query` | `q`, `limit?`, `correlationId` | `@`-picker typeahead. |

### Server → client

| Type | Payload | Purpose |
|---|---|---|
| `pong` | — | Liveness reply. |
| `command-result` | `correlationId`, `cmd`, `status` (`PENDING`/`COMPLETE`/`ERROR`), `block?`, `error?` | Command lifecycle. |
| `mention-result` | `correlationId`, `candidates[]` | Typeahead answer. |

### `mention-query` / `mention-result`

```
→ {"type":"mention-query","q":"auth","limit":8,"correlationId":"c-…"}

← {"type":"mention-result","correlationId":"c-…",
   "candidates":[{"uri":"container:9f2b-…","title":"Auth Design",
                  "kind":"note","detail":"design/ · #auth"}]}
```

A candidate is `domain.Candidate` verbatim (`uri`, `title`, `kind`, `detail`),
served by `editor.Router.Search` — the enumeration face of the same registry
that resolves addresses.

- **Why not a command.** A typeahead needs a sub-100ms answer with no JobEngine
  job, no worker pool and no result block, none of which the command envelope's
  PENDING/COMPLETE lifecycle provides. It is a *sibling frame type on the same
  socket*, not a command family. A second socket was the other option and is the
  shape that produced silent-dead-UI on document channels (`6e2ccfc`).
- **`limit` is floored and capped** server-side (8 default, 25 max): it is
  client-supplied, and an unbounded limit is an unbounded library scan on the
  UI's own socket.
- **`candidates` is never null** — an empty list is "no matches".

### `attachments` on the command envelope

```json
{"type":"command","family":"ai","cmd":"btw","args":{"text":"… @Auth Design …"},
 "context":{…},
 "attachments":[{"uri":"container:9f2b-…","title":"Auth Design"}],
 "correlationId":"c-…"}
```

`attachments` is a **sibling of `context`, never part of it**. `context` is
lens-authored (the SelectionContext); attachments are composer-authored, because
`@` is a composer affordance and the composer is the same textarea that
dispatches `/`. The two are assembled into one `command.Context` at the wire edge
(`WsHandler.handleCommand` → `command.NewContext`), and `Context.Attachments` is
`json:"-"` so an `attachments` key smuggled into the context JSON can never be
read as one.

Every command carries the field; interpreting it is each command's own business.

### Correlated session replies are requester-affine

Both `command-result` and `mention-result` are ack-shaped, so both go back on the
socket the request arrived on (`WsHandler.replyTo`), falling back to the current
`__session__` owner only once the requester is gone. Replying via
`sendTo(sessionChannelKey)` instead is the 2026-07-26 stolen-`/btw` bug: a second
tab registering `__session__` deposes the requester and silently swallows its
answers. Pinned by `TestWS_Command_ResultRoutesToRequester_NotChannelOwner` and
`TestWS_MentionResult_RoutesToRequester_NotChannelOwner`.
