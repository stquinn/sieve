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
2. `tools/protocolgen` + the four artifacts + `editor.js` constant switch-over.
3. Contract-test suite.
4. Dev API test ground page.
5. CLAUDE.md upkeep rules.
