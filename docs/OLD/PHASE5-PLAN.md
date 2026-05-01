# Phase 5 Implementation Plan — Editor Island

## Current State (broken)
Commit `e8a8563` on `feature/htmx-migration` is broken. The editor shows no content.

## What Was Correct in That Commit (KEEP)
- `frontend/src/extensions/AiBlock.tsx` — ReactNodeViewRenderer removed, vanilla NodeView added
- `frontend/src/extensions/CodeBlockWithAttrs.ts` — ReactNodeViewRenderer removed, vanilla NodeView added
- `frontend/src/extensions/ImageWithAttrs.ts` — ReactNodeViewRenderer removed, vanilla NodeView added
- `frontend/src/extensions/ImageNodeView.tsx` — stripped to just the `resolveDisplaySrc` export
- `docs/TECH-DEBT.md` — 4-A and 4-B retired

## What Was Wrong (FIX FIRST)

### Step 1: Delete SieveEditor.ts
```
rm frontend/src/editor/SieveEditor.ts
rmdir frontend/src/editor   # if empty
```

### Step 2: Restore App.tsx to Phase 4 state
```
git checkout 9a08960 -- frontend/src/App.tsx
```
This brings back `<EditorPanel>` render block, `editorRefs`, all the working wiring.

### Step 3: Restore EditorStats.tsx to Phase 4 state
```
git checkout 9a08960 -- frontend/src/components/EditorStats.tsx
```
This restores the component that reads from the TipTap editor instance.

### Step 4: Verify TypeScript compiles clean
```
nix-shell -p nodejs --run "cd frontend && node ./node_modules/.bin/tsc --noEmit"
```

### Step 5: Commit the fix
```
git add -A
git commit -m "Fix Phase 5: restore working App.tsx/EditorStats, keep correct NodeView changes"
git push
```

---

## Phase 5 Proper Implementation

### Architecture (same pattern as sidebar/meta panel/tabs)

Tab changes → `htmx.ajax('GET', '/api/editor?uuid=...')` → Go renders `editor.html` → HTMX swaps into `#htmx-editor` div → `htmx:afterSettle` fires → `editor.js` sees `#tiptap-mount` → calls `new Editor(...)` → fetches body from `/api/editor/load?uuid=...` → sets content → autosaves via `POST /api/editor/save?uuid=...`

---

### File 1: `requesthandlers/editor_handler.go` (NEW)

```go
package requesthandlers

import (
    "encoding/json"
    "html/template"
    "net/http"

    "sieve/sieve"

    "github.com/go-chi/chi/v5"
)

type EditorHandler struct {
    Buffers **sieve.BufferService
    Notes   **sieve.NoteService
    Tmpl    *template.Template
}

type editorShellData struct {
    UUID string
    Mode string
}

func (h *EditorHandler) RegisterPaths(r chi.Router) {
    r.Get("/api/editor", h.handleEditorShell)
    r.Get("/api/editor/load", h.handleEditorLoad)
    r.Post("/api/editor/save", h.handleEditorSave)
}

// GET /api/editor?uuid=... — returns the editor HTML shell
func (h *EditorHandler) handleEditorShell(w http.ResponseWriter, r *http.Request) {
    uuid := r.URL.Query().Get("uuid")
    mode := r.URL.Query().Get("mode")
    if mode == "" {
        mode = "wysiwyg"
    }
    w.Header().Set("Cache-Control", "no-store")
    w.Header().Set("Content-Type", "text/html; charset=utf-8")
    data := editorShellData{UUID: uuid, Mode: mode}
    if err := h.Tmpl.ExecuteTemplate(w, "editor.html", data); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
    }
}

// GET /api/editor/load?uuid=... — returns {body, mode, path} as JSON
func (h *EditorHandler) handleEditorLoad(w http.ResponseWriter, r *http.Request) {
    uuid := r.URL.Query().Get("uuid")
    w.Header().Set("Cache-Control", "no-store")
    w.Header().Set("Content-Type", "application/json")

    type loadResponse struct {
        Body string `json:"body"`
        Mode string `json:"mode"`
        Path string `json:"path"`
    }

    buffers := *h.Buffers
    notes   := *h.Notes

    if buffers != nil {
        if b, err := buffers.LoadByUUID(uuid); err == nil {
            resp := loadResponse{Body: string(b.Body()), Path: b.Path()}
            if b.Meta().Mode() == "markdown" {
                resp.Mode = "markdown"
            } else {
                resp.Mode = "wysiwyg"
            }
            json.NewEncoder(w).Encode(resp)
            return
        }
    }
    if notes != nil {
        if n, err := notes.LoadByUUID(uuid); err == nil {
            resp := loadResponse{Body: string(n.Body()), Path: n.Path()}
            if n.Meta().Mode() == "markdown" {
                resp.Mode = "markdown"
            } else {
                resp.Mode = "wysiwyg"
            }
            json.NewEncoder(w).Encode(resp)
            return
        }
    }

    http.Error(w, "not found", http.StatusNotFound)
}

// POST /api/editor/save?uuid=... — saves document body, returns {version}
func (h *EditorHandler) handleEditorSave(w http.ResponseWriter, r *http.Request) {
    uuid := r.URL.Query().Get("uuid")
    w.Header().Set("Cache-Control", "no-store")
    w.Header().Set("Content-Type", "application/json")

    var req struct {
        Body string `json:"body"`
    }
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    buffers := *h.Buffers
    notes   := *h.Notes

    if buffers != nil {
        if b, err := buffers.LoadByUUID(uuid); err == nil {
            b.SetBody([]byte(req.Body))
            if err := buffers.Save(b); err == nil {
                w.WriteHeader(http.StatusOK)
                json.NewEncoder(w).Encode(map[string]int{"version": b.Meta().Version()})
                return
            }
        }
    }
    if notes != nil {
        if n, err := notes.LoadByUUID(uuid); err == nil {
            n.SetBody([]byte(req.Body))
            if err := notes.Save(n); err == nil {
                w.WriteHeader(http.StatusOK)
                json.NewEncoder(w).Encode(map[string]int{"version": n.Meta().Version()})
                return
            }
        }
    }

    http.Error(w, "save failed", http.StatusInternalServerError)
}
```

**Note:** Check the actual method names on BufferService/NoteService — use the same patterns as `meta_handler.go`. The key methods needed are:
- `LoadByUUID(uuid)` — already used in meta_handler.go ✓
- `b.Body()` or `b.Storable().Body()` — check existing code
- `b.SetBody([]byte)` — check existing code  
- `buffers.Save(b)` — check existing code
- `b.Meta().Version()` — already used in meta_handler.go ✓
- `b.Meta().Mode()` — check if this exists, might be stored differently

---

### File 2: `ui/templates/editor.html` (NEW)

```html
{{define "editor.html"}}
<div
  id="tiptap-mount"
  class="editor-panel"
  data-uuid="{{.UUID}}"
  data-mode="{{.Mode}}"
  style="flex:1;min-height:0;height:100%;display:flex;flex-direction:column"
></div>
{{end}}
```

That's it. Minimal. The JS does the rest.

---

### File 3: `frontend/src/editor/editor.ts` (NEW — replaces EditorPanel.tsx)

This is vanilla TypeScript (no React, no JSX). It compiles into the Vite bundle.

Key structure:
```typescript
import { Editor } from '@tiptap/core'
// ... all extension imports (same as EditorPanel.tsx)
// NO import from '@tiptap/react'

let currentEditor: Editor | null = null
let currentUuid = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
const AUTOSAVE_MS = 30_000

export function initEditor(mountEl: HTMLElement, uuid: string, mode: string) {
    // Destroy previous editor if switching tabs
    if (currentEditor) {
        flushSave()
        currentEditor.destroy()
        currentEditor = null
    }

    currentUuid = uuid

    // Fetch document body from Go
    fetch(`/api/editor/load?uuid=${encodeURIComponent(uuid)}`)
        .then(r => r.json())
        .then(({ body, mode: docMode, path }) => {
            // Update global for image src resolution
            ;(window as any).__stashActiveTabPath = path

            if (docMode === 'markdown' || uuid.startsWith('prompt:')) {
                mountMarkdownEditor(mountEl, uuid, body)
            } else {
                mountWysiwygEditor(mountEl, uuid, body)
            }
        })
}

function mountWysiwygEditor(el: HTMLElement, uuid: string, body: string) {
    const editor = new Editor({
        element: el,
        extensions: [
            // all the same extensions as EditorPanel.tsx
            // AiBlock, CodeBlockWithAttrs, ImageWithAttrs, etc.
            // AiShortcuts.configure({
            //   onExplain: () => runAiJob('explain', editor, uuid),
            //   onAsk: () => openAskDialog(editor, uuid),
            //   ...
            // })
        ],
        content: body,
        onUpdate: ({ editor }) => {
            const md = editor.storage.markdown.getMarkdown()
            scheduleSave(uuid, md)
            document.dispatchEvent(new CustomEvent('editor:changed'))
            dispatchStats(editor)
        },
    })
    currentEditor = editor
}

function mountMarkdownEditor(el: HTMLElement, uuid: string, body: string) {
    // Build markdown textarea + gutter (same HTML as MarkdownEditor.tsx)
    // wire onChange to scheduleSave
}

function scheduleSave(uuid: string, body: string) {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
        fetch(`/api/editor/save?uuid=${encodeURIComponent(uuid)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body })
        }).then(() => {
            document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid } }))
        })
    }, AUTOSAVE_MS)
}

function flushSave() {
    // immediate save before tab switch
}
```

**AI job orchestration:** Copy `runAiJob()` logic from `EditorPanel.tsx` — it's pure logic, just change the React state calls (`setRawMd`, `setShowAskPopup`) to DOM manipulation.

**Ask popup:** Native `<dialog>` element appended to body. Same pattern as I had in SieveEditor.ts.

**Link bubble menu:** Vanilla positioned div. Same pattern as I had in SieveEditor.ts.

**Paste handling:** Import and call `EditorPasteService` directly — it's already vanilla TS.

---

### File 4: App.tsx changes (minimal)

Remove `<EditorPanel>` render block. Replace with:
```tsx
<div
  id="htmx-editor"
  className="editor-wrapper"
  style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
/>
```

On tab change, add to the `selectTab` / `openDoc` flow:
```tsx
const loadEditor = (uuid: string, mode: string) => {
  const htmx = (window as any).htmx
  const el = document.getElementById('htmx-editor')
  if (htmx && el && uuid) {
    htmx.ajax('GET', `/api/editor?uuid=${encodeURIComponent(uuid)}&mode=${mode}`, {
      target: el,
      swap: 'innerHTML'
    })
  }
}
```

In `htmx:afterSettle` handler, add:
```tsx
} else if (target.id === 'tiptap-mount') {
  const uuid = target.getAttribute('data-uuid') ?? ''
  const mode = target.getAttribute('data-mode') ?? 'wysiwyg'
  import('./editor/editor').then(m => m.initEditor(target, uuid, mode))
}
```

**EditorStats:** Listen for `editor:stats` CustomEvent dispatched by editor.ts, update React state.

**Search:** `window.sieveEditor.setSearchTerm(val)` → expose the editor instance on window.

---

### File 5: `handlers.go` changes

Register the new handler:
```go
&requesthandlers.EditorHandler{Buffers: &app.buffers, Notes: &app.notes, Tmpl: tmpl},
```

---

### What gets deleted after Phase 5 works
- `frontend/src/components/EditorPanel.tsx`
- `frontend/src/components/Editor/MarkdownEditor.tsx`
- `frontend/src/components/Editor/LinkBubbleMenu.tsx`
- `frontend/src/components/AskPopup.tsx`
- `frontend/src/lib/EditorPasteService.ts` (logic folded into editor.ts)

---

## Key things to check in Go before writing the handler

Look at `sieve/buffer_service.go` and `sieve/note_service.go` for:
- How to get body: `b.Body()` returns `[]byte`? or `b.Storable().Body()`?
- How to set body: `b.SetBody([]byte)`? 
- How to save: `buffers.Save(b)` — check signature
- Does `DocumentMeta` have a `Mode()` method? Check `sieve/meta.go`

Also check how `LoadByUUID` is implemented — already used in `meta_handler.go` so it definitely works.

## Order of implementation
1. Fix current broken state (restore App.tsx + EditorStats, delete SieveEditor.ts)
2. Check Go method signatures (read sieve/buffer_service.go, sieve/note_service.go, sieve/meta.go)
3. Write editor_handler.go
4. Write editor.html template
5. Write frontend/src/editor/editor.ts
6. Update App.tsx (minimal changes)
7. Update handlers.go
8. Test: open app, switch tabs, edit, verify save works
9. Delete old React editor files
