# Specification: Rich Link Cards

## 1. Overview

Links in Sieve operate in two modes:

| Mode | Node Type | When Used |
|------|-----------|-----------|
| **Inline** | `SmartLink` (existing) | Drafting, prose, documents |
| **Card** | `RichLinkCard` (new) | Research, reference, saved URLs |

Inline links auto-fetch a title on paste (replaces the raw URL as the label). Cards are an explicit upgrade — right-click → "Enrich as Card" — that fetches full Open Graph metadata and renders a block-level visual preview.

---

## 2. Storage Format

Rich link cards use a fenced code block with language tag `richlink`:

````markdown
```richlink
{
  "url": "https://github.com/anthropics/claude-code",
  "title": "Claude Code",
  "description": "The official CLI for Claude.",
  "image": "asset://abc123.jpg",
  "siteName": "GitHub",
  "fetchedAt": "2026-05-02T10:00:00Z"
}
```
````

- Degrades gracefully in any Markdown renderer as a readable code block
- `image` references Sieve's existing asset system — the image is downloaded and stored locally on enrich, preventing link rot
- `fetchedAt` allows future UI to show staleness and offer a "Refresh" action
- Round-trips cleanly through TipTap's markdown serializer

---

## 3. Metadata Fetch — Go Backend

### 3.1 Endpoint

```
GET /api/link-preview?url=<encoded-url>&mode=<title|full>
```

- `mode=title` — returns only the title (fast, used on paste for inline links)
- `mode=full` — returns all OG fields + downloads the image to the asset store

### 3.2 Response

```json
{
  "url": "https://...",
  "title": "...",
  "description": "...",
  "image": "asset://abc123.jpg",
  "siteName": "...",
  "fetchedAt": "2026-05-02T10:00:00Z"
}
```

### 3.3 Fetch Logic (Go)

Priority ladder — first non-empty value wins:

1. `og:title` / `og:description` / `og:image` / `og:site_name`
2. `twitter:title` / `twitter:description` / `twitter:image`
3. `<title>` and `<meta name="description">`
4. First `<h1>` and first `<p>` (heuristic fallback)

**User-Agent:** spoof `WhatsApp/2.21.12.21 A` — sites serve richer metadata to known social bots.

**Relative image URLs:** resolve against the base URL before storing.

**Image download:** on `mode=full`, fetch the image and store via `AssetService`. Store the `asset://` reference, not the remote URL. This makes the card resilient to link rot.

---

## 4. Phase 1 — Inline Title Fetch on Paste

No new node type. Enhances the existing `SmartLink`.

**Behaviour:** when a bare URL is pasted, TipTap intercepts it, fires `GET /api/link-preview?url=...&mode=title`, and sets the `label` attribute to the fetched title. The `detect` attribute on `SmartLink` tracks state:

| `detect` value | Meaning |
|----------------|---------|
| `pending` | fetch in flight |
| `titled` | title resolved, inline only |
| `enriched` | full card data available |

If the fetch fails or times out, `label` falls back to the raw URL — no error shown.

---

## 5. Phase 2 — Rich Link Card

### 5.1 User Flow

1. Right-click a `SmartLink` node
2. Context menu: **"Enrich as Card"**
3. Sieve fires `GET /api/link-preview?url=...&mode=full`
4. On success: replaces the inline `SmartLink` with a `RichLinkCard` block node
5. On failure: shows a transient error in the context menu, link unchanged

### 5.2 TipTap Extension

New file: `frontend/src/static/rich-link-card-extension.js`
Loaded as `<script type="module">` in `index.html`, exported as `T.RichLinkCard`.

Node properties:
```js
name: 'richLinkCard'
group: 'block'
atom: true       // single selectable unit, no editable content inside
draggable: true
```

Attributes: `url`, `title`, `description`, `image`, `siteName`, `fetchedAt`

**Parse:** markdown-it fence rule intercepts `richlink` language tag, parses JSON payload, produces `richLinkCard` node.

**Serialize:** writes the fenced JSON block.

### 5.3 NodeView

The card renders as a block element. Layout:

```
┌─────────────────────────────────────────┐
│  [thumbnail]   Title                    │
│                Site Name                │
│                Description (2 lines)    │
│                url (truncated)          │
└─────────────────────────────────────────┘
```

- Thumbnail is omitted if no image was fetched
- Ctrl+Click opens the URL in the browser (same pattern as `SmartLink`)
- Right-click: context menu with "Open URL", "Copy URL", "Convert to Inline Link", "Refresh Metadata"

### 5.4 Converting Back

"Convert to Inline Link" replaces the `RichLinkCard` block with a `SmartLink` inline node using the stored `title` and `url`. Non-destructive — no data is lost since the URL is preserved.

---

## 6. File Layout

| File | Purpose |
|------|---------|
| `frontend/src/static/rich-link-card-extension.js` | `RichLinkCard` TipTap extension |
| `requesthandlers/link_preview.go` | `/api/link-preview` handler |
| `sieve/link_preview_service.go` | OG fetch logic, asset download |

---

## 7. Edge Cases

- **SPAs / JS-rendered pages:** `http.Get` will not see OG tags injected by JavaScript. Accept this gracefully — fall back to `<title>` or raw URL. Do not introduce a headless browser dependency.
- **403 / bot blocking:** if the WhatsApp User-Agent is blocked, retry with a generic browser UA once before giving up.
- **Timeout:** fetch must complete within 5 seconds. Return partial data (title only if image is slow) rather than failing entirely.
- **Duplicate enrichment:** if a URL is already a `RichLinkCard`, "Enrich" re-fetches and updates metadata in place rather than nesting a new card.
- **Asset failure:** if the image download fails, store the card without an image. Do not store a remote image URL — cards must not have external image dependencies at render time.
