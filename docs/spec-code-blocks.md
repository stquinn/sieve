# Specification: Intelligent Code Blocks

## 1. Overview

Intelligent code blocks unify all "code with possible rendering" into a single fenced YAML block type — `code`. A bare pasted code fence triggers a Go roundtrip that writes the canonical YAML to disk; a background AI job detects the language; the JS extension honours the detected language and declared mode if it has a registered renderer. Unknown languages stay as code blocks forever — no broken states.

This replaces the old `CodeBlockWithAttrs` info-string-attrs pattern. It also supersedes `spec-diagram-blocks.md`, which is now retired — mermaid is a renderer registered in this extension, not a separate block type.

---

## 2. The YAML Schema

````markdown
```code
id: cb-a3f9
language: mermaid
mode: CODE
status: COMPLETE
source: |
    graph TD
        A-->B
        A-->C
```
````

| Field | Values | Notes |
|-------|--------|-------|
| `id` | `cb-XXXX` (4 hex) | Same ID convention as other blocks |
| `language` | string or `unknown` | Set by AI detection; `unknown` while PENDING |
| `mode` | `CODE` \| `RENDER` \| renderer-specific | Current display mode; user-toggled, persisted on autosave |
| `status` | `PENDING` \| `COMPLETE` \| `ERROR` \| `TIMEOUT` | Detection job lifecycle |
| `source` | block scalar (4-space indent) | The raw code content |

Optional renderer-specific attrs (added by Go when language is detected):

| Field | Example | Purpose |
|-------|---------|---------|
| `theme` | `dark` | Renderer-specific theme |
| `server` | `https://plantuml.example.com` | For server-side renderers (PlantUML) |

Go owns the YAML. JS never generates or mutates YAML fields — the `mode` field is the one exception: it is updated via autosave carrying the TipTap attr change (user display preference, not job state).

---

## 3. User Experience

### 3.1 Paste flow

User pastes a bare fenced code block (` ```anything ... ``` `):

1. Paste handler detects the fence pattern
2. `flushSave()` → `POST /api/code/create` with `{ uuid, source, hint }` where `hint` is the language tag from the fence info string if present
3. Go writes a PENDING `code` YAML block to disk, starts background detection, returns `{ id, fence }`
4. JS inserts the fence at the paste position
5. Block immediately visible as a code block in `CODE` mode with a "Detecting language…" status indicator
6. AI detection completes → SSE fires → `softReloadContent` → block updates with detected language and mode toggle (if renderer registered)

If the `hint` is a known language Sieve can render, Go may skip the AI detection step and set the language directly.

### 3.2 Mode toggle

Once the language is known and a renderer is registered, a toggle appears:

- Click **Render** / `Ctrl+R` → `updateAttributes({ mode: 'RENDER' })` → NodeView re-renders immediately → autosave persists the new mode
- Click **Code** / `Ctrl+R` again → back to code view

No Go roundtrip on toggle — it is a display preference, persisted via the normal autosave path.

### 3.3 Fallback behaviour

If the extension has no renderer for the detected language, `mode` is ignored and the block always shows as `CODE`. The YAML is valid, the source is preserved, and the block is re-renderable if a renderer is added later.

---

## 4. Go Architecture

### 4.1 New handler: `CodeHandler`

`requesthandlers/code_handler.go` — follows the same structure as `AiHandler` and `InternalizeHandler`.

```go
type CodeHandler struct {
    ServiceProvider *sieve.ServiceProvider
    Broadcast       func(event, data string)
    JobTracker      *JobTracker
}
```

Registered in `handlers.go` alongside the existing handlers. Receives the shared `JobTracker` instance.

### 4.2 Routes

```
POST /api/code/create
```

Accepts `{ uuid, source, hint }`. Writes the initial PENDING `code` YAML block to disk via `ServiceProvider.Documents`, starts `runDetect` in a goroutine, returns `{ id, fence }`.

No `/api/code/active` endpoint — active jobs are served by the shared `GET /api/ai/active-jobs` (same `JobTracker`).

### 4.3 Background goroutine: `runDetect`

Follows the same pattern as `runAiBlock` and `runInBackground`:

```go
func (h *CodeHandler) runDetect(uuid, id, source, hint string) {
    h.emitJobStarted(id, "Detecting language...", uuid, false)

    language, err := h.ServiceProvider.AI.DetectCodeLanguage(source, hint)

    status := "COMPLETE"
    if err != nil { status = "TIMEOUT" or "ERROR" }

    // Go updates YAML on disk: sets language, status=COMPLETE
    h.ServiceProvider.Code.ResolveCodeBlock(uuid, id, language, status)

    payload, _ := json.Marshal(map[string]string{
        "uuid": uuid, "blkId": id, "language": language, "status": status,
    })
    h.Broadcast("code:block-resolved", string(payload))

    h.emitJobEnded(id, uuid)
}
```

`ai:job-started` / `ai:job-ended` are emitted via the shared `JobTracker` helpers — status bar and tab spinner work automatically.

### 4.4 AI Service method: `DetectCodeLanguage`

New method on `AIService`:

```go
func (s *AIService) DetectCodeLanguage(source, hint string) (string, error)
```

Prompt: passes the source content and asks Claude to identify the language. Returns a lowercase language identifier (`mermaid`, `python`, `sql`, etc.) or `unknown`. Uses the existing CLI integration with a short timeout.

If `hint` is a known language, the service may return it directly without a CLI call.

### 4.5 Code Service

New `CodeService` (or method on `DocumentService`) handles disk operations:

- `InsertCodeBlock(uuid, id, source, hint string) (fence string, err error)` — writes PENDING YAML fence to document
- `ResolveCodeBlock(uuid, id, language, status string) error` — updates the YAML on disk with detected language and status

Follows the same pattern as `InsertAiBlock`/`ResolveAiBlock` and `InsertWebClip`/`ResolveWebClip`.

### 4.6 Wire in `handlers.go`

```go
&requesthandlers.CodeHandler{
    ServiceProvider: sp,
    JobTracker:      tracker,   // shared instance
    Broadcast:       hub.broadcast,
},
```

---

## 5. JS Architecture

### 5.1 New file: `code-block-extension.js`

Loaded as `<script type="module">` in `index.html`. Imports from `fenced-block-base.js`:

```js
import { esc, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'
```

### 5.2 Renderer registry

The extension maintains a registry of language → renderer. Renderers are registered at module load:

```js
const renderers = {
  mermaid: {
    modes: ['CODE', 'RENDER'],
    render: renderMermaid,        // returns a DOM element
  },
  // plantuml: { modes: ['CODE', 'RENDER', 'SERVER'], render: renderPlantUML },
}
```

If `renderers[language]` is undefined: always show `CODE` mode regardless of the `mode` attr. No error, no indication to the user — it's just a code block.

### 5.3 TipTap Node

```js
name: 'codeBlock'   // or a new name to avoid clash with TipTap's built-in
group: 'block'
atom: true          // YAML-carrying blocks are atoms (like ai-block, web-clip)
draggable: true
```

Attributes: `id`, `language`, `mode`, `status`, `rawYaml`, plus renderer-specific attrs (`theme`, `server`).

Parse/serialize follow the fenced YAML pattern exactly (Rule 1 — `rawYaml` verbatim on serialize; soft reload on completion).

### 5.4 Paste interception

In `editor.js` paste handler, detect a bare fenced code block pattern:

```js
var fenceMatch = text.match(/^```(\w*)\n([\s\S]*?)\n```$/)
if (fenceMatch) {
  event.preventDefault()
  var hint = fenceMatch[1] || ''
  var source = fenceMatch[2]
  flushSave().then(function() {
    fetch('/api/code/create', {
      method: 'POST',
      body: JSON.stringify({ uuid: currentUuid, source: source, hint: hint })
    })
    .then(function(r) { return r.json() })
    .then(function(resp) {
      // Insert fence into TipTap at paste position
      // (same pattern as ai-block insertion)
    })
  })
  return true
}
```

### 5.5 SSE completion handler

```js
document.addEventListener('sse:code:block-resolved', function(e) {
  var data = JSON.parse(e.detail || '{}')
  if (data.uuid !== currentUuid) return
  softReloadContent(currentUuid)
})
```

Add relay div to `index.html`:
```html
<div id="code-sse-relay" hx-trigger="sse:code:block-resolved" style="display:none"></div>
```

### 5.6 `isStale` for PENDING detection

```js
function isStale(createdAt, id) {
  if (isJobActive(id)) return false
  return isStaleByTime(createdAt)
}
```

Standard pattern — free from `fenced-block-base.js`.

---

## 6. Renderer: Mermaid

Mermaid is the first registered renderer. Implementation notes:

- Vendor `mermaid.min.js` at `frontend/src/static/vendor/mermaid.min.js` (note: ~2 MB — confirm this is acceptable before pulling in)
- Load lazily on first RENDER request via dynamic script injection
- Initialize with CSS custom properties mapped to `themeVariables` (see §6.1)
- Re-initialize on `settings:changed`
- On parse error: show inline error message, stay in `CODE` mode

```js
async function renderMermaid(attrs, container) {
  await ensureMermaid()
  try {
    const { svg } = await window.mermaid.render('mg-' + attrs.id, attrs.source)
    container.innerHTML = svg
  } catch (err) {
    container.innerHTML = '<span class="code-block__error">Diagram error: ' + esc(err.message) + '</span>'
  }
}
```

### 6.1 Theme variables

```js
function buildMermaidTheme() {
  var s = getComputedStyle(document.documentElement)
  return {
    theme: 'base',
    themeVariables: {
      background:       s.getPropertyValue('--theme-bg').trim(),
      primaryColor:     s.getPropertyValue('--theme-bgAlt').trim(),
      primaryTextColor: s.getPropertyValue('--theme-text').trim(),
      lineColor:        s.getPropertyValue('--theme-muted').trim(),
    }
  }
}
```

---

## 7. Future Renderers

### PlantUML (server-side)

When `language: plantuml` and `mode: SERVER`, the extension encodes the source and requests a render from `attrs.server`. Go sets the `server` attr when resolving the block (configurable via settings).

### Other renderers

Any language can be added to the registry. The YAML schema accommodates arbitrary additional attrs — Go sets them on detection, JS reads them.

---

## 8. Implementation Roadmap

| Phase | Scope |
|-------|-------|
| **1** | Go: `CodeHandler`, `DetectCodeLanguage`, `InsertCodeBlock`/`ResolveCodeBlock`, SSE events, `JobTracker` wiring |
| **2** | JS: `code-block-extension.js` scaffold, paste interception, YAML parse/serialize, `CODE` mode NodeView, SSE handler |
| **3** | Mermaid renderer — vendor library, `RENDER` mode NodeView, mode toggle, theme integration |
| **4** | Resize handle, mode persistence via autosave |

---

## 9. Relationship to Other Specs

- `spec-diagram-blocks.md` — **retired**. Mermaid is a renderer within this spec, not a separate block type.
- `how-to-intelligent-fenced-blocks.md` — this block follows all existing rules. Notable: `rawYaml` verbatim serialisation (Rule 1), `flushSave()` wrapping (Rule 1 corollary), `isJobActive` for stale detection (Rule 7), `sieve:contextmenu` for context menu (Rule 12).
