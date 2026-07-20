# Block Renderer Extraction — look-and-feel out of the NodeView

**Status:** Accepted
**Tracked:** #43 (epic) — phases #44 #45 #46 #47
**Date:** 2026-07-20
**Context:** Realises the renderer/NodeView split named in
`brainstorm-ai-protocol-roles-chats-and-document-kinds.md` §8 ("one renderer
per kind, three hosts") and prerequisite to its buildable sequence (renderer
split → chat kind → …). Grounded by brainstorm 4's editor-lens model and the
component-model spec (`2026-07-08-workspace-editor-component-model.md`
§Design discipline). Motivated concretely by a shipped defect: the fullscreen
lightbox moved a diagram SVG out of its container and container-scoped CSS
stopped applying (fixed tactically in `b57fe22`).

## Problem

A block kind's **look-and-feel is fused to its PM NodeView, and its styles
are fused to the app stylesheet.** Two couplings, one consequence: a block
can only render correctly inside the note editor's exact environment.

1. **Markup coupling.** Each kind's attrs→DOM logic lives inside its NodeView,
   so producing the block's DOM requires a PM instance. The lenses the
   brainstorm series commits to — chat turns (no PM at all), embedded
   read-only cards, the workbench panels — cannot reuse it.
2. **Style coupling.** Per-kind CSS lives in global `input.css`, so even
   extracted markup would render unstyled (or wrongly styled) in any host
   that doesn't load the editor bundle's cascade. This is not hypothetical:
   the fullscreen lightbox *moves* the rendered SVG out of
   `.diagram-block__render`, the container-scoped `.edgeLabel` rule stopped
   matching, and edge labels went invisible. The lightbox is merely the first
   non-editor host; every future lens re-runs this failure mode.

The two couplings are halves of one problem: **presentation doesn't travel
with the block.** Fixing either alone is incomplete — a renderer class whose
rules still live in `input.css` fails in the chat lens exactly as the SVG
failed in the lightbox.

## Decision

Extract, per block kind, a plain **renderer class** that owns the kind's
complete look-and-feel — **markup and styles together** — bound by this
contract:

> **A renderer's output must be style-complete given only the theme
> variables on `:root`.** Theme vars are the entire host↔renderer styling
> protocol; everything else the renderer carries itself.

Ownership after extraction:

- **Processor (Go)** — data, serialization, jobs, protocol roles. Zero
  presentation. Fully reusable across every lens (this half already holds).
- **Block framework (JS, PM-free services)** — the JS mirror of the Go
  `block/` package: registry, block behaviours, and service-shaped classes
  for the block machinery that is not presentation and not PM — ContentEntry
  assembly, block naming/labels, extraction detection, transport encoding
  (`buildSieveBlockHTML`), job staleness. Today this layer exists but is
  physically welded inside `sieve-block-extension.js` next to the PM node
  factory; it must stand outside PM. **Shape (user decision 2026-07-20): ONE
  facade, one import — `BlockFramework` (`block/framework.js`), the JS
  mirror of Go `block.BlockServices`.** A service is justified by state it
  owns, not a verb category: the facade composes exactly two stateful
  collaborators — `BlockKindRegistry` (the kind→behaviour/renderer map;
  `block-kinds.js` classed) and `RendererStyleRegistry` (exists) — and
  carries the stateless transforms as its own methods (`entriesFor`,
  `labelFor`, `encode`, `detectExtractions` — fetch/offers half only; menu
  DOM stays UI). Per-kind variation stays polymorphic on renderer/behaviour
  classes, never new services. No consumer imports the collaborators
  directly; renderers keep seeing only what `BlockRenderer` wires
  internally (the Go processors-see-ports rule).
- **Renderer (JS class)** — look-and-feel: builds the DOM from attrs and
  carries its stylesheet (`static styles`, registered once on first mount
  via constructable stylesheets / `document.adoptedStyleSheets`, plumbed
  through `fenced-block-base.js` so fenced kinds inherit the mechanism).
- **NodeView / PM adapter** — a thin PM-lifecycle adapter (type
  registration, `ignoreMutation`, update plumbing, `stopEvent`, selection
  claiming, PM transactions) that *wraps* the renderer for the PM host
  only. Other hosts call the renderer directly.

**Package layout** (user decision 2026-07-20 — the directory tree reflects
the layers): `block/` is the PM-free framework (mirroring Go `block/`);
**`block/renderers/`** holds the `BlockRenderer` base, the style registry,
and one concrete renderer class per kind (mirroring Go
`block/processors/`); the PM adapter (NodeView factory, block-chrome, PM
plugins) belongs with the surface that owns PM — `editor/surfaces/` — and
migrates there as X-D retires. `processors/` dissolves kind-by-kind and is
gone by end of P4. Per-kind schema *data* (`nodeConfig`, `attrs`,
`parseAttrs`) stays as declarative statics on the renderer class, consumed
by the adapter — data is not PM coupling; behavioural PM code (guard
plugins, `stopEvent`) is. `prose-block.js` defines a native PM node and
migrates surface-ward at X-D time, not in this epic. Sequencing: P1's
`base/block-renderer.js` + `base/renderer-style-registry.js` move to
`block/renderers/` in the P1 review commit; from P2 on, renderer classes
are born there. **Styles file geography (user decision 2026-07-20):** a
renderer file starts with its class — behaviour first, never a CSS wall.
Any sheet over ~30 lines lives in a sibling
`<kind>-renderer.styles.js` module (`export const <kind>Styles =
/* css */ \`…\``, Lit-style) imported into `static styles`; tiny sheets
may stay inline. The sibling import is renderer-internal and invisible to
consumers.

**Markup discipline** (user decision 2026-07-20): mount builds structure
once; update patches retained slot nodes (`textContent`/`classList`/
`setAttribute`) — never re-renders skeleton via `innerHTML`. Template
*variants* are a smell: analyse them into one structure + a state map
(status → glyph/class/text), the A7-badge shape. Every dynamic slot is
filled via `textContent` — escape-safe by construction; interpolating
attr-derived values into `innerHTML` is banned (web-clip's unescaped
`attrs.error` was a live injection hazard). Geography mirrors styles: a
reduced structural template usually fits as a `static` on the class; only
a genuinely large static skeleton (>~30 lines) goes to a sibling
`<kind>-renderer.templates.js` (structure only, named `data-slot`
markers, zero interpolation).

**The sorting test is PM-specificity** (user decision 2026-07-20): if a
behaviour would work unchanged in a PM-free host (chat lens, embedded
card), it belongs to the block framework or the renderer — never the
adapter, regardless of where it lives today. Only what genuinely speaks
schema/plugin/transaction/selection stays PM-side. Migrations under this
epic route what they touch accordingly; the *full* framework-layer
extraction (registration machinery out of the PM extension file) is X-D
retirement scope, sequenced with — not inside — these phases.

Corollaries:

- **The renderer is the unit of style ownership — not the kind, not the
  host.** A kind may have *several* renderers, one per presentation context:
  the note-lens renderer, a chat-turn bubble (same ai-block data, refs as
  inline chips — brainstorm 5 §6, "the ref, costumed"), an embedded
  read-only card. Each carries its own sheet; N renderers per kind is the
  expected end state, and a shared app stylesheet does not scale to it.
- **Hosts give theme vars, a slot, and arrangement — never CSS.** Which side
  of the screen a chat turn sits, alternation, spacing: that is lens
  grammar, the host's layout. Block internals are the renderer's alone. If a
  block renders wrong in a host that provides `:root` theme vars, the
  renderer is at fault, never the host.
- **Escape hatches ride with the renderer.** When a third-party engine's
  theming surface has a hole (mermaid exposes no edge-label text variable —
  node and edge text share one `.label` colour chain), the patch is injected
  into the renderer's own output (preferred: appended to the engine's
  in-output `<style>`, making the artefact portable even outside the app) —
  never parked in the app stylesheet. `input.css` retains only genuinely
  app-global concerns: shell, typography, theme palette, PM/editor
  mechanics.

## Migration

One migration per kind, **both halves in the same change** — extracting the
renderer and moving its CSS are not separate passes (that would touch every
kind twice for nothing).

- **Effective immediately as policy:** new renderers are born under the
  contract — the chat lens's turn renderer foremost. Definition of done for
  any new renderer: *renders correctly in a bare page providing only `:root`
  theme vars* (trivially checkable in the browser harness).
- **Pilot: the diagram block.** Its interior is already contract-pure
  (`themeVariables` baked from `--theme-*` at render). The pilot = extract
  its renderer class, move the `.sieve-block--diagram` /
  `.diagram-block__*` rules into the renderer's sheet, and re-home the
  `.edgeLabel` patch into mermaid's in-SVG `<style>` — retiring the
  unscoped-global-rule impurity shipped in `b57fe22`. (That re-homing is
  small enough to land standalone if the pilot slips.)
- **Remaining kinds** migrate as opportunity allows; the shared mechanism in
  `fenced-block-base.js` makes each one mostly mechanical.
- **Prose** (user decision 2026-07-20): stops being a presentation-layer
  exception. Framework-level it is a block like any other (already true).
  Per lens: in the PM lens the *surface itself is the adapter* — prose's
  renderer IS ProseMirror, no fake NodeView; in non-PM hosts (chat turn
  message, embedded card, export) prose gets a genuine read-only
  `ProseRenderer extends BlockRenderer` (markdown attrs → `renderMarkdown`
  DOM + typography sheet), built when its first consumer arrives (the chat
  lens) — brainstorm 5 §8's read/worked split, realised. Nothing to do in
  P2–P4; prose has no NodeView to split.
- **Inline kinds** (opinion recorded 2026-07-20, no commitment): the split
  removes the *frontend* half of the 2026-06-19 "inline ≠ block" objection —
  an inline renderer is just a subclass whose `mount()` returns a `<span>`,
  and the `[!kind]{json}[!kind-end]` inline transport already parses. The
  remaining gate is purely the Go model (inline block = child of a prose
  block: tree placement, codec round-trip inside prose, id/job lifecycle) —
  revisit with the block-children/container work. Until then smart-link's
  degrade-to-plain-link default stands, and P4 does not delete its renderer
  hastily.

## Rationale & rejected alternatives

- **Style-portability as its own spec/workstream** (earlier draft of this
  document): rejected — carrying styles is the second half of the renderer
  split, not a sibling. A split without style carriage isn't done; style
  carriage without renderer classes has nowhere to live.
- **"Load `input.css` everywhere."** Couples every future host to the editor
  bundle's full cascade — the assumption the lightbox already broke, and a
  non-starter for PM-free lenses and exported artefacts.
- **Shadow DOM per block.** Maximum isolation, but PM
  selection/contentEditable interplay does not survive shadow boundaries
  cheaply, and theme-var piercing is the only sharing we actually want.
  Constructable stylesheets give ownership-and-travel without fighting the
  editor.
- **Solving mermaid's gap inside `themeVariables`** (light label chips,
  un-inverting `nodeTextColor`): changes the diagram's aesthetic to dodge an
  engine limitation; the escape-hatch rule contains the impurity instead.
- **Real `.css` sidecar files loaded by the registry** (considered
  2026-07-20): native CSS module scripts (`with { type: 'css' }`) are
  Chromium-led with a shaky WebKit/Firefox matrix; without them, dynamic
  loading means `fetch`/`<link>` — async (unstyled first paint) and
  path-coupled, reintroducing the styles-as-separate-deliverable failure
  this spec exists to kill. Vitest(Vite) also has its own `.css` import
  semantics while the app serves statics raw — one file, two loaders. The
  `*.styles.js` sibling keeps styles atomic with the class in app, harness,
  and tests with zero build step; editing ergonomics come from the
  `/* css */` pragma / no-op `css` tag (Lit convention). Escape hatch if
  CSS authoring ever matters enough: a tiny `.css`→`.styles.js` generation
  step beside the tailwind CLI call. Also rejected: a `styles/` subfolder —
  sheets colocate with their renderer (organise by kind, not file type).

## Consequences

- The chat lens, embedded cards, and any future lens consume renderers
  directly — look-and-feel consistency across hosts without PM, as
  brainstorm 5 §8 requires.
- The lightbox class of bug (block DOM moved/borrowed into another
  container) becomes structurally impossible for migrated kinds.
- NodeViews shrink to adapters, which is the shape the component-model
  discipline wants; `input.css` shrinks toward shell + theme + PM mechanics,
  which is the shape the editor-package-cohesion refactor wants.
