# Plan: AI Block — Full Alignment with Intelligent Fenced Block Rules (X-C + X-D)

## Context

The AI block pre-dates the pattern formalised during web-clip development. It violates two architectural rules:
- **X-C (Rule 1):** JS generates YAML (`serializeAiBlockYaml`) and inserts PENDING blocks directly into TipTap without a Go roundtrip. Go and JS have parallel serialisers that can drift.
- **X-D (Rule 7):** No server-side active-job tracking. A PENDING ai-block after a page reload shows "thinking…" indefinitely — no stale/retry detection.

Additionally (completing fixes started earlier):
- **Rule 3:** `SerializeYAML` in Go uses 2-space indent for multiline `question` — must be 4-space.
- **Rule 4:** Single-line `question` in Go's `SerializeYAML` is not quoted — must go through `yamlScalar`.
- **Rule 8:** SSE completion uses in-place TipTap patch + `doSave` rather than `softReloadContent`.

The fix establishes the same pattern as web-clip across all three layers.

---

## Files to Modify

| File | What changes |
|------|-------------|
| `sieve/aiblock/block.go` | Fix `SerializeYAML` (indent + quoting); add `InsertAfterRef` |
| `requesthandlers/ai_handler.go` | Async handlers returning `{id,fence}`; `activeJobs` sync.Map; `GET /api/ai/active` |
| `frontend/src/static/ai-block-extension.js` | fence-hook parser; `rawYaml` attr; `isStale`; stale render branch |
| `frontend/src/static/editor.js` | `runAiJob` rewrite; SSE handler → softReload; `initEditor` parallel fetch; `__sieveActiveAiBlocks` |

---

## Step 1 — Fix `sieve/aiblock/block.go`

### 1a. Fix `SerializeYAML`
- Multiline `question`: change 2-space to **4-space** indent (inner fence safety, Rule 3).
- Single-line `question`: add a `yamlScalar()` helper (same logic as `sieve/webclip/webclip.go`) and apply it. Quotes values containing `: # { } [ ] | > & * ! ,` or leading/trailing space.
- Apply `yamlScalar()` to `Model` defensively.

### 1b. Add `InsertAfterRef(body, ref, pendingFence string) string`

Go needs to insert the PENDING fence at the correct document position, not always at the end.

```
Logic:
  1. Split ref on "," and take the last non-"doc" segment as anchorID.
  2. If anchorID == "" (ref is "doc" or empty) → append to end of body (same as web-clip).
  3. Otherwise scan lines for a fence block (```ai-block or ```web-clip) containing
     a top-level "id: <anchorID>" field.
  4. When the matching block's closing ``` (at column 0) is found, insert
     the pendingFence immediately after it with a blank line separator.
  5. Fallback to append if anchor not found.
```

Closing-fence detection uses exact `line == "```"` match — inner fences are always 4-space indented, so they never match at column 0.

---

## Step 2 — Refactor `requesthandlers/ai_handler.go`

### 2a. Add active-job tracking
```go
type AiHandler struct {
    ...
    activeJobs sync.Map  // blkID → struct{}
}
```

### 2b. Add `GET /api/ai/active` endpoint
Returns `{"active": ["ai-xxxx", ...]}` — same shape as `/api/internalize/active`.
Register in `RegisterPaths`.

### 2c. Unify and update request structs
Merge `askRequest` / `explainRequest` into one shared `aiBlockRequest`. Key changes vs current:
- **Remove** `BlkID string` — Go generates the ID now
- **Remove** `Body string` — Go manages the document now
- **Add** `ID string` — optional; if set, reuse existing block ID (retry path)
- **Add** `Ref string` — block this AI block references (used for insertion position)
- Keep: `Content`, `History`, `Question`, `NoteUUID`, `ImageBlockIds`

### 2d. Make handlers async (same pattern as `InternalizeHandler`)

**New handler flow for both ask and explain:**

```
Decode request → validate NoteUUID

If req.ID == "" (new block):
  blkID = fmt.Sprintf("ai-%s", randomHex(2))   // 4-char hex, same convention
  pending = AiBlockData{
    ID: blkID, Ref: req.Ref or "doc",
    Status: "PENDING", Type: "ASK"/"EXPLAIN",
    Question: req.Question, CreatedAt: time.Now().RFC3339,
  }
  pendingYAML = aiblock.SerializeYAML(pending)
  pendingFence = "```ai-block\n" + pendingYAML + "\n```"
  Load doc body, call InsertAfterRef(body, req.Ref, pendingFence), save
    (retry loop on ErrStaleStorable, same as internalize handler)
  Respond immediately: JSON {id: blkID, fence: pendingFence}

If req.ID != "" (retry):
  blkID = req.ID
  Respond immediately: JSON {id: blkID, fence: ""}

go h.runAiBlock(req.NoteUUID, blkID, blockType, req.Content, req.History,
                req.Question, req.ImageBlockIds)
```

**Background `runAiBlock`:**
```
h.activeJobs.Store(blkID, struct{}{})
defer h.activeJobs.Delete(blkID)

resp, err = RunAsk or RunExplain (existing AI service calls, unchanged)

status = "COMPLETE" or "TIMEOUT"/"ERROR"
model, completedAt = ...
ResolveAiBlock(uuid, blkID, resp, model, blockType)   // existing, unchanged

Broadcast "ai:block-resolved" SSE with {uuid, blkId, status, response, model, completedAt}
```

`randomHex` is already defined in `internalize_handler.go` in the same package — reuse it directly.

---

## Step 3 — Refactor `frontend/src/static/ai-block-extension.js`

### 3a. Switch from `updateDOM` to `setup` fence hook
Remove the `updateDOM` hook. Add a `setup` function (identical pattern to `web-clip-extension.js`):

```js
setup: function(markdownit) {
  var defaultFence = markdownit.renderer.rules.fence
  markdownit.renderer.rules.fence = function(tokens, idx, options, env, self) {
    var token = tokens[idx]
    if (token.info.trim() !== 'ai-block') {
      return defaultFence ? defaultFence(tokens,idx,options,env,self)
                          : self.renderToken(tokens,idx,options)
    }
    var data
    try { data = window.jsyaml.load(token.content) } catch(e) { data = null }
    if (!data || !data.id) {
      return defaultFence ? defaultFence(tokens,idx,options,env,self)   // non-destructive
                          : self.renderToken(tokens,idx,options)
    }
    var attrs = [
      'data-type="aiBlock"',
      'data-raw-yaml="' + esc(token.content) + '"',
      'data-id="' + esc(data.id) + '"',
      'data-ref="' + esc(data.ref || 'doc') + '"',
      'data-status="' + esc(data.status || 'PENDING') + '"',
    ]
    if (data.type)        attrs.push('data-block-type="' + esc(data.type) + '"')
    if (data.model)       attrs.push('data-model="' + esc(data.model) + '"')
    if (data.createdAt)   attrs.push('data-created-at="' + esc(data.createdAt) + '"')
    if (data.completedAt) attrs.push('data-completed-at="' + esc(data.completedAt) + '"')
    if (data.question)    attrs.push('data-question="' + esc(data.question) + '"')
    if (data.response)    attrs.push('data-response="' + esc(data.response) + '"')
    return '<div ' + attrs.join(' ') + '></div>\n'
  }
}
```

The `esc()` helper already exists at the bottom of the file.

### 3b. Add `rawYaml` to `addAttributes()`
```js
rawYaml: { default: '', parseHTML: function(el) { return el.getAttribute('data-raw-yaml') || '' } }
```

### 3c. Change markdown serialiser to rawYaml passthrough
```js
serialize: function(state, node) {
  state.ensureNewLine()
  var raw = node.attrs.rawYaml
  state.write('```ai-block\n' + raw + '\n```')
  state.closeBlock(node)
}
```

Keep `serializeAiBlockYaml` exported on `T` — `context-menu.js` uses it for display; it is no longer used for persistence.

### 3d. Add `isStale(createdAt, id)` and stale render branch

```js
function isStale(createdAt, id) {
  if (!createdAt) return true
  if (id && window.__sieveActiveAiBlocks && window.__sieveActiveAiBlocks.has(id)) return false
  var thresholdMs = (window.__sieveCliTimeoutLong || 60) * 1000 + 30000
  return Date.now() - new Date(createdAt).getTime() > thresholdMs
}
```

In `render(n)`, for `status === 'PENDING'`:
```
if (isStale(n.attrs.createdAt, n.attrs.id)) {
  // show badge--error + "Request timed out. (Right-click to Retry)"
  // same markup as the existing TIMEOUT/else branch
} else {
  // show badge--thinking + "(thinking…)"  ← current behaviour, unchanged
}
```

---

## Step 4 — Refactor `frontend/src/static/editor.js`

### 4a. Initialise `window.__sieveActiveAiBlocks`
```js
window.__sieveActiveAiBlocks = window.__sieveActiveAiBlocks || new Set()
```

### 4b. `initEditor` — add `/api/ai/active` to the parallel fetch
```js
Promise.all([
  fetch('/api/editor/load?uuid=' + uuid).then(r => r.json()),
  fetch('/api/internalize/active').then(r => r.json()).catch(() => ({active:[]})),
  fetch('/api/ai/active').then(r => r.json()).catch(() => ({active:[]})),
]).then(function(results) {
  window.__sieveActiveWebClips = new Set(results[1].active || [])
  window.__sieveActiveAiBlocks = new Set(results[2].active || [])
  // ... mount editor as before
})
```

### 4c. Rewrite `runAiJob`

**Remove:**
- `var blkId = 'ai-' + Math.random()...` (JS no longer generates IDs)
- The `insertContentAt(insertPos, { type: 'aiBlock', ... })` TipTap insertion block
- `body` capture and inclusion in the payload

**Compute `insertPos` before the fetch** (unchanged cursor/anchor logic — keep as-is, just move it earlier so we know where to insert the block once we have the ID from Go).

**New fetch flow:**
```js
fetch(endpoint, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({
    content: ctx.content, history: ctx.history, question: question || '',
    noteUUID: currentUuid, imageBlockIds: ctx.imageIds || [],
    ref: refId,   // NEW — anchor for Go's insertion
  })
}).then(r => r.json()).then(function(resp) {
  if (!resp || !resp.id) return
  var blkId = resp.id
  window.__sieveActiveAiBlocks.add(blkId)
  pendingAiBlkIds.add(blkId)
  window.SieveAI && window.SieveAI.trackJob(1, blkId, ...)

  // Insert from Go's canonical fence (resp.fence), same as doInternalize
  if (resp.fence && currentEditor) {
    var yamlText = resp.fence.replace(/^```ai-block\n/, '').replace(/\n```$/, '')
    var data = {}
    try { data = window.jsyaml.load(yamlText) || {} } catch(_) {}
    currentEditor.commands.insertContentAt(insertPos, {
      type: 'aiBlock',
      attrs: {
        rawYaml: yamlText,
        id: data.id || blkId, ref: data.ref || refId,
        status: 'PENDING', type: blockType,
        question: question || '', createdAt: data.createdAt || '',
      }
    })
    // scroll into view, same as current
  }
}).catch(function(err) {
  pendingAiBlkIds.delete(blkId)  // blkId not yet known if fetch failed before .then
  window.SieveAI && window.SieveAI.trackJob(-1, blkId)
  console.error('[editor] AI error', err)
})
```

### 4d. Update `sieve:ai-retry` handler
- Keep: set block to PENDING in TipTap (immediate visual feedback, `createdAt: now`)
- Change request payload: send `{id: blkId, content, history, question, noteUUID, imageIds, ref}` — **no body**
- On response (`resp.id`): add to `__sieveActiveAiBlocks`, `pendingAiBlkIds`, call `trackJob(1, ...)`
- On error: remove from sets, `trackJob(-1, blkId)`

### 4e. Replace `sse:ai:block-resolved` handler

Remove the entire in-place TipTap patch + `doSave` block. Replace with the simple softReload pattern:

```js
document.addEventListener('sse:ai:block-resolved', function(e) {
  var raw = e.detail && e.detail.data != null ? e.detail.data : ...
  if (!raw) return
  var data; try { data = JSON.parse(raw) } catch(_) { return }
  if (!data) return
  // Balanced decrement — only for jobs started this session
  if (data.blkId && pendingAiBlkIds.has(data.blkId)) {
    pendingAiBlkIds.delete(data.blkId)
    window.SieveAI && window.SieveAI.trackJob(-1, data.blkId)
  }
  // Remove from stale-detection set regardless of which note is open
  if (data.blkId) window.__sieveActiveAiBlocks.delete(data.blkId)
  if (data.uuid !== currentUuid) return
  softReloadContent(currentUuid)
})
```

---

## Retire Tech Debt

After implementation, update `docs/TECH-DEBT.md`:
- Mark **X-C** and **X-D** as retired with the commit reference.

---

## Verification

1. `go build ./...` — compile check
2. `go test ./sieve/aiblock/...` — unit tests for InsertAfterRef and SerializeYAML fixes
3. `wails dev` smoke test:
   - **Ask AI** → status bar "Asking AI...", PENDING block appears, completes via SSE, `softReloadContent` loads COMPLETE block with Go's canonical rawYaml
   - **Explain** → same as Ask
   - **Retry a timed-out AI block** → resets to PENDING, restarts, completes cleanly
   - **Switch notes mid-job** → return, block still shows thinking (in activeAiBlocks), resolves when SSE fires
   - **Reload page with old PENDING block** → shows "Timed out — retry" (stale, not in activeAiBlocks)
   - **Web-clip still works** — no regressions in the parallel fetch or SSE paths
