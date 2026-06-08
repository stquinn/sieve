# Rich Link Card — Design Spec

**Date:** 2026-06-08
**Supersedes:** `docs/spec-rich-link-cards.md` (written pre-Sieve Block Framework; architecture no longer applies)

---

## Overview

A Rich Link Card is a **block-level Sieve block** (`kind: rich-link`) that renders OG metadata for a URL as a visual card in the document. It sits between a Smart Link (inline, title only) and a Web Clip (full page content, AI-capable) on the block lifecycle spectrum.

```
Smart Link (inline, title)  →  Rich Link Card (block, OG preview)  →  Web Clip (block, full content + AI)
```

---

## Entry Points

### 1. Keyboard shortcut: `Ctrl+Shift+L`

Opens a URL-input dialog (same pattern as the web clip `createInternalizeDialog`). User enters a URL, presses Enter or clicks Insert → creates a `rich-link` block at the current cursor position. The block job runs in background to fetch OG metadata.

### 2. Right-click SmartLink → "Enrich as Card"

No dialog. Uses the URL already stored in the SmartLink's `href` attr. Immediately:
1. Creates a `rich-link` block at the SmartLink's document position
2. Deletes the SmartLink inline node
3. Background job fetches OG metadata; card updates in place when done

---

## Block Architecture

Follows the Sieve Block Framework. **No standalone TipTap extension file** — uses the shared renderer registration pattern.

### Kind

```
rich-link
```

### Mode

`BlockModeBlock` — block-level, not inline.

### Attrs

| Attr | Type | Description |
|---|---|---|
| `id` | string | Block ID (assigned by server) |
| `href` | string | The URL |
| `title` | string | OG title (or page `<title>` fallback) |
| `description` | string | OG description |
| `image` | string | `asset://` reference (downloaded on enrich; empty if unavailable) |
| `siteName` | string | OG site name (or hostname fallback) |
| `status` | string | `PENDING` / `DISPATCHED` / `COMPLETE` / `ERROR` |
| `createdAt` | string | RFC3339 |
| `completedAt` | string | RFC3339 (when job finished) |
| `fetchedAt` | string | RFC3339 (when OG data was last fetched — used for Refresh) |

### Serialisation

Standard Sieve block fenced format (YAML). Not JSON. Not a `` ```richlink ``` `` fenced code block — that approach predates the block framework.

---

## Go Backend

### `LinkPreviewService.FetchFull(targetURL string) LinkPreviewResult`

Extends the existing `LinkPreviewService` (currently has `FetchTitle` only). Returns full OG metadata + downloads the OG image to the asset store.

Priority ladder for each field (first non-empty wins):

1. `og:title` / `og:description` / `og:image` / `og:site_name`
2. `twitter:title` / `twitter:description` / `twitter:image`
3. `<title>` and `<meta name="description">`
4. Hostname as `siteName` fallback; raw URL as title fallback

**User-Agent:** `Mozilla/5.0` generic browser UA (current approach in `FetchTitle`). If blocked (4xx), retry once — no headless browser.

**Image:** Download and store via `AssetService`. Store `asset://` reference on the block. If image download fails, store empty string — card renders without image, no error.

**Timeout:** 8 seconds total. Return partial data (title/description without image) rather than fail entirely.

**Relative image URLs:** Resolve against the page base URL before downloading.

```go
type LinkPreviewResult struct {
    Title       string
    Description string
    Image       string // asset:// or empty
    SiteName    string
    FetchedAt   string // RFC3339
}
```

### `RichLinkProcessor`

New file: `sieve/rich_link_processor.go`

| Method | Behaviour |
|---|---|
| `Mode()` | `BlockModeBlock` |
| `InitAttrs()` | sets `href`, `status: PENDING`, timestamps; derives initial `title` from `href` if none provided |
| `RunJob()` | calls `FetchFull`, writes all attrs, sets `status: COMPLETE` |
| `BuildContext()` | returns title, description, URL for AI context (used when a Web Clip or AI block has this card in scope) |
| `PasteMatch()` | returns false — URLs on paste become Smart Links, not cards |
| `JobLabel()` | `"Fetching " + hostname` |

Register in `sieve/service_provider.go`:
```go
RegisterProcessor("rich-link", NewRichLinkProcessor(svc))
```

---

## Frontend

### `frontend/src/static/rich-link-renderer.js`

Registers via `T.registerSieveRenderer('rich-link', RichLinkRenderer)`.

#### Card Layout

```
┌─────────────────────────────────────────┐
│ 🔗 GitHub                               │  ← generic link icon (16px) + site name (11px muted)
│ ┌──────┐  Title (bold, linked colour)   │
│ │ IMG  │  Description (2-line clamp)    │  ← thumbnail 72×72 left; content right
│ │ 72px │  url (10px, muted)             │
│ └──────┘                                │
└─────────────────────────────────────────┘
```

**No-image fallback:** favicon row + title + description + URL, no thumbnail column. No layout shift.

**Pending/loading state:** subtle spinner (same style as AI block and Web Clip) in place of thumbnail while `status !== COMPLETE`. Title shows `href` as placeholder.

**Hover:** border lightens (same pattern as other block cards).

**Ctrl+Click:** opens `href` in browser via `window.runtime.BrowserOpenURL`.

#### `buildContextMenuItems`

```
Open URL
Upgrade to Web Clip        ← prominent; natural "next step"
─────────────────────────
Edit Link…
Refresh Metadata           ← background re-fetch; spinner on card while running
Copy URL
─────────────────────────
Downgrade to Smart Link    ← replaces block with paragraph containing inline smart-link node
Promote to Document        ← hardens to markdown (see below)
─────────────────────────
Delete
```

**No AI Ask / AI Explain.** The card's OG metadata is too thin for meaningful AI analysis. The upgrade path to Web Clip is the explicit affordance for AI capability.

#### Refresh Metadata

Sends a `block-refresh` WebSocket message with the block ID. The server sets `status: PENDING` and re-runs `RunJob` for that block. Card updates in place via SSE when the job completes. If `status` is already `PENDING`, the message is ignored (de-duped server-side).

#### Downgrade to Smart Link

Replaces the block node with a new paragraph containing an inline `sieve-smart-link` node, carrying forward `href` and the card's `title` as the SmartLink `label` attr. The Smart Link immediately has its label — no re-fetch needed.

---

## Promote to Document

Hardens the card to portable markdown. Output (Option A — heading + italic source + description):

```markdown
### [Title](url)
*Site Name*

Description text here.
```

If description is empty, omits the description paragraph. If site name is empty, omits the italic line. Title is always present (falls back to URL).

This is deliberately richer than `[Title](url)` — the card's intelligence is baked in, not discarded.

---

## Block Lifecycle Position

| Operation | From | To |
|---|---|---|
| Paste URL | — | Smart Link (inline) |
| Ctrl+Shift+L / "Enrich as Card" | Smart Link or new | Rich Link Card (block) |
| "Upgrade to Web Clip" | Rich Link Card | Web Clip (block, full content) |
| "Downgrade to Smart Link" | Rich Link Card | Smart Link (inline) |
| "Promote to Document" | Rich Link Card | Hardened markdown |

---

## Files Affected

| File | Change |
|---|---|
| `sieve/link_preview_service.go` | Add `FetchFull()` + `LinkPreviewResult` type |
| `sieve/rich_link_processor.go` | New — `RichLinkProcessor` |
| `sieve/service_provider.go` | Register `rich-link` processor |
| `frontend/src/static/rich-link-renderer.js` | New — card renderer + context menu |
| `frontend/src/static/smart-link-renderer.js` | Add "Enrich as Card" context menu item |
| `frontend/src/static/editor.js` | Add `Ctrl+Shift+L` shortcut + URL dialog |
| `frontend/src/index.html` | Load `rich-link-renderer.js` as `<script type="module">` |
| `frontend/src/static/input.css` | Card styles |

---

## Edge Cases

- **SPA / JS-rendered pages:** accept gracefully — fall back to `<title>` or raw URL. No headless browser.
- **Image download failure:** card stored without image. Never store a remote image URL on the block — the card must not have external image dependencies at render time.
- **Duplicate Refresh:** if a Refresh is already in flight (`status === PENDING`), ignore the second request.
- **SmartLink "Enrich as Card" while job pending:** SmartLink may still be fetching its title. Use whatever `href`/`label` attrs are currently present — the card's own job will fetch fresh OG data anyway.
