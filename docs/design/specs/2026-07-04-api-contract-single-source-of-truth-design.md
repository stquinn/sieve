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
| `docs/openapi.yaml` | The JSON endpoints |
| `docs/asyncapi.yaml` | WS + SSE channels/messages |
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

> **Vocabulary note (2026-08-20):** two frame pairs postdate this amendment and
> are part of the same channel contract: `mention-resolve` →
> `mention-resolved` (resolve an address/coordinate to a concrete target;
> `found:false` when it isn't one). The channel itself is renamed — see the
> 2026-08-20 amendment: it is the **workspace channel**; "session" survives
> only in the `/api/session/*` HTTP namespace, where it means `domain.Session`
> (tab/panel state), a different concept.

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

---

## Amendment 2026-08-20 — Surface reorganisation: context roots, REST consolidation, push-channel unification

### Drift correction

The problem statement above describes a world that no longer exists: one WS
`switch` mirrored by `onmessage` branches in `editor.js`. Reality is two WS
protocols multiplexed on `/api/ws` (disambiguated by `?session=1`), five
protocol-service classes owning the JS side (`block-service`,
`document-service`, `workspace-service`, `command-service`,
`mention-service`), correlation-id routing that already bypasses type-string
matching for the entire ack family, and ~65 HTTP entry points — four of which
(`/theme.css`, `/sieve-image-proxy`, `/stash/*`, a store-root catch-all) are
intercepted in `main.go`'s pre-chi `muxHandler` and would be **invisible to
the `chi.Walk` route inventory this spec's generator relies on**. Three broken
wire contracts are live today (a JS listener for `ai:block-resolved` that
nothing emits; a `sse:settings:changed` listener that can never fire because
Go signals settings changes via an `HX-Trigger` header; `block-extracted`
emitted by Go and silently dropped by every client) — the concrete version of
the "a typo fails silently" this spec opened with.

### Context roots: `/api` and `/ui`

The surface partitions into two roots, by **semantics, not response format**:

- **`/ui/*` — safe, idempotent, GET-only: views and bytes.** HTMX fragments
  (`/ui/views/{concern}/…`), static files (`/ui/static/*`), `/ui/theme.css`,
  document assets (`/ui/assets/{uuid}/{filename}`), the image proxy
  (`/ui/image-proxy`), and the relative-file fallback (`/ui/files/*`).
- **`/api/*` — operations and protocols.** Every mutation, typed JSON reads,
  and the wires (`/api/ws/document/{uuid}`, `/api/ws/workspace`).

The rule an operation follows is *what it does*, not *what it returns*: HTMX
operations that respond with fragments or OOB `<style>` swaps (session
toggles, sidebar mutations) stay under `/api`. The registry registers only
typed-payload endpoints (a request or response with a real Go type); a
pure-hypermedia operation appears solely via the `chi.Walk` route inventory,
which is truthful by construction and would drift if the registry tried to
mirror it by hand. `/ui` is uniformly safe to GET and cache. `GET /api/library/switch-layout` is revealed by this
rule to be a *read* (renders current session state as styles) and moves to
`/ui/views/session/layout`, dissolving its misfiled-prefix problem. `/mcp`
stays at root — a third protocol face for external agents, neither UI nor app
API. `/` remains index + SPA fallback.

### The pre-chi `muxHandler` is removed; chi becomes the sole router

`/theme.css` and `/sieve-image-proxy` move into chi under `/ui/`. The
`/stash/*` rewrite and its raw-disk `storeHandler` are deleted (no live
caller; only a stale pre-rename `frontend/dist` bundle references them). The
store-root catch-all becomes `/ui/files/*`, served through `AssetService` —
one disk-serving implementation, traversal-guarded, instead of three. With
the interception layer empty, `muxHandler` is deleted and **`chi.Walk` sees
the whole surface**, un-breaking the generator design. Trap carried into the
plan: relative `<img>` srcs in imported markdown resolve against the page
URL, so the renderer must rewrite relative srcs to `/ui/files/…` at render
time — one rewrite point, located during implementation.

**Coordination with #83 (not handled here):** the localhost listener in
`main.go` serves this same mux in production, unauthenticated — that is #83's
security finding, and its fix scopes the listener to `/mcp` only (the
contained CLI's reach into the internal MCP; deleting the listener outright
breaks #36's containment). Phase 2's `muxHandler` removal changes what that
listener serves, so the two changes must land in a conscious order: the
listener must never be left pointing at the full chi router. #83 owns the
listener fix; phase 2 must not regress it.

### Consolidation mapping (supersedes the 2026-07-07 mapping)

| Change | Shape |
|---|---|
| Item CRUD → resource + verb REST | `DELETE /api/note/{id}`, `DELETE /api/folder/{id}`, `PATCH /api/note/{id}` `{"name":…}`, `PATCH /api/folder/{id}`, `POST /api/note` (was `/api/note/new`), `POST /api/folder` (was `create-folder`). Retires the four rename/delete POSTs. The folder open/close toggle hidden in `POST /api/sidebar?toggle=` becomes `PATCH /api/folder/{id}` `{"open":…}` — folder state is a folder property. |
| Deletion duplicate — direction corrected | The 2026-07-07 mapping had this backwards: `DELETE /api/note/{id}` has **no live caller**; the flow is `context-menu.js` → `GET delete-prompt` dialog → `delete.html` confirm → `POST /api/sidebar/delete-note`. The DELETE verb is correct, so the *template's confirm action* is rewired to it and the POST retires. Both callers move: `context-menu.js` to the consolidated dialog view, `delete.html` to `hx-delete`. |
| Session panel toggles 6→1 | `POST /api/session/toggle/{panel}` (unchanged from 2026-07-07) |
| Dialog GETs → views | `GET /ui/views/sidebar/dialog/{kind}` (kind = create-folder, delete, rename); `restore-prompt` stays in meta's view namespace as `/ui/views/meta/dialog/restore` |
| AI job triggers 3→1 | `POST /api/jobs/{kind}/{id}` (unchanged from 2026-07-07) |
| Paste 2→1 | `POST /api/document/paste` with `{"kind":"smart"\|"slice"}` discriminant |
| `editor` → `document` namespace | `/api/editor/*` → `/api/document/*` (load, save, export, paste) — same vocabulary alignment as the wires; a rename, cheap while every caller is already being touched. The stray root-level `POST /api/detect-extractions` joins it as `/api/document/detect-extractions` |
| Dead routes deleted | `POST /api/session/refresh` (zero callers), `/stash/*` (+ `storeHandler`) |

Naming trap recorded for the views migration: `*-prompt` means "confirm
dialog" in five routes and "AI Prompt domain object" in two
(`/api/sidebar/revert-prompt`, `/api/prompts`) — the dialog consolidation
retires the overloaded sense; `revert-prompt` keeps its pending-rename
TECH-DEBT entry.

### Wires: split paths, canonical names

`GET /api/ws/document/{uuid}` and `GET /api/ws/workspace` replace the
query-param multiplex. **Workspace** and **document** are the canonical
channel names everywhere: the Go side's "session WS" identifiers
(`handleSessionWS`, the `__session__` sentinel) are renamed during phase 1's
registry refactor. "Editor" names the UI component consuming the document
wire, never the wire. Frame vocabularies are unchanged — the "wire format
unchanged" guarantee always meant the frames, not the URL.

### Push-channel unification: SSE retires onto the workspace wire

Invalidation is workspace traffic — "a note changed, refresh your view" is
the shell talking to itself — and `jobs:changed` is already protocol traffic
in an SSE costume (a data-bearing snapshot consumed programmatically by JS,
for jobs dispatched *on the workspace wire*). The SSE channel is retired:

- The workspace wire gains a **server→client broadcast family**, fanned out
  to every connected workspace socket (a broadcast primitive in `WsHandler`
  replacing the SSE hub's role):
  - `invalidate` — ONE frame type, topic as data:
    `{"type":"invalidate","topic":"notes|session|prompts|library|intent"}`.
    Each topic is a registry entry; new topics are data, not new frame types.
  - `jobs-changed` — keeps its snapshot payload, delivered where job
    commands live.
  - `container-deleted` — **added 2026-08-21.** Reconciliation NEWS, past
    tense: `{"type":"container-deleted","uuid":"…"}` says the container is
    already gone and each client drops whatever it still holds for that uuid
    (its tab bookkeeping, its editor, that editor's document socket). It
    carries a uuid rather than a topic because nothing is refetched — what
    went stale is the client's own state, not a view — and it is the only
    signal that reaches a document open in a BACKGROUND tab or another
    window, neither of which the delete's HTTP response can swap. A folder
    delete takes every document beneath it, so it emits one frame per
    contained container.
    **CONTAINER, not "document":** `container:{uuid}` is the coordinate
    system's address for a block-holding document, more container kinds are
    coming, and the frame is kind-agnostic — it names a uuid and nothing that
    would let a client care what kind it was.
  - `container-saved` — **added 2026-08-21**, and with it the invariant that
    decides where a save belongs: *a save is a FACT, not a reply.* An earlier
    draft of this bullet overstated it as "the workspace channel carries
    facts" — it does not carry only facts. It also carries the `command` and
    `mention-query`/`mention-resolve` request-reply conversations, which are
    correlated exchanges answered requester-affinely. What the workspace
    channel is, precisely, is the channel every client is on; what makes a save
    belong on it is that a save is news to all of them rather than an answer
    owed to one. A save is a fact about a container, not the outcome of one
    client's request, so
    `{"type":"container-saved","uuid":"…","version":n}` is broadcast from the
    server-side persistence points (two until #32 channels prompts:
    `EditorService.flushShadow` for every document, and the prompt's HTTP save,
    which has no shadow to funnel through) and `flush` becomes a no-reply
    inbound document frame. `flush-ack` is **deleted** — both its roles, the
    request-correlated reply and the unsolicited debounce signal, are the same
    fact said twice on the wrong wire. Explicit flush, debounce autosave, job
    saves, and the prompt pseudo-document's HTTP save all emit the identical
    frame, which is how a prompt gains a saved-signal for the first time. The
    `version` makes the fact ORDERABLE, so a client waiting for its own save to
    land can tell it from a debounce write that was already in flight; a
    container with no version history (a prompt is a plain file) reports 0.
    A FAILED save emits nothing: the document stays dirty, which is the honest
    signal, and the server logs why.
- **Encapsulation boundary:** the transport is workspace-owned
  (`WorkspaceService` already owns the socket); an invalidation tenant
  converts frames into **document-level DOM events**
  (`sieve:invalidate-{topic}`). Consumers stay transport-blind per #49 —
  including the sidebar, which the component model makes a *sibling* of the
  Workspace, not a part of it: it listens to page-global DOM events
  (`hx-trigger="sieve:invalidate-notes from:document"` — the tenant
  dispatches on `document`, and an event dispatched there never reaches
  `body`, so `from:document` is load-bearing, verified empirically during
  implementation) and never touches the wire. Global consumption is
  preserved; only the plumbing is encapsulated.
- **Hypermedia stays HTTP:** the refetches remain plain `hx-get` requests;
  only the nudge transport moves.
- **Reconnect resync:** on workspace socket (re)connect the client treats it
  as a blanket invalidate and refetches all shell views — healing missed
  events, which the SSE hub (no event-id replay) never did.
- **Retired outright:** the `sse/` package, `/sse`, the htmx SSE extension
  from the bundle, and the Wails-native `runtime.EventsEmit("notes:changed")`
  duplicate (after verifying nothing native listens) — the triple-transport
  `notes:changed` loses two of its three transports.

**Two signals, one subject (corrected 2026-08-21).** An earlier draft of the
bullet above claimed `notes:changed` "collapses to one path". It does not, and
should not. A mutating handler emits BOTH the broadcast fact and an
`HX-Trigger: {topic}:changed` header on its own response, and the two answer
different questions: *"someone changed this"* reaches every client
asynchronously, while *"your own request changed this"* reaches the one client
that clicked, synchronously with the response that did it. Keeping only the
broadcast would make a panel lag its own click by a wire round trip; keeping
only the header would leave every other window stale. A duplicate refetch is
much cheaper than either failure, so both are listened for — see the doctrine
comments at `requesthandlers/context_menu_handler.go` (`notesChanged`) and
`Workspace.startTabbar` in `workspace.js`.

**Known asymmetry:** the prompt editor's re-init-in-place
(`Workspace.bootEditorLifecycle`) listens for the HEADER events
(`prompts:changed`, `notes:changed`) only — `sieve:invalidate-prompts` does
not re-init it. This is deliberate: re-init replaces a live editor, so doing it
on a broadcast would let another window's prompt edit yank the buffer out from
under someone mid-keystroke. Revisit if the header path ever retires, because
then the re-init would have no trigger at all.
- **Dead-wire culls:** the `ai:block-resolved` relay div and the
  `sse:settings:changed` listener in `diagram-renderer.js` are removed.
  `block-extracted` stops being emitted — every client has silently dropped
  it for months with no observed breakage; if the additive-hint need
  returns, it returns through the registry.

### The channel razor: endpoint → wire migration (added 2026-08-20, evidence-driven)

A code audit of the operational endpoints found most of the document-family
HTTP surface duplicating the wires it coexists with: the paste endpoints'
responses are provably ignored by the renderer (the `insert-block` WS push is
the authoritative signal); HTTP save is unreachable for note documents
(`DocumentService.save()` prefers the `enter-wysiwyg` handshake whenever a
channel is open, and `NoteEditor` always opens one); the AI-trigger acks are
discarded (`fetch` with no `.then()`); `GET /api/jobs` self-describes in a
comment as accepted debt. The rule that decides where an operation lives:

- **Document wire** — operations that participate in an *open editing
  session's* state (they need the shadow, the claim, or render-backs).
- **Workspace commands** — operations on the workspace's world (library,
  filing, jobs) that reference documents *by address*; meaningful on closed
  documents. "Which document" is an argument, not a channel.
- **HTTP** — hypermedia (fragments, OOB swaps) and genuine byte serving.

Applied: the document wire gains `load`, `paste` (ack = `block.PasteResult`,
replacing smart-paste/paste-slice HTTP), `detect-extractions`, `export`
(it is "Copy as Markdown" consumed by a clipboard call, not a download), and
`focus` (fire-and-forget dwell ping). The **filing family** — smartFile,
smartMetadata, keepAndFile — becomes registered `family=ai` commands
(`command.Command` impls wrapping the same `EditorService` methods; the
pattern `BtwCommand` already set). `GET /api/jobs` is deleted: the workspace
connect-time resync includes a `jobs-changed` broadcast, so the snapshot is
pushed, never polled. `POST /api/session/scroll` becomes a fire-and-forget
`session-scroll` workspace frame. `POST /api/document/save` survives as the
ONLY document HTTP operation, for channel-less prompt pseudo-docs
exclusively (follow-up recorded: give prompts a channel and delete it).
The `/api/document/*` namespace is otherwise never minted.

**Explicitly out of scope of this migration:** block-scoped AI
(describe-image, recognise-code, Ask/Explain ai-blocks) — those are
processor-declared jobs on blocks of an open document and already live
correctly on the document wire (`retry-block-job`, `block-attrs-updated`).
The razor keeps them there.

### Execution model: target-state-first on a dedicated branch (2026-08-20)

The work runs on one branch with no other users of the app on it. **Interim
consistency between phases is explicitly not a requirement** — main holds
current state, the branch heads straight for target state, and phases below
are a build order, not compatibility stages. This deletes a class of
migration machinery the 2026-07-07 phasing implied: no wire-identical interim
refactor, no SSE constants passing through the protocol package on their way
to retirement, no registry entries or golden tests for frames and routes that
do not exist in the target. The registry is written **once, as the target
contract**; wire-fidelity tests pin the target, and the document/workspace
frame vocabularies carry over because they are already right, not because a
guarantee forbids touching them.

1. **Define the target contract** — `sieve/protocol` written directly as the
   target: all document-wire and workspace-wire frames (including
   `invalidate`/`jobs-changed`; SSE never enters the package), target JSON
   endpoint structs, target route table, `ProtocolRegistry` + registry-driven
   dispatch. Workspace/document naming canonicalised in Go here.
   **Self-documenting (2026-08-20 refinement):** prose lives at the
   declaration site, not in the registry — a godoc comment on every
   frame/endpoint struct (extracted by the generator via stdlib
   `go/doc`/`go/ast`) and `doc:"…"` struct tags on non-obvious fields (read
   via reflection). The registry carries wire metadata only; a registered
   type without a godoc comment fails `go generate` loudly. `go doc
   sieve/sieve/protocol` renders the human-readable contract natively —
   the Go equivalent of Java's annotation-driven doc generation.
2. **Backend to target** — route moves, REST CRUD, `muxHandler` deletion, WS
   path split, SSE retirement + `WsHandler` broadcast primitive, dead-route
   and dead-wire deletion. The app may be broken against the old frontend
   mid-phase; that is accepted on the branch.
3. **Frontend to target** — the five protocol services, all `hx-*`/`fetch()`
   callers, the native-menu `htmx.ajax` calls in `main.go`, and the new
   invalidation tenant, all moved to target routes/frames in one sweep.
4. **Generation + contract tests** — `tools/protocolgen`, the four artifacts,
   the five protocol services switch literals to generated constants,
   generated-files-current + registry-completeness + `httptest` contract
   tests. End-to-end validation in the running app closes the branch.
5. **`CLAUDE.md` upkeep rules** + doc updates.

The 2026-07-07 guardrail (≤30 operational `/api` routes, no generic RPC)
stands. The legacy plan file
(`docs/design/plans/2026-07-04-api-contract-ssot.md`) is historical input
only — it predates the protocol services, the idiomatic-JS discipline, and
this execution model; phases are drafted as Forgejo issues at execution
time.
