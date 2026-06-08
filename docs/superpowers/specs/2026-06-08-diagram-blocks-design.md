# Diagram Block — Design Spec

**Date:** 2026-06-08
**Supersedes:** `docs/spec-diagram-blocks.md` (written pre-Sieve Block Framework; architecture no longer applies)

---

## Overview

A Diagram Block is a **block-level Sieve block** (`kind: diagram`) that renders Mermaid diagrams inline in the document. The user can toggle between an edit mode (source editor) and a render mode (SVG output) at any time; the active mode is persisted in the block's YAML.

The old spec (`spec-diagram-blocks.md`) is treated as requirements inspiration only. The implementation follows the Sieve Block Framework exclusively — no architecture from the old spec applies.

---

## Entry Points

### 1. Keyboard shortcut: `Ctrl+Shift+D`

Creates a `diagram` block at the current cursor position with empty source and `mode: "edit"` — the user lands directly in the editor.

### 2. Paste detection (`PasteMatch`)

Pasting a ` ```mermaid\n...\n``` ` fenced block creates a `diagram` block with the source extracted and `mode: "render"` — paste implies intent to view.

### Backlog (not in this spec)

- Right-click AI Ask block → "Promote to Diagram" (when response contains mermaid source)
- Right-click code block with `language: mermaid` → "Convert to Diagram"

---

## Block Architecture

Follows the Sieve Block Framework. Uses the shared renderer registration pattern — no standalone TipTap extension file.

### Kind

```
diagram
```

### Mode

`BlockModeBlock`

### Attrs

| Attr | Type | Description |
|---|---|---|
| `id` | string | Block ID (assigned by server) |
| `source` | string | Diagram source text |
| `diagramType` | string | `"mermaid"` — extensibility hook for future renderers |
| `mode` | string | `"edit"` \| `"render"` — persisted in YAML, survives document reload |
| `status` | string | Always `COMPLETE` — no async server job; rendering is client-side |
| `supportsPromotion` | bool | `true` — framework injects "Promote to Document" in context menu |
| `createdAt` | string | RFC3339 |

### Serialisation

Standard Sieve block fenced format (YAML). `fencedblock.Serialize` handles all YAML generation.

---

## Go Backend

### `DiagramProcessor`

New file: `sieve/diagram_processor.go`

**No server-side job.** `InitAttrs` sets `status: COMPLETE` directly — `DispatchJobIfNeeded` sees a non-PENDING status and skips dispatch. `JobLabel` returns `""`. `RunJob` is a no-op to satisfy the interface.

| Method | Behaviour |
|---|---|
| `Mode()` | `BlockModeBlock` |
| `InitAttrs()` | Sets `source`, `diagramType: "mermaid"`, `mode: "render"` (or `"edit"` if source is empty), `status: COMPLETE`, `supportsPromotion: true`, `createdAt` |
| `PasteMatch()` | Detects ` ```mermaid\n...\n``` ` fenced blocks; returns `(true, { source: ..., mode: "render" })` |
| `OnChange()` | No-op — mode/source changes are persisted by the framework without triggering a new job |
| `BuildContext()` | Returns ` ```mermaid\n{source}\n``` ` for AI context |
| `JobLabel()` | Returns `""` — no spinner, no job tracking |
| `RunJob()` | No-op; returns nil |
| `MarkdownRepresentation()` | Returns ` ```mermaid\n{source}\n``` ` — promotes to a portable fenced block (renders natively on GitHub, Obsidian) |

Register in `sieve/service_provider.go`:

```go
RegisterProcessor("diagram", NewDiagramProcessor(svc))
```

---

## Frontend

### `frontend/src/static/diagram-renderer.js`

Registers via `T.registerSieveRenderer('diagram', DiagramRenderer)`.

#### Block Layout

The block has a **persistent header in both modes** — the primary navigation affordance. No hover-only controls.

```
┌─ header (always visible) ──────────────────────────────────────────┐
│ [diagram] [mermaid]                    [ Edit | Render ] (toggle)  │
└────────────────────────────────────────────────────────────────────┘
┌─ body (swapped by mode) ───────────────────────────────────────────┐
│  edit mode:   [ gutter ] [ textarea + syntax-highlight overlay ]   │
│  render mode: [ SVG from mermaid.js, full width ]                  │
└────────────────────────────────────────────────────────────────────┘
```

#### Header — Pill Toggle

The header shows a segmented pill toggle with two tabs: **Edit** and **Render**. The active tab is highlighted:

- Edit active → accent blue tint
- Render active → accent green tint
- Inactive tab → muted, no tint

Clicking either tab dispatches `sieve:block-update { mode: "edit" | "render" }`. The framework saves the updated attr to the shadow document; `OnChange` is a no-op so no side effects occur.

#### Edit Mode Body

Mirrors the code block structure exactly: line gutter + CSS grid cell with textarea + syntax-highlight overlay (`pre>code`). Independent CSS classes (`sieve-block--diagram`) — same visual pattern, no shared code.

- Tab → 2 spaces
- Source changes flushed to Go shadow via `sieve:block-update { source: ... }` on input (200ms debounce) and on blur
- Mermaid syntax highlighting applied to the overlay if lowlight supports it; falls back to plain text overlay without visual regression

#### Render Mode Body

On switching to render mode:

1. Lazy-load `vendor/mermaid.min.js` if not already loaded
2. Initialise mermaid with Sieve's CSS custom properties (theme variables for bg, text, borders) so diagrams inherit the active theme; re-initialise on `settings:changed`
3. Call `mermaid.render(uniqueId, source)` → inject returned SVG into container div. `uniqueId` is derived from the block's `id` attr (e.g. `"mermaid-di-a3f9"`) to ensure DOM uniqueness.
4. On render error: display inline error message, dispatch `sieve:block-update { mode: "edit" }` to flip back to edit mode. Error is transient client state — not stored in YAML.

#### `buildContextMenuItems`

```
Edit source / Render     ← toggles the current mode
─────────────────────
Copy source
Ask AI…                  ← precomputedCtx with mermaid source as content
─────────────────────
Promote to Document      ← injected by framework (supportsPromotion: true)
Delete
```

"Edit source" appears when in render mode; "Render" appears when in edit mode.

---

## Mermaid Library

- Vendored at `frontend/src/static/vendor/mermaid.min.js`
- ~2 MB minified — confirm acceptable before pulling in
- Lazy-loaded on first render request (not on page load)
- Wails WebView has no guaranteed internet access — vendoring is required

```js
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve()
  return new Promise(function (resolve, reject) {
    var s = document.createElement('script')
    s.src = '/static/vendor/mermaid.min.js'
    s.onload = resolve
    s.onerror = reject
    document.head.appendChild(s)
  })
}
```

---

## Help Page

Add `Ctrl+Shift+D` to the **AI & View Gestures** section in `frontend/src/templates/help.html`, alongside the existing `Ctrl+Shift+W` (Internalise URL) entry:

```html
<tr>
  <td class="help-modal__keys">
    <kbd class="help-modal__kbd">Mod</kbd><span class="help-modal__plus">+</span>
    <kbd class="help-modal__kbd">Shift</kbd><span class="help-modal__plus">+</span>
    <kbd class="help-modal__kbd">D</kbd>
  </td>
  <td class="help-modal__desc">Insert Diagram</td>
</tr>
```

---

## Edge Cases

- **Empty source in render mode:** if source is empty when the user switches to render mode, show a placeholder ("Add diagram source in Edit mode") rather than calling mermaid with empty input.
- **Invalid mermaid syntax:** `mermaid.render()` rejects → inline error message, flip to edit mode automatically.
- **Mermaid not yet loaded:** show a brief loading indicator while the script loads; render once resolved.
- **Theme change:** re-initialise mermaid on `settings:changed` SSE event and re-render current SVG.
- **External markdown viewers:** degrades to a ` ```mermaid ``` ` fenced block — readable source, renders natively on GitHub/Obsidian.

---

## Files Affected

| File | Change |
|---|---|
| `sieve/diagram_processor.go` | New — `DiagramProcessor` (all six `BlockProcessor` methods) |
| `sieve/service_provider.go` | Register `"diagram"` processor |
| `frontend/src/static/diagram-renderer.js` | New — renderer with persistent header, pill toggle, edit/render modes, mermaid lazy-load |
| `frontend/src/static/vendor/mermaid.min.js` | New — vendored mermaid library (~2 MB) |
| `frontend/src/index.html` | Add `<script type="module" src="/static/diagram-renderer.js">` |
| `frontend/src/static/input.css` | Diagram block styles (header, pill toggle, gutter, render area) |
| `frontend/src/static/editor.js` | `Ctrl+Shift+D` shortcut → `create-block` WS message |
| `frontend/src/templates/help.html` | Add `Ctrl+Shift+D` → "Insert Diagram" in AI & View Gestures section |
