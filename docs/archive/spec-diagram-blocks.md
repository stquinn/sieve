# Specification: Diagram Blocks (Mermaid Renderer)

> This spec describes the mermaid renderer within the `code` fenced block infrastructure.
> Read `architecture-block-model.md` and `spec-code-blocks.md` first.

---

## What a Diagram Block Is

A diagram block is a `code` fenced block whose detected language is `mermaid` and whose `mode` is `RENDER`. There is no separate block type — the diagram capability activates when the `code` block's renderer registry finds a match for `language: mermaid`.

````markdown
```code
id: cb-a3f9
language: mermaid
mode: RENDER
status: COMPLETE
source: |
    graph TD
        A-->B
        A-->C
        B-->D
```
````

In `CODE` mode it is a syntax-highlighted code block. In `RENDER` mode it is an SVG diagram. The user toggles between them explicitly.

---

## How a Diagram Block Comes to Exist

### Path 1 — Paste

User pastes a bare ` ```mermaid ... ``` ` block. The paste handler in `editor.js` detects the fence, sends it to `POST /api/code/create` with `hint: mermaid`. Go recognises `mermaid` as a known language, skips the AI detection step, and writes the `code` YAML with `language: mermaid`, `status: COMPLETE`, `mode: CODE` directly. Soft reload. Mode toggle appears immediately.

### Path 2 — AI Detection

User pastes an unrecognised code fence. Go writes a PENDING block, starts `runDetect`. AI returns `language: mermaid`. Go updates the YAML, broadcasts `code:block-resolved`. Soft reload. Mode toggle appears.

### Path 3 — AI Ask Promotion (Type Migration)

User asks AI "draw a deployment diagram for X". AI Ask response contains mermaid source. User right-clicks the AI block → "Promote to Diagram". Go reads the AI block's `response` field, writes a new `code` block with `language: mermaid`, `source: <response>`, `mode: RENDER`. The diagram renders immediately. The original AI Ask block is removed or retained — user choice.

This works because AI Ask and Code are the same underlying shape. Type migration is a field remap, not a structural change. See `architecture-block-model.md`.

---

## Mermaid Renderer Registration

```js
// In code-block-extension.js
const codeRenderers = {
  mermaid: {
    modes: ['CODE', 'RENDER'],
    render: renderMermaid,
  }
}
```

`renderMermaid(attrs, container)` — loads mermaid lazily, calls `mermaid.render()`, injects SVG. On parse error: shows inline error, stays in `CODE` mode.

---

## Mermaid.js Vendoring

Add `mermaid.min.js` to `frontend/src/static/vendor/`. Note: ~2 MB minified — confirm acceptable before pulling in. Must be vendored (Wails WebView has no guaranteed internet access).

Load lazily on first `RENDER` request:

```js
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve()
  return new Promise(function(resolve, reject) {
    var s = document.createElement('script')
    s.src = '/static/vendor/mermaid.min.js'
    s.onload = resolve; s.onerror = reject
    document.head.appendChild(s)
  })
}
```

---

## Theme Integration

Initialise with Sieve CSS custom properties. Re-initialise on `settings:changed`.

```js
function buildMermaidTheme() {
  var s = getComputedStyle(document.documentElement)
  return {
    theme: 'base',
    themeVariables: {
      background:        s.getPropertyValue('--theme-bg').trim(),
      primaryColor:      s.getPropertyValue('--theme-bgAlt').trim(),
      primaryTextColor:  s.getPropertyValue('--theme-text').trim(),
      lineColor:         s.getPropertyValue('--theme-muted').trim(),
      edgeLabelBackground: s.getPropertyValue('--theme-bg').trim(),
    }
  }
}
```

---

## Mode Toggle UX

| Gesture | Effect |
|---------|--------|
| `Ctrl+R` on selected block | Toggle `CODE` ↔ `RENDER` |
| Hover rendered diagram → pencil button | Switch to `CODE` |
| ✓ button in `CODE` mode | Switch to `RENDER` |

Mode toggle is immediate — `updateAttributes({ mode })` triggers NodeView re-render. Persisted on next autosave. No Go roundtrip.

---

## Resize (RENDER mode)

Drag handle in bottom-right corner updates `width` and `height` attrs on `mouseup`. Persisted on next autosave. Omitted attrs default to full editor width at auto height.

---

## Edge Cases

- **Invalid syntax** — `mermaid.render()` rejects → show inline error, remain in `CODE` mode
- **Mermaid not yet loaded** — show brief loading state before SVG appears
- **External Markdown viewers** — degrades to a `code` fenced block with YAML; source is readable; many renderers (GitHub, Obsidian) render `mermaid` natively if the fence tag were `mermaid` — accept this trade-off for now

---

## Future: PlantUML

PlantUML would be a second renderer registration:

```js
codeRenderers.plantuml = {
  modes: ['CODE', 'SERVER'],
  serverAttr: 'server',           // reads attrs.server for the render endpoint
  render: renderPlantUML,
}
```

Go sets `server: <configured-url>` in the YAML when resolving a PlantUML block. The renderer encodes the source and requests the SVG from the server URL. Configurable via settings.

No changes to the `code` block infrastructure required — it is a renderer registration.
