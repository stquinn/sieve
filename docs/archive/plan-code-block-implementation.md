# Implementation Plan: Generic Code Block

> **Architecture context:** `docs/architecture-block-model.md`
> **Full schema + design:** `docs/spec-code-blocks.md`
> **Diagram renderer (Phase 4):** `docs/spec-diagram-blocks.md`
>
> This plan builds the `code` fenced block — the first generic artifact block and the proof of concept for the renderer registry pattern. When complete it enables diagram blocks (mermaid), and establishes the pattern for all future artifact block types.

---

## What This Builds

- A `code` fenced YAML block type following the established block infrastructure
- Go: `CodeHandler`, `CodeService`, `DetectCodeLanguage` AI service method
- JS: `code-block-extension.js` with paste interception, `CODE` mode NodeView, renderer registry scaffold
- Phase 4 adds the mermaid renderer — diagrams become available without any further infrastructure work

---

## Phase 1 — Go Infrastructure

**Goal:** `POST /api/code/create` accepts a pasted code fence, writes a `code` YAML block to disk, starts language detection, returns `{ id, fence }`. SSE lifecycle works end-to-end.

### Step 1.1 — YAML schema + Go struct

In `sieve/` (alongside existing domain types), define:

```go
type CodeBlock struct {
    ID       string `yaml:"id"`
    Language string `yaml:"language"`
    Mode     string `yaml:"mode"`
    Status   string `yaml:"status"`
    Source   string `yaml:"source"`
    // optional renderer attrs
    Theme    string `yaml:"theme,omitempty"`
    Server   string `yaml:"server,omitempty"`
}
```

`fencedblock.Serialize` handles YAML serialisation. 4-space block scalar indent applies (Rule 3 in `how-to-intelligent-fenced-blocks.md`).

### Step 1.2 — CodeService

New `sieve/code_service.go`:

```go
type CodeService struct { /* store, document service refs */ }

// InsertCodeBlock appends a PENDING code fence to the document and returns the fence text.
func (s *CodeService) InsertCodeBlock(docUUID, id, source, hint string) (fence string, err error)

// ResolveCodeBlock updates the code block YAML on disk with the detected language + status.
func (s *CodeService) ResolveCodeBlock(docUUID, id, language, status string) error
```

Follows the same pattern as `InsertAiBlock`/`ResolveAiBlock` and `InsertWebClip`/`ResolveWebClip`.

### Step 1.3 — DetectCodeLanguage on AIService

New method on `sieve/ai_service.go`:

```go
func (s *AIService) DetectCodeLanguage(source, hint string) (language string, err error)
```

- If `hint` is a known renderable language (`mermaid`, `plantuml`), return it directly — no CLI call
- Otherwise: send source to CLI with a short prompt: "Identify the programming language of this code. Reply with only the lowercase language name, e.g. python, sql, mermaid. If unknown reply: unknown."
- Use a short timeout (5s) — this is a lightweight metadata call

### Step 1.4 — CodeHandler

New `requesthandlers/code_handler.go`:

```go
type CodeHandler struct {
    ServiceProvider *sieve.ServiceProvider
    Broadcast       func(event, data string)
    JobTracker      *JobTracker
}

func (h *CodeHandler) RegisterPaths(r chi.Router) {
    r.Post("/api/code/create", h.handleCreate)
}
```

`handleCreate`:
1. Parse `{ uuid, source, hint }` from request body
2. Generate `id = fmt.Sprintf("cb-%s", randomHex(2))`
3. Call `ServiceProvider.Code.InsertCodeBlock(uuid, id, source, hint)`
4. Start `go h.runDetect(uuid, id, source, hint)`
5. Return `{ id, fence }`

`runDetect`:
1. `h.emitJobStarted(id, "Detecting language...", uuid, false)`
2. Call `ServiceProvider.AI.DetectCodeLanguage(source, hint)`
3. Call `ServiceProvider.Code.ResolveCodeBlock(uuid, id, language, status)`
4. Broadcast `code:block-resolved` with `{ uuid, blkId, language, status }`
5. `h.emitJobEnded(id, uuid)`

If `hint` is a known language, `ResolveCodeBlock` is called immediately (no goroutine needed — but keep the goroutine for consistency, it just returns fast).

### Step 1.5 — Wire in handlers.go

```go
&requesthandlers.CodeHandler{
    ServiceProvider: sp,
    JobTracker:      tracker,   // shared instance
    Broadcast:       hub.broadcast,
},
```

### Step 1.6 — Tests

```
requesthandlers/code_handler_test.go  — handler integration tests
sieve/code_service_test.go            — InsertCodeBlock / ResolveCodeBlock round-trip
```

### Step 1.7 — Compile + verify

```bash
go build ./...
go test ./...
```

---

## Phase 2 — JS Extension Scaffold + CODE Mode

**Goal:** paste a bare code fence → `code` YAML block appears in editor → CODE mode NodeView renders syntax-highlighted source.

### Step 2.1 — New file: `code-block-extension.js`

```js
// code-block-extension.js — generic code block with renderer registry.
// Depends on window.TipTap and window.jsyaml.
import { esc, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'
```

Renderer registry (scaffold — empty until Phase 3):

```js
const codeRenderers = {
  // mermaid: { modes: ['CODE', 'RENDER'], render: renderMermaid }
}
```

### Step 2.2 — TipTap Node

- `name: 'codeBlock'` (or `sieveCode` to avoid collision with TipTap built-in)
- `atom: true`, `group: 'block'`, `draggable: true`
- Attributes: `id`, `language`, `mode`, `status`, `rawYaml`, `theme`, `server`
- Parse: markdown-it fence rule intercepts `code` tag, parses YAML via `jsyaml`, produces node attrs + stores raw YAML in `data-raw-yaml`
- Serialize: replays `node.attrs.rawYaml` verbatim (Rule 1)

### Step 2.3 — NodeView (CODE mode only for now)

Renders a syntax-highlighted code block using `applyHighlighting`. Shows:
- Language badge top-right (e.g. "python", "mermaid", "unknown")
- PENDING state: "Detecting language…" with spinner (uses `isJobActive(id)` + `isStaleByTime`)
- Renderer toggle button placeholder — hidden until a renderer is registered for the language

### Step 2.4 — Paste interception in `editor.js`

Detect bare fenced code block on paste:

```js
var fenceMatch = text.match(/^```(\w*)\n([\s\S]*?)\n```\s*$/)
if (fenceMatch) {
  event.preventDefault()
  flushSave().then(function() {
    fetch('/api/code/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: currentUuid, source: fenceMatch[2], hint: fenceMatch[1] })
    })
    .then(function(r) { return r.json() })
    .then(function(resp) {
      if (!resp || !resp.fence) return
      // insert fence at paste position (same pattern as ai-block insertion)
    })
  })
  return true
}
```

### Step 2.5 — SSE handler + relay div

```js
document.addEventListener('sse:code:block-resolved', function(e) {
  var data = JSON.parse(e.detail || '{}')
  if (data.uuid !== currentUuid) return
  softReloadContent(currentUuid)
})
```

In `index.html`:
```html
<div id="code-sse-relay" hx-trigger="sse:code:block-resolved" style="display:none"></div>
```

### Step 2.6 — Load extension in index.html

```html
<script type="module" src="/static/code-block-extension.js"></script>
```

---

## Phase 3 — Mode Toggle + Renderer Scaffolding

**Goal:** blocks with a registered renderer show a CODE / RENDER toggle. Mode change is immediate, persisted on autosave.

### Step 3.1 — Mode toggle in NodeView

When `codeRenderers[attrs.language]` exists:
- Show toggle button: **Code** / **Render**
- `Ctrl+R` keyboard shortcut toggles `mode` attr
- `updateAttributes({ mode: newMode })` triggers immediate NodeView re-render

### Step 3.2 — Keyboard shortcut extension

```js
addKeyboardShortcuts() {
  return {
    'Mod-r': function() {
      if (!this.editor.isActive('sieveCode')) return false
      var cur = this.editor.getAttributes('sieveCode').mode || 'CODE'
      this.editor.commands.updateAttributes('sieveCode', {
        mode: cur === 'CODE' ? 'RENDER' : 'CODE'
      })
      return true
    }
  }
}
```

### Step 3.3 — Context menu

Wire `sieve:contextmenu` with `type: 'codeBlock'`. Items: **Copy source**, **Delete**, and conditionally **Render** / **Edit** based on renderer availability and current mode.

---

## Phase 4 — Mermaid Renderer

**Goal:** `language: mermaid` blocks render as SVG diagrams in `RENDER` mode. This is the diagram block vision from `spec-diagram-blocks.md`.

### Step 4.1 — Vendor mermaid.min.js

Confirm size (~2 MB) is acceptable. Copy to `frontend/src/static/vendor/mermaid.min.js`.

### Step 4.2 — Register renderer

```js
import { renderMermaid } from './renderers/mermaid-renderer.js'

codeRenderers.mermaid = {
  modes: ['CODE', 'RENDER'],
  render: renderMermaid,
}
```

New file: `frontend/src/static/renderers/mermaid-renderer.js`

### Step 4.3 — renderMermaid implementation

```js
export async function renderMermaid(attrs, container) {
  await ensureMermaid()
  mermaid.initialize(buildMermaidTheme())
  try {
    const { svg } = await window.mermaid.render('mg-' + attrs.id, attrs.source.trim())
    container.innerHTML = svg
  } catch (err) {
    container.innerHTML = '<div class="code-block__error">Diagram error: ' + esc(err.message) + '</div>'
  }
}
```

### Step 4.4 — Theme integration

`buildMermaidTheme()` reads CSS custom properties. Re-initialize on `settings:changed`. See `spec-diagram-blocks.md` for the full variable mapping.

### Step 4.5 — Resize handle

Drag handle in bottom-right of RENDER mode container. `mouseup` calls `updateAttributes({ width, height })`. Persisted on autosave.

### Step 4.6 — Paste shortcut for mermaid

When pasting a bare ` ```mermaid ``` ` fence, `hint: mermaid` is passed to `/api/code/create`. Go skips AI detection and resolves immediately. Block appears in `CODE` mode with the toggle visible — user can switch to `RENDER` instantly.

---

## Completion Criteria

| Phase | Done when |
|-------|-----------|
| 1 | `go test ./...` passes; `POST /api/code/create` returns a fence; SSE fires on detection; YAML on disk is correct |
| 2 | Pasting a code fence produces a `code` block in editor; language badge updates after detection; `softReloadContent` fires on SSE |
| 3 | Mode toggle appears for registered languages; `Ctrl+R` works; mode persists across save/reload |
| 4 | Mermaid diagrams render in RENDER mode; theme matches current Sieve theme; resize handle persists dimensions; error state shown for invalid syntax |
