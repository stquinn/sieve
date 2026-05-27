# How to Build an Intelligent Fenced Block in Sieve

A guide synthesised from building the Web Clip block (`web-clip`) and the AI Block (`ai-block`). These are "Category 3" blocks — machine-generated artefacts embedded in the Markdown document as fenced code blocks with a custom language tag.


---

## What is an Intelligent Fenced Block?

A fenced block with a named language tag (e.g. ` ```web-clip ` or ` ```ai-block `) that:

- Carries structured data in YAML inside the fence
- Is rendered by a custom TipTap `Node` with a `NodeView` (not as raw code)
- Is created by a user action, processed asynchronously by Go, and resolved via SSE
- Is persisted verbatim in the Markdown file — Go owns the serialised form


---

## Rule 1 — Go Owns All YAML. JS Never Generates It.

**Why:** YAML has many edge cases (quoting, multiline scalars, special characters). Having two generators (Go and JS) guarantees divergence. Go's `gopkg.in/yaml.v3` is the authoritative serialiser.

**How:**
- Go writes the initial `PENDING` fence and the final `COMPLETE`/`ERROR` fence.
- JS parses YAML (via `js-yaml`) to extract attributes for rendering. It never constructs YAML strings.
- The TipTap markdown serialiser uses a `rawYaml` attribute (stored verbatim from the original fence) and replays it unchanged:
- UI Needs to SAVE current buffer before allowing backend to update and insert place holder - or buffer only changes will be lost.

```js
serialize: function (state, node) {
  state.ensureNewLine()
  state.write('```web-clip\n' + node.attrs.rawYaml + '\n```')
  state.closeBlock(node)
}
```

The fence hook stores the raw content in `data-raw-yaml` on the HTML element, which becomes `rawYaml` in TipTap attrs. The serialiser echoes it back out — no round-trip generation.

**Consequence:** After a background job completes, JS cannot update `rawYaml` in-place (the old value is still in TipTap's state). The correct completion flow is always `softReloadContent` — Go has already written the canonical YAML to disk; JS discards its stale state and reloads.

---

## Rule 2 — TipTap Extensions Must Be Non-Destructive

**Why:** If a fence is malformed, has a missing required field, or the YAML fails to parse, the user's content must survive intact. A buggy or incomplete block must never silently erase text.

**How — the fence hook:**

```js
markdownit.renderer.rules.fence = function (tokens, idx, ...) {
  var token = tokens[idx]
  if (token.info.trim() !== 'web-clip') {
    return defaultFence ? defaultFence(...) : self.renderToken(...)  // pass through
  }
  var data
  try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
  if (!data || !data.id) {
    return defaultFence ? defaultFence(...) : self.renderToken(...)  // leave as code block
  }
  // ... only now replace with a custom div
}
```

**How — the `updateDOM` / `updateDOM` parse hook (ai-block pattern):**

```js
try {
  data = window.jsyaml.load(yamlText)
} catch (e) {
  return  // leave the original <pre> intact — renders as a plain code block
}
if (!data || !data.id) return
```

**The rule:** Any parse failure must leave the original `<pre>` block in place. Never replace content with nothing. Never throw an unhandled exception into the renderer.

---

## Rule 3 — Inner Fences Need 4-Space Block Scalar Indentation

**Why:** CommonMark allows a closing fence to have 0–3 leading spaces. A 2-space indented line that starts with three backticks (e.g. from a code block inside fetched content) will prematurely close the outer `web-clip` fence, corrupting the document.

**How:** All block scalars inside a fenced block must indent their content lines by **at least 4 spaces**:

```go
// Go serialiser
lines = append(lines, "content: |")
for _, l := range strings.Split(content, "\n") {
    if l == "" {
        lines = append(lines, "    ")   // 4 spaces even for blank lines
    } else {
        lines = append(lines, "    "+l)
    }
}
```

```js
// JS serialiser (only used for ai-block question field — Go owns the rest)
r.split('\n').forEach(function (l) { lines.push('    ' + (l || '')) })
```

A 4-space indent means any ` ``` ` sequence inside the content becomes `    ``` ` — four leading spaces make it unparseable as a fence delimiter.

---

## Rule 4 — YAML Scalars Must Be Quoted When Necessary

Certain characters are meaningful in YAML and will break parsing if they appear unquoted in a flow scalar: `: # { } [ ] | > & * ! ,` — and a value that starts or ends with a space.

**Go** uses a helper:

```go
func yamlScalar(s string) string {
    needsQuote := strings.ContainsAny(s, `:#{}[]|>&*!,`) ||
        strings.HasPrefix(s, " ") || strings.HasSuffix(s, " ")
    if !needsQuote {
        return s
    }
    s = strings.ReplaceAll(s, `\`, `\\`)
    s = strings.ReplaceAll(s, `"`, `\"`)
    return `"` + s + `"`
}
```

**JS** mirrors this exactly for any field it writes (currently only `source`, `model`, `createdAt`, `completedAt` in the retry serialiser):

```js
function yamlScalar(s) {
  if (!s) return s
  var needsQuote = /[:#{}[\]|>&*!,]/.test(s) || s[0] === ' ' || s[s.length - 1] === ' '
  if (!needsQuote) return s
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}
```

**For multiline values** (titles, content, error messages) use block scalars (`|` or `|-`) rather than quoting. Block scalars are immune to special characters and are more readable:

```yaml
title: |-
  Page title with "quotes" and : colons — no escaping needed
content: |
    First paragraph.

    Second paragraph with ```code``` — safe because of 4-space indent.
```

Use `|-` (strip) for title (no trailing newline). Use `|` (clip) for content/error (preserve single trailing newline, conventional for prose).

---

## Rule 5 — ID Convention: `PREFIX-XXXX` (4 Hex Characters)

All block IDs in Sieve follow the pattern `prefix-XXXX` where `XXXX` is 4 random lowercase hex characters. Examples: `wc-a3f9`, `ai-c71e`.

**Go:**

```go
func randomHex(n int) string {
    b := make([]byte, n)
    rand.Read(b)
    return hex.EncodeToString(b)
}

blkID = fmt.Sprintf("wc-%s", randomHex(2))  // 2 bytes → 4 hex chars
```

Do not use longer IDs (e.g. 12 characters from `randomHex(6)`). Short IDs keep the YAML readable and are unique enough within a document.

---

## Rule 6 — Retry Must Reuse the Existing Block ID

**Why:** When a job fails and the user retries, the block already exists in the document with its ID embedded in `rawYaml`. If Go generates a new ID, the SSE completion event (`blkId: newId`) will never match the DOM element (`data-wc-id="oldId"`), and the block stays stuck.

**How:** The retry request sends the existing `id`:

```js
// JS — retry handler
fetch('/api/internalize', {
  body: JSON.stringify({ uuid: currentUuid, source: detail.source, mode: detail.mode, id: blkId })
})
```

Go checks for it:

```go
if req.ID != "" {
    // Retry path — reuse caller's ID, skip appending a new PENDING block
    blkID = req.ID
} else {
    // New block — generate ID and append PENDING fence to document
    blkID = fmt.Sprintf("wc-%s", randomHex(2))
    // ... append fence ...
}
```

---

## Rule 7 — Active Job Tracking for Stale-vs-Running Detection

**The problem:** When the user switches notes and returns, TipTap reloads the document from disk. A `PENDING` block evaluates `isStale(createdAt)` against the current time. If the job has been running for longer than the timeout window, it shows "interrupted" — even though the job is still running in the background.

**The solution — two layers:**

**Go-side (server of truth):**

```go
type InternalizeHandler struct {
    activeJobs sync.Map  // blkID → struct{}
}

func (h *InternalizeHandler) runInBackground(uuid, id, ...) {
    h.activeJobs.Store(id, struct{}{})
    defer h.activeJobs.Delete(id)
    // ... do the work ...
}

// GET /api/internalize/active → {"active": ["wc-a3f9", ...]}
func (h *InternalizeHandler) handleActiveJobs(w http.ResponseWriter, r *http.Request) {
    var ids []string
    h.activeJobs.Range(func(key, _ any) bool {
        ids = append(ids, key.(string)); return true
    })
    json.NewEncoder(w).Encode(map[string][]string{"active": ids})
}
```

**JS-side (zero flicker on note switch):** `initEditor` fetches the active list in parallel with the note content, populating `window.__sieveActiveWebClips` before TipTap renders a single node:

```js
Promise.all([
  fetch('/api/editor/load?uuid=' + uuid).then(r => r.json()),
  fetch('/api/internalize/active').then(r => r.json()).catch(() => ({ active: [] })),
]).then(function (results) {
  window.__sieveActiveWebClips = new Set(results[1].active || [])
  // ... mount editor with results[0].body ...
})
```

`isStale()` checks the set first:

```js
function isStale(createdAt, id) {
  if (!createdAt) return true
  if (id && window.__sieveActiveWebClips && window.__sieveActiveWebClips.has(id)) return false
  var thresholdMs = (window.__sieveCliTimeoutLong || 60) * 1000 + 30000
  return Date.now() - new Date(createdAt).getTime() > thresholdMs
}
```

The SSE completion handler removes the ID from the set (even if the note is not currently open):

```js
if (data.blkId && window.__sieveActiveWebClips.has(data.blkId)) {
  window.__sieveActiveWebClips.delete(data.blkId)
  window.SieveAI && window.SieveAI.trackJob(-1)
}
```

---

## Rule 8 — Completion Flow: SSE → Go Writes to Disk → JS Reloads

Because JS cannot regenerate `rawYaml` correctly (see Rule 1), the completion flow is always:

1. Background goroutine finishes; calls `ResolveWebClip(uuid, id, ...)`.
2. Go reads the document, replaces the `PENDING` fence with a `COMPLETE` fence (full canonical YAML), saves to disk.
3. Go broadcasts `ai:web-clip-resolved` SSE event with `{uuid, blkId, status, ...}`.
4. JS SSE handler removes the ID from `__sieveActiveWebClips`, then calls `softReloadContent(currentUuid)`.
5. `softReloadContent` fetches the saved body from `/api/editor/load` and replaces TipTap's content.

Do **not** try to patch TipTap in-place and then call `doSave` for rawYaml-carrying blocks — `getMarkdown()` will replay the old `rawYaml` and overwrite Go's correct YAML on disk.

The in-place-patch + doSave pattern is only appropriate for blocks where JS **owns** serialisation (e.g. the ai-block, which builds YAML from live TipTap attrs).

---

## Rule 9 — Status Bar Integration

All background AI jobs should show the "Evaluating (N)" spinner in the status bar. The counter is owned by `ai-actions.js` via `window.__sieveActiveJobs`. Call `window.SieveAI.trackJob(+1)` when a job starts and `window.SieveAI.trackJob(-1)` when it completes or errors:

```js
// Job starts
window.__sieveActiveWebClips.add(blkId)
window.SieveAI && window.SieveAI.trackJob(1)

// SSE completion (only decrement if we incremented)
if (window.__sieveActiveWebClips.has(data.blkId)) {
  window.__sieveActiveWebClips.delete(data.blkId)
  window.SieveAI && window.SieveAI.trackJob(-1)
}

// HTTP-level error (SSE will never fire — decrement here)
window.__sieveActiveWebClips.delete(blkId)
window.SieveAI && window.SieveAI.trackJob(-1)
```

Guard every decrement with a `has()` check so the counter can never go negative if an SSE fires for a job started before a page reload.

---

## Rule 10 — Context Menu via `sieve:contextmenu`

Do not wire context menus directly in the NodeView. Dispatch a `sieve:contextmenu` CustomEvent from the `contextmenu` DOM listener:

```js
dom.addEventListener('contextmenu', function (e) {
  e.preventDefault()
  e.stopPropagation()
  if (typeof getPos === 'function') editor.commands.setNodeSelection(getPos())
  document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
    detail: { x: e.clientX, y: e.clientY, context: { type: 'webClip', editor, getPos, node: currentNode } }
  }))
})
```

`context-menu.js` receives the event and builds the menu from the `context.type`. This keeps menu logic in one place and makes it easy to add new items (Ask AI, Explain, Retry, Delete…) without touching the extension.

**Important:** When a context menu item triggers an AI action (Ask, Explain), re-assert the node selection before dispatching the AI event, otherwise `buildAiContext` may not find the right block:

```js
{ label: 'Ask AI...', action: function () {
  if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
  else editor.commands.focus()
  document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
}}
```

---

## Rule 11 — Chain-Active Hover: The CSS Pattern

Intelligent blocks that participate in reference chains should highlight their chain peers on hover. The pattern uses a CSS class toggled by `mouseenter`/`mouseleave` and an `::after` pseudo-element for the left bracket:

```css
.web-clip-block.web-clip-block--chain-active {
  border-color: color-mix(in srgb, var(--theme-accentCyan) 30%, var(--theme-aiBlockBorder)) !important;
  background:   color-mix(in srgb, var(--theme-accentCyan) 4%,  var(--theme-aiBlockBg));
}
.web-clip-block.web-clip-block--chain-active::after {
  content: '';
  position: absolute; inset: -1px; border-radius: 8px;
  border-left: 3px solid var(--theme-accentCyan);
  pointer-events: none; z-index: 5;
}
```

The DOM element needs `data-wc-id` set (both on creation and in every `render()` call, because `render()` calls `dom.innerHTML = ''` which destroys previous children but not the element itself).

Blocks highlight in both directions:
- **Forward (from source to consumer):** The AI block's `mouseenter` looks up web-clip elements by `data-wc-id` matching its `data-ai-ref`.
- **Reverse (from source back to consumers):** The web-clip's `mouseenter` looks up AI blocks whose `data-ai-ref` includes this web-clip's ID.

---

## Rule 12 — AI History/Context Must Be Human-Readable

When a block is used as context for a follow-up AI question, send clean prose — not raw YAML fences. Claude cannot reason about YAML as conversation history.

**Bad:** Pass the raw ` ```ai-block ... ``` ` fence text as a history turn.

**Good:** Extract `question` and `response` attrs and format as Q/A:

```js
function aiBlockSummary(node) {
  var q = (node.attrs.question || '').trim()
  var r = (node.attrs.response || '').trim()
  if (!q && !r) return serializer.serialize(node).trim()
  var parts = []
  if (q) parts.push('**Q:** ' + q)
  if (r) parts.push('**A:** ' + r)
  return parts.join('\n\n')
}
```

Similarly, when a web-clip block is referenced, pass its `title`, `source`, and `content` as clean Markdown rather than the raw YAML.

---

## Rule 13 — Adjacent Block Detection for `nodesBetween`

ProseMirror's `nodesBetween(from, to, cb)` visits nodes that **contain** positions in `[from, to]`. A collapsed cursor (`from === to`) positioned immediately after a block will not visit that block — the block ends at `from` but does not contain it.

When detecting which block the cursor is "in or after", also check the previous sibling at each ancestor depth:

```js
if (!aiBlockId) {
  var $pos = selection.$from
  for (var d = 0; d <= $pos.depth; d++) {
    var idx = $pos.index(d)
    if (idx > 0) {
      var prev = $pos.node(d).child(idx - 1)
      if (prev && prev.type.name === 'aiBlock') {
        aiBlockId = prev.attrs.id
        break
      }
    }
  }
}
```

---

## Checklist: Building a New Intelligent Fenced Block

- [ ] Go struct + YAML serialiser with `yamlScalar()` for all flow scalars
- [ ] Block scalar indentation ≥ 4 spaces for multiline fields
- [ ] `PREFIX-XXXX` ID generation (`randomHex(2)` → 4 hex chars)
- [ ] HTTP handler: new block appends PENDING fence; retry reuses caller-supplied ID
- [ ] `sync.Map` + `GET /api/.../active` endpoint for stale-vs-running detection
- [ ] Background goroutine: registers ID in activeJobs, defers delete, broadcasts SSE on completion
- [ ] TipTap Node extension:
  - [ ] Fence hook replaces ` ```tag ``` ` → `<div data-type="...">` with `data-*` attributes
  - [ ] Non-destructive: passes through to `defaultFence` on parse failure or missing `id`
  - [ ] `rawYaml` attribute stored from `data-raw-yaml` for verbatim serialisation
  - [ ] `addAttributes()` parsers read from `data-*` HTML attributes
  - [ ] `addNodeView()` renders from attrs (never generates YAML)
  - [ ] Markdown serialiser replays `node.attrs.rawYaml` verbatim
- [ ] `data-wc-id` (or equivalent) set on NodeView DOM element and re-set in every `render()` call
- [ ] Context menu dispatches `sieve:contextmenu`; sets node selection before opening
- [ ] JS job lifecycle: `window.__sieveActiveWebClips.add/delete` + `SieveAI.trackJob(±1)`
- [ ] `initEditor` fetches `/api/.../active` in parallel with note content
- [ ] `isStale()` checks active set before time-based evaluation
- [ ] SSE completion: removes ID from active set then calls `softReloadContent` (no in-place YAML patch)
- [ ] Chain-active hover: `::after` CSS + `mouseenter`/`mouseleave` toggling class in both directions
- [ ] AI context: pass clean prose summary, not raw YAML
