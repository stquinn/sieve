# Sieve Block Promotion Framework — Design Spec

**Date:** 2026-06-08  
**Revised:** 2026-06-09  
**Status:** Design — ready for implementation

---

## Overview

Content in Sieve moves along a lifecycle spectrum. This framework makes that movement first-class and systematic rather than ad-hoc.

See also: `docs/design-block-lifecycle.md` for the full lifecycle model.

---

## The Two Operations

### Embed (Sieve Block → Markdown)

A live Sieve block is dissolved back into the document as portable markdown. The block loses its UI, its smarts, its iterability — but its intelligence is baked into the content. `MarkdownRepresentation` on the processor provides the output.

> Previously called "Promote to Document." Renamed because it describes what happens: the block is *embedded* into the document flow.

This is a **replace** operation. The block is removed; its markdown representation takes its place.

Already partially implemented via `supportsPromotion: true` on processors. This spec does not change that mechanism.

---

### Extract (Content within a block → new Sieve Block)

Something interesting was found *inside* a block — a mermaid fence in an AI response, an image URL in a web clip — and the user wants to pull it out and work on it as a proper Sieve block.

> Previously called "Promote to [kind]." Renamed because it describes the action: the content is *extracted* from the containing block and given a life of its own.

This is an **additive** operation. The source block is untouched; a new block is created.

This is the primary subject of this spec.

---

## Architecture Principle

**The Go backend is frontend-agnostic.** It deals exclusively in markdown text and structured attrs. No HTML, no SVG, no DOM concepts ever reach the backend interface. The same backend must work equally for a Wails JS frontend, a JavaFX app, a Flutter app, or a CLI.

Detection logic — regex, content pattern matching — belongs in Go where it is testable, consistent, and reusable across any future client.

---

## Interface Changes: `IsBlock` + `Transform`

The existing `PasteMatch` method is split into two:

```go
// IsBlock — fast boolean gate.
// "Can this content become a block of my kind?"
// Pure pattern matching — no processing, no side effects.
IsBlock(entries []ContentEntry) bool

// Transform — called only when IsBlock is true.
// Produces the attrs map for InitAttrs.
// Replaces PasteMatch.
Transform(entries []ContentEntry, docUUID string, cursorBlockID string) map[string]interface{}
```

`PasteMatch` is removed from the interface. Existing processors are migrated to `IsBlock` + `Transform`.

> good defensaive programming dictates that the Transform function should probably call isBlock on any inpout to ensure it can be processed

### Why the split?

Detection (Extract menu building) needs to run `IsBlock` across all processors cheaply — no processing, no asset creation, just yes/no. `Transform` is only called when the user has committed to a specific extraction. Separating them makes the detection path free and the execution path explicit.

---

## ContentEntry (replaces PasteEntry)

```go
type ContentEntry struct {
    MIMEType string
    Content  string
}
```

Renamed from `PasteEntry`. The type represents "a piece of content with a MIME type" — this is true for paste, for detection, and for extract execution. The name `PasteEntry` was too narrow.

Not all `ContentEntry` values can become a block — the type is generic. `IsBlock` is the gate.

---

## Smart Paste Flow (unchanged behaviour, updated mechanics)

```
for each processor (in registration order):
    if processor.IsBlock(entries):
        attrs = processor.Transform(entries, docUUID, cursorBlockID)
        InitAttrs(id, attrs) → create block
        stop
```

First match wins. Same behaviour as today.

---

## Extract Detection Flow

Triggered on right-click of any Sieve block.

```
JS: build ContentEntry[] from the click context (see below)
JS: POST /api/detect-extractions { sourceKind, entries }
Go: for each processor (except sourceKind):
        if processor.IsBlock(entries): add { kind } to results
Go: return [{ kind }, ...]
JS: build "Extract as [kind]" menu items from results
    (UI derives label from kind — no label in API response)
```

Detection is **free** — `IsBlock` is pure pattern matching. No assets are created. No rendering occurs.

---

## Extract Execution Flow

Triggered when the user clicks an "Extract as [kind]" menu item.

```
JS: targetRenderer.resolveEntries(entries) → resolved ContentEntry[]  [async, may show spinner]
JS: send WS event `extract` { kind, entries: transformedEntries }
Go: processor.Transform(entries, docUUID, cursorBlockID) → attrs
Go: InitAttrs(id, attrs) → create block
```

The `extract` WS event delegates to the same code path as paste — `Transform` then `InitAttrs` — with the target processor pre-selected rather than discovered by first-match scan.

**Asset must exist before block is created.** `Transform` for `SmartImageProcessor` saves the asset first, then returns attrs with the stored `src`. No block is ever created with a PENDING status pointing at an asset that does not yet exist.

---

## ContentEntry from the Click Context

The JS builds `ContentEntry[]` by walking up the DOM from `event.target` to the nearest `.sieve-block` boundary.

**The JS has zero knowledge of what is extractable.** It only performs generic DOM classification — it does not know that `language-mermaid` is special. It describes what it found; Go decides whether it matters.

```
click lands on <code class="language-X"> inside a block
  → ContentEntry { mimeType: "text/plain", content: <fence text including ``` delimiters> }

click lands on <img src="...">
  → ContentEntry { mimeType: "text/uri-list", content: <src URL> }

click lands on <a href="...">
  → ContentEntry { mimeType: "text/uri-list", content: <href URL> }

click reaches .sieve-block without matching anything specific
  → no ContentEntry built — detect-extractions is not called
  → no "Extract as" items appear in the menu
  → only native block actions and Embed (if supportsPromotion: true) are shown
```

The content extracted from the clicked element IS the data sent to the backend. The backend does not need to re-locate the node — it was given the content directly.

**Background click is not an extraction.** Embed (the stock `supportsPromotion` path) is always available independently of this framework and is not triggered by the DOM walk.

**Duplicate content:** if the same mermaid fence appears twice in a block and the user clicks one, both produce identical ContentEntry values and identical extraction results. This is acceptable — extracting either copy produces the same block.

---

## `resolveEntries` — JS Target Renderer Hook

Called **only at execution time** (after the user has clicked a specific "Extract as" item), not at detection time.

The JS holds the `ContentEntry[]` built during the DOM walk in memory for the lifetime of the context menu. When the user clicks a menu item, that same array is passed into `resolveEntries` on the target renderer. Some entries need work to reach their final form before being sent to the backend (mermaid text → SVG); others are already resolved and pass straight through.

**Default (base framework):** pass-through. Returns entries unchanged. Correct for any processor whose `Transform` works directly on text or URI content.

**`SmartImageRenderer` override:**

```js
async resolveEntries(entries) {
  const text = entries.find(e => e.mimeType === 'text/plain')?.content
  if (isMermaidFence(text)) {
    // render mermaid source → SVG (may be slow — spinner shown on source block)
    await ensureMermaid()                         // from diagram-renderer.js (exported)
    const { svg } = await mermaid.render(uniqueId, extractMermaidSource(text))
    return [{ mimeType: 'image/svg+xml', content: svg }]
  }
  // already image bytes (image/png, image/svg+xml from diagram block render mode)
  return entries
}
```

**Mermaid rendering source:**
- If source block is a **diagram block in render mode**: SVG is already in the DOM. `createContentEntry` captures it directly — no mermaid render step needed. Fast path.
- If source block is a **diagram block in edit mode** or **any other block** (AI, web clip, code): mermaid source is text only. `createContentEntry` renders it programmatically. May be perceptible on slower machines — a spinner is shown on the source block while this runs.

"Extract as Smart Image" is available from any block in any mode, consistent with the principle that the same content in an AI block (never rendered) should have no more friction than the same content in a diagram block.

**`ensureMermaid()` is exported from `diagram-renderer.js`** and imported by `smart-image-renderer.js`. Mermaid rendering knowledge lives in exactly one place.

---

## `SmartImageProcessor.IsBlock` Detects Mermaid

`SmartImageProcessor.IsBlock` returns true for:
- `image/*` MIME types
- `text/uri-list` containing image URLs (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`)
- `text/plain` containing a ` ```mermaid ` fence

The last case is what enables "Extract as Smart Image" from any block containing mermaid source. The processor is the authority on what can become a Smart Image — including content that requires a render step before it can be stored.

---

## Self-Suppression

The framework passes `sourceKind` to `/api/detect-extractions`. Any processor whose kind matches `sourceKind` is skipped. A diagram block does not offer "Extract as Diagram."

---

## Context Menu Layout

```
┌────────────────────────────────────────────┐
│  AI BLOCK · diagram                        │  ← context-aware header (see below)
│  ─────────────────────────────────────     │
│  (native AI block actions…)                │
│  ─────────────────────────────────────     │
│  ◈  Extract as Diagram                     │
│  ◈  Extract as Smart Image                 │
│  ─────────────────────────────────────     │
│  ◈  Embed in document                      │  ← always present (MarkdownRepresentation)
└────────────────────────────────────────────┘
```

If no extractions are detected, the extraction section and its divider are omitted. "Embed in document" is always present for blocks with `supportsPromotion: true`.

### Context-Aware Header

When the DOM walk identifies a specific element (not a background click), the menu header annotates the block kind with what was targeted. This explains to the user why extra options are present and what content they apply to.

| What JS found | Header |
|---|---|
| `<code class="language-mermaid">` | `AI BLOCK · diagram` |
| `<code class="language-X">` (other) | `AI BLOCK · code` |
| `<img>` | `AI BLOCK · image` |
| `<a href>` | `AI BLOCK · link` |
| Reached `.sieve-block` (background) | `AI BLOCK` |

The suffix is derived from the ContentEntry at click time — the JS knows what it found during the DOM walk before calling `detect-extractions`. The annotation is purely a UI label; it does not affect the API call.

The suffix is rendered in the same visual style as the block kind label but muted — a contextual annotation, not a separate primary label. A light separator (`·`) reads more naturally than parentheses at small sizes.

---

## API: `/api/detect-extractions`

```
POST /api/detect-extractions
Content-Type: application/json

{
  "uuid":       "abc123",       // current document
  "sourceKind": "ai-block",     // for self-suppression
  "entries": [                  // ContentEntry[] describing what was clicked
    { "mimeType": "text/plain", "content": "```mermaid\ngraph TD\n  A-->B\n```" }
  ]
}

→ 200 OK
[
  { "kind": "diagram" },
  { "kind": "smart-image" }
]
```

No labels in the response. The UI derives "Extract as Diagram", "Extract as Smart Image" from the kind.

No attrs in the response. Attrs are computed at execution time by `Transform`, not speculatively at detection time.

---

## WS Event: `extract`

```json
{
  "type":    "extract",
  "uuid":    "doc-abc123",
  "kind":    "diagram",
  "entries": [
    { "mimeType": "text/plain", "content": "```mermaid\ngraph TD\n  A-->B\n```" }
  ]
}
```

Go handler routes to the named processor. Calls `Transform(entries, ...)` → `InitAttrs` → creates block. Identical code path to paste, processor pre-selected.

---

## The Combinatorial Payoff

| Source block contains | Extract offered |
|---|---|
| AI response with mermaid fence | → Diagram, Smart Image |
| AI response with code fence | → Code Block |
| AI response with image URL | → Smart Image |
| AI response with bare URL | → Rich Link |
| Web Clip with mermaid | → Diagram, Smart Image |
| Web Clip with image URL | → Smart Image |
| Web Clip with URL | → Rich Link |
| Diagram block (any mode) | → Smart Image |

Every new processor added in future participates automatically — it implements `IsBlock` and `Transform`, and extraction from every existing block type gains the new kind for free.

---

## Migration: PasteMatch → IsBlock + Transform

All existing processors must be migrated. The split is mechanical:

```go
// Before
func (p *FooProcessor) PasteMatch(entries []PasteEntry, docUUID, cursorBlockID string) (bool, map[string]interface{}) {
    // detect and extract in one step
}

// After
func (p *FooProcessor) IsBlock(entries []ContentEntry) bool {
    // detection only — same logic, return bool
}
func (p *FooProcessor) Transform(entries []ContentEntry, docUUID, cursorBlockID string) map[string]interface{} {
    // extraction — same attr-building logic
}
```

---

## Out of Scope (V1)

- Extraction from inline content (a URL in a paragraph) — only block-level Sieve nodes are sources
- Batch extraction (extract all detected items at once) — single item per menu click
- Extraction into native TipTap nodes (plain `<img>`, plain links) — Smart Image and Rich Link cover these
- Pre-computing extraction candidates at block creation time — detection is fast (pure `IsBlock`, no I/O) and called only on right-click; pre-computation is unnecessary
- PDF, spreadsheet, and other binary-to-image extraction paths — `SmartImageProcessor.IsBlock` will detect them; `createContentEntry` rendering hooks are deferred until those source types exist
