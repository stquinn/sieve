> **STATUS: DONE** — shipped 2026-07-23 on `feature/plantuml-54` (11 commits, merged v0.21.0); all work items + 4 defect fixes in-branch, lightbox zoom-anchor fix (#35) rode along. Theming Tier 1 follow-up: #56. Archived 2026-07-23.

# PlantUML Diagram Support

*2026-07-23 · Tracked: #54*

## Problem

The diagram block renders mermaid only. PlantUML is the other lingua franca of
software diagramming (class/sequence/state/C4), and the maintainer is a software
architect — PlantUML sources show up in pastes and are authored directly. Sieve
cannot render them.

PlantUML rendering is inseparable from its Java engine: there is no native Go
renderer (the Go "plantuml" libraries generate PlantUML *text* from Go source —
the opposite direction), and the CheerpJ/WASM browser port is a JVM-in-WASM
heavyweight that has no place in this app. Rendering therefore means asking a
PlantUML server (public or self-hosted) for SVG.

## Decision

**One diagram kind; the engine is an attr.** `diagramType` (already on the
block, hardcoded consumer-side to mermaid) gains `"plantuml"` as its second
legal value. No new block kind, no parallel machinery.

**Rendering is a processor job, not a bespoke endpoint.** Every block that
consumes backend resources declares a job; plantuml rendering is no exception.
`DiagramProcessor.DescribeJob` returns a render job for plantuml blocks whose
source has changed since the last render; the job fetches SVG from the
configured server and persists it as a document asset. The frontend stays
fully passive — it displays job status and the rendered asset, exactly like
every other job-backed kind. (An earlier draft proposed a `POST
/api/plantuml/svg` handler called from the renderer; rejected as a second
async flow bypassing the job mechanism.)

**Diagram settings are a family.** A nested `DiagramSettings` object
(`"diagram"`, mirroring the `AISettings` pattern) carries
`plantuml_server` (default `https://www.plantuml.com/plantuml`) and
`default_type` (default `"mermaid"` — the engine new diagram blocks are born
with). The Settings panel gets a **Diagrams section**: the server field with
one-line help text stating that diagram source is sent to the configured
server (the privacy trade-off is visible, not silent), plus a
default-language dropdown.

## Architecture

### Go

- `services/plantuml_service.go` — `PlantumlService`: the PlantUML text
  encoding (deflate + PlantUML's base64 variant, a method not a free function)
  + HTTP fetch. Server URL read via settings at call time (no restart needed).
  Errors distinguish "no/bad server" from "server returned non-200".
  - Implements a new **`block.PlantumlPort`** (`Render(source string) ([]byte,
    error)`) — the sixth port beside `AIPort`/`AssetsPort`/etc., owned by
    `block/`, implemented in `services/`, wired by the composition root.
  - The backend seam: v1 ships the HTTP backend; a local
    `plantuml.jar -pipe -tsvg` backend can be added later behind the same
    `Render` without touching callers.
- `block/processors/diagram_processor.go` —
  - `DescribeJob`: nil for mermaid (unchanged). For plantuml, returns a job
    only when **`mode == "render"`** and source is non-empty and
    `hash(source) != attrs.renderedHash`. Typing in edit mode syncs source but
    never dispatches (no render surface is visible; rendering would be wasted
    server calls); the flip to render pushes the `mode` attr and *that* update
    satisfies the dispatch condition. Flip with an unchanged source → hash
    matches → no job → the existing asset displays instantly
    (`renderedHash` is the render cache key).
  - **Theming — the legibility floor is in scope.** Raw PlantUML output
    (near-black on transparent) is unreadable in dark themes — a defect,
    not a nicety. The job composes *effective source* = **theme preamble +
    user source**: a stock `!theme` / couple of `skinparam` lines
    (background + font color) mapped from the app theme's light/dark
    family. Prepend order gives correct precedence for free (user
    directives later in the file override ours); the preamble is part of
    the render input and therefore of `renderedHash` — theme switches make
    blocks honestly stale with zero new invalidation machinery (the
    existing `sse:settings:changed` hook can nudge visible rendered blocks
    to re-dispatch). The processor job owns the composition;
    `PlantumlService` stays dumb transport. Full `--theme-*` fidelity
    (mermaid's `themeVariables` equivalent) is the follow-up tier; CSS
    post-patching (inline `fill`/`stroke` attrs, no classes) and
    `filter: invert()` hacks are rejected.
  - The job, in strict order: compose effective source →
    `PlantumlPort.Render` → write SVG via
    `AssetsPort` as **one asset per block** (stable name from the block ID,
    overwritten each render — no GC question) → *then* set
    `{svgAsset, renderedHash, status: COMPLETE}`. The asset exists before the
    COMPLETE render-back reaches the frontend, so the renderer never waits or
    polls — the status attr is the synchronization, exactly as for
    ai-block/web-clip. Standard ERROR status on failure.
  - `InitAttrs`: `diagramType` defaults from `DiagramSettings.DefaultType`
    (settings reachable via the processor's `BlockServices`) instead of the
    hardcoded `"mermaid"`. Precedence: explicit override (paste/transform
    detection) → settings default → mermaid. A plantuml block with source
    starts PENDING so dispatch fires; mermaid stays COMPLETE as today.
  - `IsSupportedContent`/`Transform`: plantuml mirrors of the mermaid paths —
    ```` ```plantuml ```` fences and `code` blocks with `language: plantuml`
    become diagram blocks with `diagramType: "plantuml"`. A shared
    `PlantumlFenceRe` sits beside `MermaidFenceRe` in `block/`.
  - `MarkdownRepresentation`/`BuildContext`: fence language follows
    `diagramType` instead of hardcoded ```` ```mermaid ````.
- `domain/settings.go` — nested `DiagramSettings { PlantumlServer, DefaultType }`
  under `"diagram"` + defaults + `ParseSettings` overlay; settings save
  handler passes it through.

### Frontend (`block/renderers/diagram-renderer.js`)

- Header: the hardcoded `mermaid` label becomes a **dropdown styled as the
  type label** (chevron on hover) in the header's left slot, listing the
  engines. A dropdown, not a toggle pair: engines are an open set (d2,
  graphviz plausible later) while edit/render is a closed pair — the widget
  matches the cardinality of what it selects. Picking an engine pushes
  `diagramType` via `_pushAttrs` (semantic-verb pattern); the attrs-driven
  render path handles the switch. **No source translation** on switch — the
  source is text; wrong-engine syntax gets that engine's error card, honestly.
- Render path branches on `diagramType`:
  - `mermaid` → existing client-side path, unchanged.
  - `plantuml` → passive display: PENDING renders through the existing
    job-status machinery (StatusBadge/spinner); COMPLETE fetches the
    **same-origin asset URL** and inlines the SVG into the same panzoom wrap,
    so pan/zoom, expand, and the lightbox work identically. Unlike the
    mermaid branch (which holds a local render promise), the plantuml branch
    is event-driven: each status transition (PENDING → COMPLETE/ERROR)
    arrives as an attrs render-back → a fresh `update()` cycle, and the
    renderer repaints as a pure function of attrs — the only in-flight
    promise is the final short asset fetch. A re-opened document with a
    previously rendered diagram displays instantly from the persisted asset,
    no job fired.
  - Shared display tail: everything after "I have SVG text" is one method
    (`#displaySvg(svgText)`, plus `#displayError(msg)`) — panzoom wrap,
    insertion, style patch, error card. Mermaid feeds it from its local
    render promise; plantuml feeds it from the asset fetch on COMPLETE. The
    acquisition differs (local computation vs job-backed attrs sync — the
    ai-block/web-clip family pattern); a promise-that-awaits-update() was
    considered for symmetry and rejected: it wraps the event code without
    replacing it, and its instance-bound lifetime races NodeView recreation
    while the block-bound job survives. (Same-origin is
    also why the browser never talks to the PlantUML server: cross-origin
    fetch of inline-able SVG is at the mercy of each server's CORS config,
    and plain-http LAN servers trip mixed-content rules from the app's
    origin.)
- Errors: ERROR status reuses the existing error card. PlantUML syntax errors
  arrive as an SVG *drawing* of the error and render as-is — acceptable and
  informative.
- Edit mode (gutter + code surface + Mod+Enter flip) is untouched.
- Export/extraction entry path: `renderMermaidSvgEntry` generalizes to
  `renderDiagramSvgEntry` with a second acquisition branch — mermaid → local
  `mermaid.render()` (as today); plantuml → fetch the same-origin `svgAsset`
  and return its text. Same `image/svg+xml` ContentEntry out, so the
  smart-image pipeline downstream is untouched (it persists the entry as the
  new block's own asset — the "copy with a new ID" happens where it always
  has). The plantuml branch resolves only when `svgAsset` exists (rendered at
  least once — in practice always, since extraction is chosen while looking
  at the render); never-rendered behaves like empty-source mermaid: no entry.

## Rationale

- One kind + attr is the uniform mechanism; a second diagram kind would fork
  every affordance (paste, transform, expand, contract policy) for no gain.
- Job flow over a render endpoint: processors' backend-resource use has ONE
  sanctioned path (DescribeJob + job engine). A bespoke endpoint would be a
  second async flow with its own lifecycle, status, and error story — pure
  asymmetry. The job also makes the SVG a persisted asset, so offline re-open
  and export embedding arrive in v1 instead of as follow-ups.
- Public-server default (user decision): zero-friction out of the box; the
  settings help text keeps the data-egress visible.

## Out of scope (follow-ups)

- Full `--theme-*` fidelity theming (per-var `skinparam` mapping, the
  mermaid `themeVariables` equivalent) — the light/dark legibility floor IS
  in scope (see the job's theme preamble above); only the fidelity tier is
  deferred.
- Local-jar rendering backend (`java -jar plantuml.jar -pipe -tsvg`) behind the
  `PlantumlPort.Render` seam.
