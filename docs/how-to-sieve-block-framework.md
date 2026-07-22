> **STALE — DO NOT FOLLOW (2026-07-20).** This document predates both the
> 2026-06-20 Go package split (`sieve/` → `sieve/block/processors/`, job-engine
> `BlockProcessor` interface) and the 2026-07-20 renderer/NodeView split
> (epic #43). For the current contract see `docs/how-to-intelligent-fenced-blocks.md`
> and `sieve/block/processor_registry.go`. Retained as historical reference;
> Go-side rewrite is a pending follow-up.

# How to Build a Sieve Block

The Sieve Block Framework is the standard way to embed rich, async-capable blocks into the Sieve editor. A block is a fenced YAML node in the Markdown document, rendered by a custom TipTap NodeView, and optionally backed by a background Go job.

Two canonical examples ship with the codebase. **Read these files before writing new code:**

| Block | Kind | Go processor | JS renderer |
|-------|------|-------------|-------------|
| Code | `code` | `sieve/code_processor.go` | `frontend/src/static/code-renderer.js` |
| Web Clip | `web-clip` | `sieve/web_clip_processor.go` | `frontend/src/static/web-clip-renderer.js` |

These are the two poles. Every new block kind falls somewhere between them.

For anything the framework cannot handle (custom serialisation, non-YAML content, bespoke TipTap node types) see `docs/how-to-intelligent-fenced-blocks.md`.

---

## Part 1 — Tutorial: The Two Worked Examples

### What happens when a web-clip block is created

1. User presses Cmd+Shift+W → dialog → picks URL and mode → `editor.js` sends WS message `{ type: 'create-block', kind: 'web-clip', attrs: { source, mode } }`
2. `WsHandler.handleCreateBlock` (`requesthandlers/ws_handler.go`) → `EditorService.CreateBlock("web-clip", attrs)`
3. `CreateBlock` calls `WebClipBlockProcessor.InitAttrs` → builds the initial YAML map (`status: PENDING`, `source`, `mode`, …) → serialises with `fencedblock.Serialize` → sends `insert-block` WS message back to JS
4. JS receives `insert-block` → inserts a `sieve-web-clip` TipTap node; NodeView renders a spinner
5. `CreateBlock` calls `DispatchJobIfNeeded` → status transitions to `DISPATCHED` → `notifyBlockUpdated` sends `block-attrs-updated` WS → NodeView re-renders (still spinner, now tracked by active-job set)
6. `go RunJob(...)` starts in background → calls `WebClipBlockProcessor.RunJob` → invokes Claude CLI → writes result attrs onto `block` in-place
7. On completion: `flushShadow("job-complete")` saves canonical YAML to disk; `notifyBlockUpdated` sends final `block-attrs-updated` WS → NodeView renders fetched content

### What happens when a code block is created

Steps 1–4 are identical (`kind: 'code'`, no `source`). The difference is in `CodeBlockProcessor`:

- `OnChange` is called synchronously after every `block-update` WS message (user types in the textarea) — it updates `status` and can trigger re-detection of the language
- `RunJob` calls `AIService.DetectCodeLanguage` — a fast operation that completes in seconds
- There is no long-running fetch; the block content is always in the user's hands

### Key structural difference between the two

All sieve blocks have `atom: true` at the ProseMirror schema level — the NodeView is always treated as a single unit. The difference that makes the code block editable is in `selectable` and the NodeView's DOM, not `atom`:

```
Code block                          Web-clip block
──────────────────────────────────  ────────────────────────────────
atom: true                          atom: true
selectable: false                   selectable: true
draggable: false                    draggable: false
NodeView has a <textarea> child     NodeView is display-only
OnChange → re-run heuristics        OnChange → no-op
RunJob → language detection         RunJob → fetch/summarise URL
```

`selectable: false` is what prevents TipTap from creating a NodeSelection on click — allowing the mouse to select text inside the textarea instead. It is not the same as `atom`.

---

## Part 2 — Building a New Block

The minimum surface is **one Go file** and **one JS file**, plus two one-line registrations.

### Step 1 — Go: implement `BlockProcessor`

Create `sieve/<kind>_processor.go`. Copy `sieve/web_clip_processor.go` as the starting point for display-only async blocks, or `sieve/code_processor.go` for editable blocks.

```go
package sieve

import (
    "context"
    "time"
)

type MyBlockProcessor struct{}

// InitAttrs declares the schema. Every field at its zero value, overridden by
// whatever the creation trigger supplied. Called by CreateBlock regardless of
// how the block was created.
//
// REQUIRED: always include "id", "status": BlockStatusPending, "createdAt".
// Omitting "createdAt" causes isJobStale to return true immediately — the block
// will show "interrupted" before the job even starts.
func (p *MyBlockProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
    attrs := map[string]interface{}{
        "id":        id,
        "status":    BlockStatusPending,
        "createdAt": time.Now().UTC().Format(time.RFC3339),
        // declare every field your renderer uses, at its zero value:
        "myField":   "",
        "error":     "",
    }
    for k, v := range overrides {
        if k == "id" { continue }  // never allow callers to override the id
        attrs[k] = v
    }
    return attrs
}

// PasteMatch returns true if pasted clipboard content should become this block kind.
// Return false, nil if this block is only created explicitly (keyboard shortcut / dialog).
func (p *MyBlockProcessor) PasteMatch(entries []PasteEntry) (bool, map[string]interface{}) {
    return false, nil
}

// OnChange is called synchronously after any user-driven attr mutation.
// Mutate block.Attrs in-place. Set status = BlockStatusPending to queue an async job.
func (p *MyBlockProcessor) OnChange(block *SieveBlock, svc Services) {}

// BuildContext returns the plain-text content of this block for use as AI context.
func (p *MyBlockProcessor) BuildContext(block SieveBlock, _ ShadowDocument) string {
    content, _ := block.Attrs["myField"].(string)
    return content
}

// JobLabel returns the status-bar label shown while the job runs.
// Return "" to skip job tracking entirely (no spinner in status bar).
func (p *MyBlockProcessor) JobLabel(block *SieveBlock) string {
    return "Processing…"
}

// RunJob does the background work. Mutate block.Attrs in-place with the result.
// Return a non-nil error to set status = ERROR automatically.
// uuid is the document UUID — use it to load document context if needed.
func (p *MyBlockProcessor) RunJob(ctx context.Context, uuid string, block *SieveBlock, svc Services) error {
    // ... do work using svc.AI, svc.Documents, etc. ...
    block.Attrs["status"]      = BlockStatusComplete
    block.Attrs["completedAt"] = time.Now().UTC().Format(time.RFC3339)
    block.Attrs["myField"]     = "result"
    return nil
}
```

**Register** in `sieve/service_provider.go`. Find the existing `RegisterProcessor` calls (grep for `RegisterProcessor`) and add yours alongside them:

```go
RegisterProcessor("my-block", &MyBlockProcessor{})
```

The existing registrations look like:
```go
RegisterProcessor("code",     &CodeBlockProcessor{})
RegisterProcessor("web-clip", &WebClipBlockProcessor{})
```

### Step 2 — JS: implement the Renderer

Create `frontend/src/static/my-block-renderer.js`. Copy `web-clip-renderer.js` as the starting point for display-only async blocks, or `code-renderer.js` for editable blocks. The key things to change are marked with `← CHANGE`:

```js
import { renderMarkdown, applyHighlighting, isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'
  var T = window.TipTap

  var MyBlockRenderer = {

    // nodeConfig: ProseMirror schema overrides.
    // Display-only (async job): atom: true, selectable: true, draggable: false
    // Editable (user types):    atom: true, selectable: false, draggable: false
    // Never set atom: false — all sieve blocks are atomic at the schema level.
    nodeConfig: { atom: true, selectable: true, draggable: false },

    // attrs: kind-specific TipTap attributes. Merged with the five base attrs
    // every sieve block shares: kind, id, rawYaml, status, createdAt.
    // Each entry MUST have a default and a parseHTML that reads from a data-* attribute.
    // The data-* attribute name is the camelCase key converted to kebab-case by the factory.
    attrs: {
      myField: { default: null, parseHTML: function (el) { return el.getAttribute('data-my-field') || null } },
      error:   { default: null, parseHTML: function (el) { return el.getAttribute('data-error')    || null } },
    },

    // parseAttrs: called by the fence parser with the parsed YAML object.
    // MUST return the same keys as attrs above — if a key is here but not in attrs,
    // it is written to the HTML element but never read back into TipTap state.
    parseAttrs: function (data) {
      return {
        myField: data.myField || null,   // ← CHANGE: match your YAML field names
        error:   data.error   || null,
      }
    },

    // makeNodeView: returns a TipTap NodeView.
    // editor is the live TipTap instance — use it for renderMarkdown and editor.commands.
    makeNodeView: function (node, editor) {
      var dom = document.createElement('div')
      dom.className = 'my-block'           // ← CHANGE: your CSS class
      dom.contentEditable = 'false'
      dom.setAttribute('data-my-block-id', node.attrs.id || '')  // ← CHANGE: set a unique data attr for chain highlighting

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-my-block-id', n.attrs.id || '')  // ← re-set on every render (render() clears innerHTML but not the element's own attributes — re-setting is belt-and-braces for chain highlighting)
        var status = n.attrs.status || 'PENDING'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          // Show spinner or loading state
          dom.textContent = 'Loading…'
        } else if (status === 'COMPLETE') {
          var contentEl = document.createElement('div')
          contentEl.innerHTML = renderMarkdown(n.attrs.myField || '', editor)
          applyHighlighting(contentEl)   // ALWAYS call this after setting innerHTML
          dom.appendChild(contentEl)
        } else {
          // ERROR or TIMEOUT
          var errMsg = (n.attrs.error || 'Unknown error').trim()
          dom.textContent = errMsg
        }
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        // update MUST return false if the node type is wrong.
        // The type name is always 'sieve-' + kind — 'sieve-my-block' here.  ← CHANGE
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-my-block') return false  // ← CHANGE
          render(updatedNode)
          return true
        },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
      }
    },

    buildContextMenuItems: function ({ node, editor, getPos }) {
      var IC = window.SieveIcons || {}

      function del() {
        if (typeof getPos === 'function') {  // always guard getPos
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      var status = node.attrs.status || 'PENDING'
      var isComplete = status === 'COMPLETE'

      var items = [
        { type: 'header', label: 'My Block' },   // ← CHANGE
        { icon: IC.copy,  label: 'Copy',   action: function () { /* ... */ } },
        { icon: IC.trash, label: 'Delete', action: del },
      ]

      // For Ask AI / Explain: build a human-readable summary as precomputedCtx.
      // Pass content: a prose summary (not raw YAML). See webClipSummary in web-clip-renderer.js.
      if (isComplete && node.attrs.myField) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          var ctx = { content: node.attrs.myField || '', history: '', blockRef: node.attrs.id, imageIds: [], contextLabel: 'My Block' }
          document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
        }})
      }

      return items
    },
  }

  T.registerSieveRenderer('my-block', MyBlockRenderer)  // ← CHANGE kind string
})()
```

**Register** in `frontend/src/index.html`. Find the existing renderer script tags (grep for `sieve-renderer`) and add yours after them:

```html
<!-- existing lines look like: -->
<script type="module" src="/static/code-renderer.js"></script>
<script type="module" src="/static/web-clip-renderer.js"></script>
<!-- add: -->
<script type="module" src="/static/my-block-renderer.js"></script>
```

### Step 3 — Wire the creation trigger

Send `create-block` over the WS. `EditorService` manages all system-level saves — JS does not need to flush before creation. Add a trigger in `editor.js` (keyboard shortcut, menu item, dialog submit):

```js
wsSend({ type: 'create-block', kind: 'my-block', attrs: { /* overrides */ }, uuid: currentUuid })
```

From outside `editor.js` (a renderer file, a toolbar component), dispatch the `sieve:create-block` event instead — the listener in `editor.js` handles the WS send:

```js
document.dispatchEvent(new CustomEvent('sieve:create-block', {
    detail: { kind: 'my-block', attrs: { /* overrides */ } }
}))
```

### Step 4 — Verify

```bash
go build -tags webkit2_41 ./...   # must compile clean
go test -tags webkit2_41 ./sieve/... -v   # processor tests
wails dev                         # smoke test in browser
```

---

## Part 3 — Reference

### The `BlockProcessor` interface

All six methods must be implemented. The framework calls them; you do not call them directly.

| Method | Called when | Contract |
|--------|-------------|----------|
| `InitAttrs(id, overrides)` | `CreateBlock` or `HandlePaste` | Return the **complete** initial attrs map — every field at its zero value, overridden by `overrides`. Never write to the `id` key from overrides. Always include `"id"`, `"status": BlockStatusPending`, `"createdAt"`. |
| `PasteMatch(entries)` | User pastes into editor | Return `(true, overrides)` if clipboard content should become this block. Return `(false, nil)` otherwise. |
| `OnChange(block, svc)` | After any `block-update` WS message | Mutate `block.Attrs` in-place synchronously. Set `status = BlockStatusPending` to queue a job. |
| `BuildContext(block, doc)` | When building AI context for Ask/Explain | Return plain-text or markdown prose — not raw YAML. |
| `JobLabel(block)` | When a job is about to start | Return the status-bar label string (e.g. `"Fetching example.com"`). Return `""` to skip tracking. |
| `RunJob(ctx, uuid, block, svc)` | In a goroutine, after status → DISPATCHED | Mutate `block.Attrs` in-place with the result. Return `error` to set `status = ERROR` automatically. |

`fencedblock.Serialize` and `GenerateBlockID` are called by the framework automatically — only use them in tests.

### The Renderer interface

| Field | Type | Purpose |
|-------|------|---------|
| `nodeConfig` | `{ atom, selectable, draggable }` | Schema-level config. Fixed at editor init. **All sieve blocks use `atom: true`.** Display-only: also `selectable: true`. Editable: `selectable: false, draggable: false`. |
| `attrs` | TipTap attrs map | Kind-specific attrs. Merged with base attrs (`kind`, `id`, `rawYaml`, `status`, `createdAt`). Each entry needs a `default` and a `parseHTML` reading from a `data-*` attribute. |
| `parseAttrs(data)` | `data` → object | Called by the fence parser with the parsed YAML. Returns a flat object. **Keys must match `attrs` exactly** — extra keys in `parseAttrs` are silently dropped. |
| `makeNodeView(node, editor)` | NodeView factory | Returns `{ dom, contentDOM, update, ignoreMutation, stopEvent }`. `contentDOM: null` for display-only. `update` must return `false` for wrong type names. |
| `buildContextMenuItems({ node, editor, getPos })` | Items factory | Returns item array. Called at right-click time with the live node. Always guard `getPos` calls with `typeof getPos === 'function'`. |

### The block lifecycle

```
User action
    │
    ▼
flushSave()  ← JS always saves before creating a block
    │
    ▼
WS: create-block { kind, attrs }
    │
    ▼
EditorService.CreateBlock                          sieve/editor_service.go
    ├── processor.InitAttrs        → attrs map
    ├── shadow.setBlock            → registered in shadow
    ├── fencedblock.Serialize      → rawYaml string
    ├── notifyBlockCreated         → WS: insert-block  → JS inserts node
    └── DispatchJobIfNeeded
            ├── status → DISPATCHED
            ├── fencedblock.Serialize      → rawYaml
            ├── notifyBlockUpdated → WS: block-attrs-updated → NodeView re-renders
            ├── flushShadow        → disk: DISPATCHED state saved
            └── go RunJob(...)
                    ├── processor.JobLabel → JobTracker.Start → SSE: ai:job-started
                    ├── processor.RunJob   → mutates block.Attrs in-place
                    ├── shadow.setBlock    → merges results into shadow
                    ├── flushShadow        → disk: COMPLETE state saved
                    ├── notifyBlockUpdated → WS: block-attrs-updated → NodeView re-renders
                    └── JobTracker.End     → SSE: ai:job-ended
```

**Retry:** WS `retry-block-job { id }` → `DispatchJobIfNeeded` (same from dispatch step; no new block created).

**Tab closed during job:** `Close(uuid)` removes the shadow from the map but `RunJob` holds the pointer. `flushShadow(shadow, "job-complete")` saves directly via that pointer — results are never lost even if the WS channel is gone.

### Silent failure modes

These mistakes produce no error but wrong behaviour. Check them before debugging anything else.

| Mistake | Symptom |
|---------|---------|
| `update()` returns `true` for any node type, or wrong type name string | NodeView never re-renders after `block-attrs-updated` |
| `parseAttrs` key not in `attrs` | Attr written to HTML element but never read into TipTap state; `node.attrs.X` is always `null` |
| `attrs` key not in `parseAttrs` | Attr is `null` on first load (parsed from Markdown), then correct after WS update — flickers |
| `applyHighlighting` not called after `innerHTML =` | Content renders but `sieve-rendered-content` class missing; code blocks have no gutter or colours |
| `atom: false` in `nodeConfig` | Cursor can enter the block; Backspace may delete content character-by-character instead of the whole node |
| Missing `"createdAt"` in `InitAttrs` | `isJobStale` returns `true` immediately; block shows "interrupted" before the job starts |
| `getPos()` called without `typeof getPos === 'function'` guard | Crash in edge cases (e.g. block in a not-yet-resolved selection) |
| `contentDOM` set to a DOM element instead of `null` for a display-only block | TipTap tries to manage content inside the NodeView; cursor and selection behaviour breaks |

### Rules

**Rule 1 — Go owns all YAML.**
`fencedblock.Serialize` is the only YAML generator. JS parses YAML (via `js-yaml`) to extract attrs; it never constructs YAML strings. The markdown serialiser replays `node.attrs.rawYaml` verbatim — never regenerates it.

**Rule 2 — JS does not manage system flushes.**
`EditorService` owns all system-level saves: `DispatchJobIfNeeded` flushes to disk before the job goroutine starts; `RunJob` flushes again on completion. JS calls `flushSave()` only for an explicit user save (Cmd+S). Do not add `flushSave()` wrappers around `create-block` or other block operations — they are redundant and were a pattern from the old HTTP-handler architecture.

**Rule 3 — Extensions must be non-destructive.**
If YAML fails to parse or `id` is missing, the fence hook falls through to `defaultFence` — leaving the original `<pre>` block intact. Never replace content with nothing. Never throw into the renderer.

**Rule 4 — Use `fencedblock.Serialize` — never hand-roll YAML.**
`fencedblock.Serialize` uses `yaml.NewEncoder` with `SetIndent(4)` and forces literal block style on multiline strings. This prevents inner ` ``` ` lines from closing the outer fence. Any alternative will have edge-case gaps.

**Rule 5 — ID format: `xx-YYYY` (two-char kind prefix + 4 hex chars).**
`GenerateBlockID("web-clip")` → `"we-a3f9"`. Short IDs stay readable in YAML; 4 hex chars are unique within a document. Do not use longer IDs.

**Rule 6 — Retry reuses the existing block ID.**
`sieve:block-retry` sends the existing `id` over WS. `DispatchJobIfNeeded` resets status and re-runs the job on the existing block. No new block is inserted.

**Rule 7 — Active-job tracking is automatic.**
`JobTracker.Start/End` (called by `EditorService.RunJob`) broadcast `ai:job-started` / `ai:job-ended` SSE. `fenced-block-base.js` maintains the active-job set. Import `isJobStale(createdAt, id)` — it checks the active set before falling back to time-based staleness. Do not manage your own set.

**Rule 8 — `applyHighlighting` after every `innerHTML =`.**
After `el.innerHTML = renderMarkdown(text, editor)`, always call `applyHighlighting(el)`. It adds the `sieve-rendered-content` class, wraps `<pre><code>` blocks in the gutter layout, and applies syntax colours. `renderMarkdown` always runs on the SANCTIONED dedicated markdown-it instance (html:false), never the editor's own (html:true) one — see `block/renderers/sanctioned-markdown.js` (DEFECT SEC-B, issue #48). A renderer that extends `BlockRenderer` gets this for free via `fillTitle(el, text)` / `fillBody(el, markdown)`, which already call `applyHighlighting` internally.

**Rule 9 — AI context is human-readable prose, not raw YAML.**
When dispatching `sieve:ai-ask` or `sieve:ai-explain` from `buildContextMenuItems`, pass a `precomputedCtx` with `content` set to a formatted prose summary — title, source, body text. Not the raw YAML fence. See `webClipSummary` in `web-clip-renderer.js` as the canonical pattern.

**Rule 10 — `buildContextMenuItems` receives the live node.**
The factory calls `buildContextMenuItems` with `editor.state.doc.nodeAt(getPos())` at right-click time — the node's current state, not the state at NodeView creation. Close over this `node` in action callbacks.

### Checklist for a new block kind

**Go**
- [ ] `sieve/<kind>_processor.go` — all six `BlockProcessor` methods implemented
- [ ] `InitAttrs` includes `"id"`, `"status": BlockStatusPending`, `"createdAt"`, and every field the renderer will read
- [ ] `RunJob` mutates `block.Attrs` in-place; returns error on failure
- [ ] `JobLabel` returns non-empty string if job should appear in status bar
- [ ] `RegisterProcessor("kind", &KindProcessor{})` added to `sieve/service_provider.go` alongside existing registrations
- [ ] `go build -tags webkit2_41 ./...` compiles clean

**JS**
- [ ] `frontend/src/static/<kind>-renderer.js` — loaded as `type="module"` in `index.html` alongside other renderer scripts
- [ ] `nodeConfig.atom` is `true`; editable blocks add `selectable: false, draggable: false`
- [ ] `attrs` map and `parseAttrs` return **the same set of keys**
- [ ] `makeNodeView(node, editor)` — `update()` checks `updatedNode.type.name !== 'sieve-<kind>'`
- [ ] `renderMarkdown(text, editor)` immediately followed by `applyHighlighting(el)`
- [ ] `dom` element has a unique `data-<kind>-id` attribute set on creation and re-set in every `render()` call
- [ ] `isJobStale(createdAt, id)` used for staleness checks; no manual job Set management
- [ ] `buildContextMenuItems` guards `getPos` calls; dispatches AI actions with `precomputedCtx`
- [ ] `T.registerSieveRenderer('kind', Renderer)` at bottom of file — kind string matches Go registration exactly
