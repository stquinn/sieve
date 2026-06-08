# Sieve Block Promotion Framework — Design Spec

**Date:** 2026-06-08
**Status:** Design / Pre-implementation

---

## Overview

Any Sieve block that contains rich content (an AI response, a web clip body, a code block) may contain material that belongs in a different block type. Today this is handled ad-hoc: the AI block renderer was patched to detect mermaid fences and offer "Promote to Diagram". That approach is brittle — detection logic for one block type leaks into another, and every new block type requires patching unrelated renderers.

This spec describes a **self-fulfilling promotion framework** baked into the Sieve Block Framework itself. Each `BlockProcessor` in Go declares what promotions it can detect from a block of text. The framework asks all registered processors at context-menu time and assembles promotion options automatically. No processor ever needs to know about any other processor.

> **Design decision — detection lives in Go, not JS.**  
> Detection logic (regex, URL parsing, fence extraction) belongs alongside `PasteMatch` in the Go `BlockProcessor` — not scattered across JS renderer files. Go is easier to test, reason about, and keep consistent. The JS client remains thin: it calls a lightweight API endpoint to get promotions for the current block, then renders them. This also means promotion logic is available to any future client (CLI, API, mobile) without re-implementation.


> TODO you kind of hint at ait....but ebing able to use promote to smart image on a diagram is ridiculously powerful - its basically a  really clkever way to export the image - but allow us to work on the read only version of the diagram

---

## Symmetry with PasteMatch

Every `BlockProcessor` already implements `PasteMatch` — the inbound question: *"can I create a block from this pasted content?"*

Promotion detection is the outbound mirror: *"given this block's content, what other blocks could be created from it?"*

This makes the `BlockProcessor` interface self-contained and symmetric:

```
PasteMatch(entries []PasteEntry, ...) (bool, map[string]interface{})
  → "Can I absorb this incoming content?"

DetectPromotions(text string) []PromotionSuggestion
  → "What could be created from this outgoing content?"
```

Both methods live on the same interface. Both are testable in isolation. Both are ignorant of other block types.

---

## Core Concept

The `BlockProcessor` interface gains one optional method:

```go
type PromotionSuggestion struct {
    Kind  string            // e.g. "diagram", "smart-image"
    Label string            // e.g. "Promote to Diagram"
    Attrs map[string]any    // attrs to pass to CreateBlock
}

// Optional — processors that cannot detect anything simply omit it.
DetectPromotions(text string) []PromotionSuggestion
```

At context-menu time, the flow is:

1. User right-clicks a Sieve block
2. JS client calls `POST /api/detect-promotions` with `{ kind, text, clickTarget }` (see Context-Aware Click below)
3. Go handler calls `DetectPromotions(text)` on **every** registered processor except the source kind
4. Aggregates all `[]PromotionSuggestion` results and returns them as JSON
5. JS renders each as a "Promote to…" menu item, dispatching `sieve:create-block` on click

No JS renderer knows about any other renderer. No Go processor knows about any other processor.

> am wondering most blocks are static - this could be precomputed by the backend - When inserted into the shadow.  Could be a yaml proprty - maybe an array or something

---

## Context-Aware Click

When a block contains multiple items of the same kind — for example an AI response with two images, or three code fences — showing a numbered list ("Promote Image 1", "Promote Image 2") is confusing. The user right-clicked on *something specific* and probably means just that thing.

### How it works

The right-click event carries a DOM target (`event.target`). The JS client walks up the DOM from the click target to identify the nearest promotable element:

| User clicks on | Identified as |
|---|---|
| An `<img>` tag | That specific image's `src` |
| A `<pre><code class="language-mermaid">` block | That specific mermaid fence |
| A `<pre><code class="language-python">` block | That specific code fence |
| A `<a href>` hyperlink | That specific URL |
| The block's background / chrome | No click target — fall back to full scan |

When a specific click target is identified, the client sends `clickTarget: { type: "image", src: "..." }` (or similar) alongside the full `text`. Go can then:

- **If `clickTarget` is present:** run `DetectPromotions` but filter to only the suggestion matching the clicked element. The menu shows a single, unambiguous item: *"Promote to Smart Image"*.
- **If `clickTarget` is absent:** run the full scan and show all detected items, numbered if there are multiples.

### Result

```
User right-clicks Image 2 inside a web clip:

  ┌─────────────────────────────────────┐
  │  WEB CLIP                           │
  │  ─────────────────────────────────  │
  │  (native actions…)                  │
  │  ─────────────────────────────────  │
  │  ◈  Promote to Smart Image          │  ← just this image, no number
  └─────────────────────────────────────┘

User right-clicks the block background:

  ┌─────────────────────────────────────┐
  │  WEB CLIP                           │
  │  ─────────────────────────────────  │
  │  (native actions…)                  │
  │  ─────────────────────────────────  │
  │  ◈  Promote to Diagram              │
  │  ◈  Promote Image 1 to Smart Image  │
  │  ◈  Promote Image 2 to Smart Image  │
  │  ◈  Promote to Link Card            │
  └─────────────────────────────────────┘
```

This is the right UX default: **be specific when the user is specific, be comprehensive when they are not.**

---

## ContentData Shape

`getContentData` returns a structured object rather than a plain string, so target renderers can work from already-parsed structure where available:

```js
{
  text:   string,        // Raw markdown/plain-text body (for pattern matching)
  html:   string,        // Raw HTML body if available (for web clips etc.)
  images: [              // Already-resolved image assets, if any
    { src: string, alt: string }
  ],
  urls:   string[],      // Already-resolved hyperlinks, if any
}
```

Renderers that have no rich structure (e.g. a code block) just populate `text`. Renderers with richer data (e.g. a web clip) populate whichever fields they have.

---

## Promotion Shape

`detectInContent` returns an array of promotion descriptors:

```js
{
  label:  string,        // Menu label, e.g. "Promote to Diagram"
  kind:   string,        // Sieve block kind, e.g. "diagram"
  attrs:  object,        // Attrs to pass to sieve:create-block
}
```

The framework dispatches `sieve:create-block` with `{ kind, attrs }` when the user clicks a promotion item. This is the same event already used by keyboard shortcuts and the context menu's "Insert…" actions — no new plumbing required.

---

## Source Renderers

These renderers implement `getContentData`:

| Renderer | `text` | `html` | `images` | `urls` |
|---|---|---|---|---|
| `ai-block` | `node.attrs.response` (markdown) | — | — | — |
| `web-clip` | `node.attrs.body` (markdown) | `node.attrs.rawHtml` if stored | Parsed from body/HTML | Parsed from body/HTML |
| `code` | `node.attrs.source` | — | — | — |
| `smart-image` | `node.attrs.summary` + `node.attrs.alt` | — | `[{ src: node.attrs.src, alt: node.attrs.alt }]` | — |

---

## Target Renderers

These renderers implement `detectInContent`:

### `diagram`

Scans `data.text` for mermaid fenced blocks:

```
```mermaid
...
```
```

Returns one `Promotion` per match:
- `label`: `"Promote to Diagram"` (or `"Promote to Diagram 2"` if multiple)
- `kind`: `"diagram"`
- `attrs`: `{ source: <extracted source>, mode: "render" }`

### `code`

Scans `data.text` for any fenced code block with a language tag:

```
```python
...
```
```

Returns one `Promotion` per match:
- `label`: `"Promote to Code Block (python)"`
- `kind`: `"code"`
- `attrs`: `{ source: <extracted source>, language: "python" }`

> Note: A code block promoting its own source to another code block is intentionally a no-op — the framework should suppress self-promotion (same kind as source).

### `smart-image`

Scans `data.images` (already parsed) and `data.text` for markdown image syntax (`![alt](https://…)`) and bare image URLs (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`).

Returns one `Promotion` per image:
- `label`: `"Promote Image to Smart Image"` (or `"Promote Image 1…"` if multiple)
- `kind`: `"smart-image"`
- `attrs`: `{ src: <url> }`

When the server receives `create-block` with `kind: smart-image` and a remote `src`, `InitAttrs` sets `status: PENDING` and `RunJob` automatically downloads the image and triggers AI description via `DescribeImage`. The user gets a fully AI-described, locally-stored Smart Image block for free.

### `rich-link`

Scans `data.urls` (already parsed) and `data.text` for bare `https://` URLs that are **not** image URLs.

Returns one `Promotion` per URL:
- `label`: `"Promote to Link Card"` (or `"Promote Link 1…"` if multiple)
- `kind`: `"rich-link"`
- `attrs`: `{ href: <url> }`

---

## The Combinatorial Payoff

With no changes to existing source renderers, the following promotions become available automatically the moment target renderers implement `detectInContent`:

| Source block contains | Promotion offered |
|---|---|
| AI response with mermaid | → Diagram Block |
| AI response with code fence | → Code Block |
| AI response with image URL | → Smart Image Block |
| AI response with URL | → Link Card |
| Web Clip body with mermaid | → Diagram Block |
| Web Clip body with image URL | → Smart Image Block |
| Web Clip body with URL | → Link Card |
| Web Clip body with code | → Code Block |
| Code block containing a URL | → Link Card |
| Smart Image (alt text describing mermaid?) | — (unlikely but works) |

Every new block type added in future participates automatically by implementing `detectInContent`. Every existing source block automatically gains the ability to promote to it.

---

## Context Menu Rendering

Promotions are grouped into a dedicated section, separated by a divider, after the block's own native actions:

```
┌────────────────────────────────────────┐
│  WEB CLIP                              │
│  ──────────────────────────────────    │
│  (native web clip actions…)            │
│  ─────────────────────────────────     │
│  ◈  Promote to Diagram                 │
│  ◈  Promote Image 1 to Smart Image     │
│  ◈  Promote Image 2 to Smart Image     │
│  ◈  Promote to Link Card               │
└────────────────────────────────────────┘
```

If no promotions are detected, the divider and section are omitted entirely.

---

## Self-Suppression

A renderer should not offer to promote content to its own kind. The framework suppresses any `Promotion` where `kind === sourceRendererKind`. This prevents e.g. a code block promoting its source to another code block.

---

## Implementation Scope

### Go backend

| File | Change |
|---|---|
| `sieve/block_processor.go` | Add `DetectPromotions(text string) []PromotionSuggestion` to the `BlockProcessor` interface (as an optional method via interface check, so existing processors don't break) |
| `sieve/diagram_processor.go` | Implement `DetectPromotions` — mermaid fence regex |
| `sieve/code_processor.go` | Implement `DetectPromotions` — fenced code block regex |
| `sieve/smart_image_processor.go` | Implement `DetectPromotions` — markdown image syntax + bare image URLs |
| `sieve/rich_link_processor.go` | Implement `DetectPromotions` — bare HTTPS URLs (non-image) |
| `sieve/router.go` (or equivalent) | Add `POST /api/detect-promotions` endpoint |

### JS client (thin layer only)

| File | Change |
|---|---|
| `frontend/src/static/context-menu.js` | On right-click of a Sieve block: extract `text` from node attrs, identify `clickTarget` from DOM event, call `/api/detect-promotions`, render results |
| `frontend/src/static/ai-block-renderer.js` | **Remove** hardcoded mermaid detection (was interim) |

> All JS renderer files (`diagram-renderer.js`, `smart-image-renderer.js`, etc.) require **zero changes**. Detection is entirely in Go.

---

## API: `/api/detect-promotions`

```
POST /api/detect-promotions
Content-Type: application/json

{
  "uuid":        "abc123",          // current document
  "kind":        "web-clip",        // source block kind (for self-suppression)
  "text":        "...markdown...",  // full text content of the block
  "clickTarget": {                  // optional — what the user right-clicked on
    "type": "image",
    "src":  "https://example.com/photo.jpg"
  }
}

→ 200 OK
[
  { "kind": "smart-image", "label": "Promote to Smart Image", "attrs": { "src": "https://example.com/photo.jpg" } }
]
```

With no `clickTarget`, all detections are returned. With a `clickTarget`, only suggestions that match the specific clicked element are returned.

---

## Out of Scope

- Promoting into native TipTap nodes (plain `<img>` or links) rather than Sieve blocks — Smart Image and Rich Link already cover these cases as proper blocks.
- Batch promotion (promoting all detected items at once) — single-item promotion per menu item is sufficient for V1.
- Promotion from inline content (e.g. a paragraph containing a URL) — only block-level Sieve nodes participate as sources.
- Caching promotion results — the endpoint is fast (pure regex, no I/O) and called only on right-click, so caching is unnecessary.
