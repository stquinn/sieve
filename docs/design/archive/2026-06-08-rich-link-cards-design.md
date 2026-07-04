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
| `supportsPromotion` | bool | `true` — signals framework to show "Promote to Document" in context menu |
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
| `InitAttrs()` | sets `href`, `supportsPromotion: true`, `status: PENDING`, timestamps |
| `RunJob()` | calls `FetchFull`, writes all attrs, sets `status: COMPLETE` |
| `BuildContext()` | returns title, description, URL for AI context |
| `MarkdownRepresentation()` | `### [Title](href)\n*SiteName*\n\nDescription` — returns `""` if href empty |
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

## Promote to Document Framework

"Promote to Document" is a **framework-level capability** that replaces a fenced sieve block with portable markdown prose, both in the live TipTap editor and in the stored document on disk. Rich Link Card is the first block to introduce this; all existing blocks that support promotion are updated in the same work.

### Go: `BlockProcessor.MarkdownRepresentation`

New method on the `BlockProcessor` interface:

```go
MarkdownRepresentation(block SieveBlock) string
```

Returns the block's content as portable markdown prose. Returns `""` for blocks that don't support promotion. `EditorService` calls this — processors never interact with `markdown_parser.go` directly.

| Processor | Output |
|---|---|
| `RichLinkProcessor` | `### [Title](href)\n*SiteName*\n\nDescription` |
| `AIBlockProcessor` | `### {question}\n\n{response}` (question as H3; response only if no question) |
| `WebClipProcessor` | `### [Title](source)\n\n{content}` (title+link as H3, then fetched content verbatim) |
| `SmartImageProcessor` | `![{alt}]({src})` — uses AI-generated `alt`; falls back to `summary` if `alt` empty |
| `CodeBlockProcessor` | ` ```{language}\n{source}\n``` ` |
| `SmartLinkProcessor` | `""` — already portable markdown, no promotion needed |

`supportsPromotion: true` is set in `InitAttrs` for all processors except `SmartLinkProcessor`. This boolean travels in the block YAML and signals the JS framework to show the context menu item.

### Go: `PromoteBlock` in `markdown_parser.go`

New exported function alongside `InjectBlocks`:

```go
func PromoteBlock(markdown string, blockID string, content string) (string, bool)
```

Same goldmark byte-offset splice approach as `InjectBlocks`. Finds the block by ID, replaces its byte range with `content` (plain markdown prose) rather than re-serialized YAML. Returns updated markdown + found bool.

### Go: `EditorService.PromoteBlock`

```go
func (es *EditorService) PromoteBlock(uuid, blockID string) (content string, err error)
```

Coordinates the operation:
1. Look up block in shadow
2. Get processor, call `MarkdownRepresentation(block)` — returns error if `""`
3. Call `PromoteBlock(shadow.Markdown, blockID, content)` to splice the document
4. Flush to disk
5. Return the content string

### Go: `ws_handler.go` — `promote-block` message

```
Client → Server: { "type": "promote-block", "id": "ri-a1b2", "uuid": "..." }
Server → Client: { "type": "block-promoted", "id": "ri-a1b2", "content": "### [Title]..." }
```

Error (block not found, kind doesn't support promotion): silently ignored — no response sent.

### JS: `sieve-block-extension.js` framework injection

`supportsPromotion` added as a **base attr** (default `false`) so every sieve block node carries it after parsing.

When building the context menu, after the retry/replay section:

```js
if (n.attrs.supportsPromotion && status === 'COMPLETE') {
  items = items.concat([
    { type: 'divider' },
    { icon: IC.promote, label: 'Promote to Document',
      action: function () {
        document.dispatchEvent(new CustomEvent('sieve:promote-block', {
          detail: { id: n.attrs.id }
        }))
      }
    }
  ])
}
```

This means **no renderer ever needs to add "Promote to Document" manually**. The framework handles it for any block where Go sets `supportsPromotion: true`.

### JS: `editor.js` — promote event + WS handler

`sieve:promote-block` listener → sends WS message.

`block-promoted` WS case → soft reload:
```js
// find node by id, replace with rendered HTML
var html = currentEditor.storage.markdown.parser.md.render(msg.content)
currentEditor.commands.insertContentAt({ from: nodePos, to: nodePos + nodeSize }, html + '<p></p>')
```

### JS: Cleanup in existing renderers

**`web-clip-renderer.js`:** Remove `promoteWebClip` function and the manual "Promote to Document" context menu item. Framework auto-injects it.

**`context-menu.js` (AI Block):** Replace `promoteAiBlock` call with `sieve:promote-block` dispatch. Remove the `promoteAiBlock` function. The menu item stays (including its `disabled` logic) but its action changes.

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
| `sieve/processor_registry.go` | Add `MarkdownRepresentation(block SieveBlock) string` to `BlockProcessor` interface |
| `sieve/link_preview_service.go` | Add `FetchFull()` + `LinkPreviewResult` type |
| `sieve/rich_link_processor.go` | New — `RichLinkProcessor` (incl. `MarkdownRepresentation`, `supportsPromotion: true`) |
| `sieve/ai_block_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` in `InitAttrs` |
| `sieve/web_clip_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` in `InitAttrs` |
| `sieve/smart_image_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` in `InitAttrs` |
| `sieve/code_processor.go` | Add `MarkdownRepresentation` + `supportsPromotion: true` in `InitAttrs` |
| `sieve/smart_link_processor.go` | Add `MarkdownRepresentation` (returns `""`) |
| `sieve/markdown_parser.go` | Add `PromoteBlock(markdown, blockID, content string) (string, bool)` |
| `sieve/editor_service.go` | Add `PromoteBlock(uuid, blockID string) (string, error)` |
| `sieve/service_provider.go` | Register `rich-link` processor |
| `requesthandlers/ws_handler.go` | Add `promote-block` WS message case |
| `frontend/src/static/sieve-block-extension.js` | Add `supportsPromotion` base attr; auto-inject "Promote to Document" menu item |
| `frontend/src/static/rich-link-renderer.js` | New — card renderer + context menu (no manual promote item — framework handles it) |
| `frontend/src/static/smart-link-renderer.js` | Add "Enrich as Card" context menu item |
| `frontend/src/static/web-clip-renderer.js` | Remove `promoteWebClip` + manual promote item |
| `frontend/src/static/context-menu.js` | AI Block: replace `promoteAiBlock` with `sieve:promote-block` dispatch |
| `frontend/src/static/editor.js` | `Ctrl+Shift+L` dialog; `sieve:promote-block` → WS; `block-promoted` soft reload; enrich/upgrade handlers |
| `frontend/src/index.html` | Load `rich-link-renderer.js` as `<script type="module">` |
| `frontend/src/static/input.css` | Card styles |

---

## Edge Cases

- **SPA / JS-rendered pages:** accept gracefully — fall back to `<title>` or raw URL. No headless browser.
- **Image download failure:** card stored without image. Never store a remote image URL on the block — the card must not have external image dependencies at render time.
- **Duplicate Refresh:** if a Refresh is already in flight (`status === PENDING`), ignore the second request.
- **SmartLink "Enrich as Card" while job pending:** SmartLink may still be fetching its title. Use whatever `href`/`label` attrs are currently present — the card's own job will fetch fresh OG data anyway.
