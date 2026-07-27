# Image placement and sizing — natural size, assets-tab drop, resize handles

**Status:** Designed
**Tracked:** #53 (section 1 — ingest sizing + renderer floor), #68 (sections 3
and 4 — assets-tab drag-drop + two-axis resize), #34 (convert path; may be two
separate defects — see that issue).
**Date:** 2026-07-27

## Problem

Three defects and one gap share a single root cause: **Sieve never learns how
big an image actually is.**

`SmartImageProcessor.Transform` decides sizing *per ingest branch*, and each
branch hand-rolls its own attr map:

| Branch | Returns | Sizing |
|--------|---------|--------|
| base64 data URI (clipboard paste) | `{src}` | none |
| raw `image/svg+xml` | `{src, width: "400"}` | hardcoded default |
| image URL (paste / HTML extract) | its own shape | none |

The consequences:

- **#53** — an SVG with no intrinsic pixel size gets no CSS size and collapses
  to zero; all the user sees is the resize handle. A pasted SVG arrives as a
  `data:image/svg+xml` URI, matches the *first* branch, and never reaches the
  branch that knows SVGs need a default.
- **#34** — diagram→image convert lands unrendered, plausibly the same failure.
- **Ratio-locked resize is silently broken.** `#setupResize` computes
  `ratio = startW / startH` from `img.clientHeight`. On a zero-height image
  that is `0`, so `ratio` falls back to `1` and the image resizes as a square.
  Proportional resize cannot work until dimensions are real.
- **Gap:** an asset owned by the document can only be placed by re-pasting it.
  Assets are never garbage collected (`AssetService` has `ServeAssetData` and
  `Save` — there is no delete path anywhere), so orphaned assets accumulate in
  the Assets tab with no way to put them back into the document.

The per-branch asymmetry *is* the defect. Fixing #53's SVG case alone would
add a fourth special case to a set that already has three.

## Decision

One sizing rule for every ingest path, then two features built on top of it.

### 1. Natural size is stamped at ingest (Go)

Each `Transform` branch shrinks to "save the bytes, return the filename". A
single tail step stamps size on every path:

```go
// method on SmartImageProcessor — behaviour lives with the type that owns it
func (p *SmartImageProcessor) naturalSize(data []byte) (width, height string)
//   raster  → image.DecodeConfig bounds
//   SVG     → root <svg> width/height attrs, else viewBox[2],[3]
//   neither → "", "" (honest unknown; never an error)
```

Stamped onto **four** attrs, not two:

- `width` / `height` — how the image is *displayed*. Initialised to natural
  size; owned by the user thereafter via the resize handles.
- `naturalWidth` / `naturalHeight` — what the asset *is*. Written once at
  ingest, never touched by resize.

The **true** natural size is stamped — not a clamped-to-fit value. Oversized
images are handled at display time by the existing `maxWidth: 100%`; clamping
at ingest would destroy information the resize handles cannot recover.

### 2. Renderer floor (JS)

`smart-image-renderer.js` currently emits `img.style.width = ''` when the
payload width is empty, which is what lets an SVG collapse to nothing. When
width *and* height are both empty, apply a defined minimum instead — proposed
`320px` wide with height `auto`, as a named constant rather than an inline
literal. This repairs every already-broken document on disk with no migration
step.

**Attr surface for the two new fields.** `naturalWidth`/`naturalHeight` are
added in three places, mirroring `width`/`height` exactly: the processor's
`Defaults` map (`smart_image_processor.go:47`), the NodeView's `attrs` and
`parseAttrs` (`smart-image-node-view.js`), and the `SmartImagePayload`
typedef. They serialize through the existing YAML path with no codec change.

### 3. Drag an asset from the Assets tab into the document

**Source.** `meta_assets_tab` gains `draggable="true"` and `data-asset-src` on
image rows only — non-image assets cannot become smart-image blocks. Drag
behaviour is a new ES class using a **delegated** listener on a stable
ancestor: the meta panel is an HTMX fragment whose `innerHTML` is re-swapped on
every tab switch, so per-row listeners would not survive. `dataTransfer` uses a
private `application/x-sieve-asset` type so no external drop handler claims it.

**Target.** `WysiwygSurface` (ProseMirror lives only in `editor/surfaces/`).
`dragover` resolves `posAtCoords` to the nearest block boundary and renders an
insertion line as a **widget `Decoration`** — never a classList write on a
native PM node. `drop` resolves that boundary to a block id and calls:

```js
documentService.createBlock(uuid, 'smart-image', { src: filename }, afterBlockId)
```

The frontend sends **only `src`**. Go stamps the size by reusing `naturalSize`
on asset bytes it already owns, so the drop inherits the sizing fix rather than
duplicating it. Go creates the block and echoes the authoritative node; JS
places it as a tracked transaction.

Images are `group: 'block'`, `inline: false`, `atom: true` — so a drop lands
*between* blocks, never inline mid-paragraph. The insertion line makes that
constraint visible rather than surprising.

### 4. Resize handles encode intent

Three hover-revealed handles extend the existing `#setupResize`:

| Handle | Behaviour | Driven by |
|--------|-----------|-----------|
| corner | proportional (ratio locked) | `clientX`, height derived |
| right edge | width only | `clientX` |
| bottom edge | height only | `clientY` |

The handle you grab *is* the intent. No lock toggle, no mode, no persisted lock
state. Min-size clamped on both axes, matching today's `Math.max(40, …)`.

**Reset to natural size** — double-click the corner handle copies
`naturalWidth`/`naturalHeight` into `width`/`height`. A local attr copy; no
wire op.

All four gestures commit through the **existing** `resize(width, height)`
semantic verb, whose signature already takes both dimensions.

## Architecture

```
INGEST (Go)                          smart_image_processor.go
  paste / raw SVG / URL / convert
      └─ save bytes → filename
      └─ naturalSize(data) ──────► width, height, naturalWidth, naturalHeight

DROP (JS)                            meta_panel.html → asset drag source class
  dragstart  [application/x-sieve-asset: filename]
      │
      ▼                              wysiwyg-surface.js
  dragover → posAtCoords → block boundary → insertion-line Decoration
  drop     → afterBlockId
      │
      ▼                              document-service.js
  createBlock(uuid, 'smart-image', {src}, afterBlockId)
      │
      ▼  Go creates + stamps size, echoes authoritative node at its index
  JS places the server's node as a tracked PM transaction

RESIZE (JS)                          smart-image-renderer.js  (PM-free)
  corner / right / bottom handles ──► resize(width, height) ──► BlockService
  dblclick corner ─────────────────► resize(naturalWidth, naturalHeight)
```

Layer discipline this preserves:

- Sizing knowledge lives in **one** Go method; no JS measures images.
- The drop sends an **anchor block id**, never an index —
  `resolveInsertIndex` remains the one sanctioned PM-resolution callback.
- Backend stays the document source of truth: Go creates the block, JS places
  the returned node. No JS-side splice, no `softReloadContent`.
- Section 4 is renderer-local: it adds no schema of its own (it consumes the
  attrs Section 1 introduced), touches no Go, and makes no PM contact.

## Rationale

**Why one sizing method instead of fixing the SVG branch.** The registry of
ingest branches will keep growing (convert, drop, and whatever ingests next).
A per-branch sizing decision means every new path re-litigates it and one of
them forgets — which is exactly the history that produced #53 and #34. A
single tail step cannot be forgotten by a new branch.

**Why persist natural size rather than recompute it.** Recomputation is
viable — assets are immutable and never deleted, so Go could re-read the bytes
on demand. It was rejected because the block payload is YAML in the markdown:
persisted attrs are the idiomatic, cheap unit here, and "this image is
1200×800" versus "I am displaying it at 400 wide" is a real distinction the
document should record rather than hide behind a wire call.

**Why the handle encodes the intent.** An explicit lock toggle would need a
persisted `lockRatio` attr, a Go processor default, and a new hover control —
schema and chrome growth to express something the choice of handle already
says unambiguously. This is also the standard idiom users arrive with.

**Why "no delete path" matters.** It is what makes re-placing an asset safe:
there is no refcount to get wrong and no GC that could remove a file still
referenced by another block. (`handle_gc.go` governs block-to-block handle
refs, not asset files.)

**Why assets-tab-only drag, for now.** Flipping `draggable: true` on
smart-image to allow repositioning shares the drop target and insertion line,
but adds a move op through Go and has interaction-contract implications for an
atom that is currently a pure caret stop. The drop target is built such that
repositioning is an additive follow-up.

## Open question for implementation

#53 reports that converted diagrams land zero-sized **despite** the raw-SVG
branch setting `width: "400"`. Either convert does not route through
`Transform`, or the width is lost between the attr map and the replace-block
render-back. This must be traced, not assumed — the uniform sizing step fixes
it only if convert actually passes through `Transform`. If it does not, the
convert path needs its own call to `naturalSize`.

## Testing

**Go** (`CGO_ENABLED=0 go test ./...`):
- `naturalSize` table tests — PNG, JPEG, GIF, SVG with `width`/`height` attrs,
  SVG with only `viewBox`, SVG with neither, undecodable bytes (→ empty
  strings, never an error).
- `Transform` — every ingest branch yields non-empty `width` and
  `naturalWidth` for a decodable image.

**JS** (vitest, pure logic only):
- coords → anchor-block-id resolution.
- renderer floor: both dimensions empty → minimum size applied.

**UI** (headless Chrome against `wails dev`): drag from the Assets tab, confirm
the insertion line tracks block boundaries, confirm the dropped image lands at
natural size at the indicated position, and exercise all three resize handles
plus double-click reset. The drop indicator and drag cursor are observed, not
assumed.

## Scope

Sequenced, each landing independently:

1. Natural size at ingest + renderer floor — closes #53, likely closes #34.
2. Assets-tab drag → drop with insertion line.
3. Three resize handles + double-click reset.

Section 1 is a prerequisite for both 2 and 3: the drop needs it to land at a
sensible size, and proportional resize is broken without it.

**Explicitly out of scope:** repositioning existing in-document images
(`draggable` stays `false`); dragging assets between documents (the Assets tab
is document-scoped — `b.Storable().Owns()`); non-image assets.
