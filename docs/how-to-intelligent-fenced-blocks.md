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

## JS Architecture — the Renderer / NodeView Split (2026-07-20; contract rev 2 2026-07-21)

**Status:** shipped across the block-renderer-extraction epic (#43: #44 base,
#45 diagram, #46 ai-block, #47 code/log/web-clip/smart-card/smart-image), then
reconciled to the APPROVED **Block Renderer Contract rev 2** —
`docs/design/archive/specs/2026-07-21-block-renderer-contract.md` is NORMATIVE for
everything in this section. EVERY structured kind (7 of 7 — the eighth,
`smart-link`, was deleted by #67 along with the inline block mode itself:
`docs/design/archive/specs/2026-07-27-inline-block-removal-links-decision.md`)
now has a `BlockRenderer` subclass in `renderers/` held by a thin
NodeView adapter in `lens/document-editor/surfaces/node-views/` (`<kind>-node-view.js` —
moved+renamed from `processors/<kind>-renderer.js` 2026-07-21: they are
NodeViews, the old names clashed with the real renderers, and PM enters the
JS graph only in surfaces). **This is the required pattern for any new
block kind** — a new kind ships both halves in the same change.
parsing, job tracking, SSE completion, …) are unaffected and still apply
regardless of which half of this split a kind uses; this section only changes
**how the JS side builds and styles a block's DOM.**

A block kind's look-and-feel used to be fused to its ProseMirror `NodeView`,
and its CSS was fused to the global app stylesheet (`input.css`) — which meant
a block could only render correctly inside the note editor's exact
environment (see the spec's Problem section — the fullscreen lightbox bug,
`b57fe22`, is the concrete failure this fixes). The split has two halves,
**always migrated together, never separately:**

- **Renderer (JS class)** — attrs in, DOM out, sheet carried. A **real ES
  class hierarchy**: extends `BlockRenderer`, defined in
  `frontend/src/static/renderers/block-renderer.js` (its own `@ts-check`'d
  module; imported DIRECTLY — the old `base/fenced-block-base.js` re-export shim
  was dissolved by #49 P5):

  ```js
  import { BlockRenderer } from './block-renderer.js'
  import { MODE } from '../sieve-block.js'

  export class DiagramRenderer extends BlockRenderer {
    // CSS text using ONLY --theme-* variables for colour — the entire
    // host↔renderer styling contract. No selectors outside this kind's own
    // classes; no reliance on input.css. Registered exactly ONCE per class,
    // on first construction, by the base class constructor.
    static styles = `
      .diagram-block__render { ... color: var(--theme-text); ... }
    `

    // constructor is the base's: (block, blockService?, handleBuild?) —
    // block is the typed SieveBlock ENVELOPE (never a raw attr map; read
    // state via this.block.payload — no shadow copies). Scratch/authoring
    // instances are (block) only.

    // Region hooks — fabricate-and-return; the base render() places them
    // exactly once in canonical order (Header · Title · Body · Footer):
    buildHeader() { /* … */ }  buildBody() { /* … */ }

    /** @param {import('../sieve-block.js').SieveBlock} block */
    update(block) {
      super.update(block)              // stores the envelope — ALWAYS first
      /* patch via recorded slot refs from block.payload */
    }

    // SEMANTIC VERBS — consumers never see an attr name or wire value.
    // Declared kinds override core verbs (setMode/expand); kind-specific
    // verbs live on the subclass; ALL map to schema privately:
    setMode(mode) { this._pushAttrs({ mode: mode === MODE.EDIT ? 'edit' : 'render' }) }

    destroy() { /* release timers/observers/listeners this renderer owns */ }
  }
  ```

  Outbound effects flow through the **ContainerTransport** (constructed in the
  Workspace composition root, handed down — contract §service pair): the
  base's `retry()`/`setContent()` and the protected `_pushAttrs`/`_pushContent`
  route `blockId`-addressed calls to the applier the kind's adapter registers.
  A renderer constructed WITHOUT a service (a scratch/authoring instance) is
  inert — it authors DOM, never effects.

  A renderer **never** imports ProseMirror, never receives an `editor`/`view`
  reference, never touches `window.*` app globals. That is what makes it
  reusable outside the note editor — a chat-turn bubble, an embedded
  read-only card, and this doc's bare-page harness all construct and mount
  the *same* renderer class the NodeView uses. A kind may eventually have
  several renderers (one per presentation context — brainstorm 5 §6's "ref,
  costumed" chat chip is the first non-editor example); each carries its own
  `static styles`.

  **Styles file geography** (user decision 2026-07-20): a renderer file
  starts with its class — behaviour first, never a CSS wall to scroll past.
  Any sheet over ~30 lines lives in a sibling `<kind>-renderer.styles.js`
  module (`export const <kind>Styles = /* css */ \`…\``, Lit-style),
  imported into `static styles` (e.g. `diagram-renderer.js` imports
  `diagramStyles` from `diagram-renderer.styles.js`); tiny sheets (an
  escape-hatch patch a few lines long, say) may stay inline. The sibling
  import is renderer-internal — nothing outside the renderer file imports
  the styles module directly.

  **Build-once/patch-on-update, and the escaping rule** (2026-07-20, Phase 4
  / issue #47): the build hooks construct a kind's chrome DOM exactly once
  (`render()` invokes each exactly once); `update(block)` patches that same
  structure in place —
  `textContent`, `className`/`classList`, `hidden`, and real property
  assignments (`.href`, `.src`) — it never rebuilds skeleton via `innerHTML`
  on every call. This is a correctness rule, not a style preference: attrs
  frequently carry content from outside the app's control (a fetched page's
  title/URL, a backend error string, an AI-derived summary), and
  concatenating that text into an `innerHTML` string is a live injection
  hazard — a hostile `<img onerror=…>` in a page title would execute inside
  the editor. A status/badge-style decision (e.g. web-clip's
  pending/stale/timeout/error chrome) is a **state → `{glyph, modifierClass,
  label, …}` map** consulted by `update()`, the same shape as the shared
  `StatusBadge` decision tree (survey item A7) — not a set of near-identical
  `innerHTML` template strings. Apply this proportionately: a renderer that
  already mounts once and patches via `textContent` needs no rework merely to
  match a quota. Only a genuinely large STATIC skeleton (no per-instance
  interpolation, structure only, named `data-slot` markers) is large enough
  to warrant a sibling `<kind>-renderer.templates.js` module, set via
  `element.innerHTML = theTemplate` exactly once at mount and never touched
  again — the static-literal exception the rule above already carves out.

  **Body/title fill contract** (2026-07-20, the body/title pull-back, DEFECT
  SEC-B / issue #48): `BlockRenderer` ships two default methods,
  `fillTitle(el, text)` and `fillBody(el, markdown)` — both run the
  SANCTIONED dedicated markdown-it instance (html:false;
  `renderers/sanctioned-markdown.js`) followed by `applyHighlighting`.
  **Never** the editor's own (html:true) markdown-it instance — that instance
  stays confined to PM parse paths where the schema filters raw HTML before
  it reaches the DOM. TITLE rendering is renderer-side in *every* lens
  (titles are `contentEditable=false` static DOM everywhere, PM included):
  the NodeView adapter exposes its held renderer instance as
  `view.renderer`, and `sieve-block-extension.js`'s title seam
  (`syncBlockTitle`) delegates to `view.renderer.fillTitle` instead of
  writing `innerHTML` itself — this retires the old
  `titleEl.innerHTML = renderMarkdown(...)` injection vector
  architecturally. BODY stays framework/PM-owned in the note lens (document
  membership is a PM concern, not a markdown concern) — `fillBody` exists so
  a future non-PM host (chat turn, embedded card) gets a working body
  renderer for free. Override either method only for a kind whose title/body
  needs a non-markdown representation; the defaults are correct for every
  kind today.

- **NodeView (thin PM-lifecycle adapter)** — the *only* place that talks to
  ProseMirror. It relates to the renderer by **composition, never
  inheritance** — it *holds* a renderer instance as a field, it does not
  extend `BlockRenderer`: it constructs the renderer from the typed envelope
  (`sieveBlockFor(node, overlay)` — the seam's choke point; the overlay is the
  kind's live-text key), passing `ctx.blockService` and, for kinds whose BODY
  is live PM content, a `handleBuild` interceptor that CLAIMS the body region
  (returns `false` for `REGION.BODY` after decorating the container — the
  base skips the hook, records the claim, and the claimed container is PM's
  `contentDOM`). It registers the kind's **v1 applier** with the ContainerTransport
  (`owns`/`updateAttributes`/`setContent`/`retry` — where PM knowledge like
  render-ward caret capture lives; unregister in `destroy`), calls
  `renderer.update(sieveBlockFor(updatedNode, …))` from the TipTap `update()`
  hook, and `renderer.destroy()` from `destroy()`. Composition is
  load-bearing here, not a style preference — inheritance would drag PM
  lifecycle into the one class this seam keeps PM-free. The NodeView owns
  PM-only concerns the renderer must never see — `ignoreMutation`,
  `selectNode`, `stopEvent`, attribute parsing off `data-*` HTML attrs, plugin
  registration (`buildPlugins`) — and stays thin: schema/lifecycle glue, not
  look-and-feel.

**Style registration mechanism** (`frontend/src/static/renderers/renderer-style-registry.js`):
a `RendererStyleRegistry` registers a class's `static styles` **exactly once
per class**, the first time an instance is constructed, behind one
interchangeable strategy contract (`inject(cssText, key)`):

- `AdoptedSheetStrategy` (primary) — `new CSSStyleSheet()` + `replaceSync` +
  `document.adoptedStyleSheets`. One parse, shared across every mount. This is
  the live strategy on the app's actual engine: WebKitGTK 2.52.5
  (`webkit2gtk-4.1`, confirmed via `pkg-config --modversion webkit2gtk-4.1` in
  the nix dev shell), which comfortably post-dates the Safari 16.4-era engine
  that shipped constructable stylesheets.
- `StyleElementStrategy` (fallback) — a single deduplicated
  `<style data-sieve-renderer="ClassName">` in `<head>`. Kept so the seam
  never hard-codes an engine assumption (exported artefacts, older engines,
  non-browser hosts); chosen automatically when `adoptedStyleSheets` isn't
  present (feature-detected, not hardcoded).

**Definition of done for any renderer:** *renders correctly in a bare page
providing only `:root` theme vars.* Check this two ways:

1. `frontend/test/renderer-style-carriage.test.js` — vitest coverage of the
   registration mechanism (idempotency, both strategies, a real var()
   resolution check against a page with nothing but `:root` vars).
2. `frontend/test/harness/bare-page-renderer.html` — a static page with only
   `:root` theme vars and no app stylesheet; serve it (`python3 -m http.server`
   from the repo root — ES module imports need http, not `file://`) and view
   the mounted renderer by eye. Point a real renderer's demo at this harness
   the same way once it migrates.

**Escape hatches ride with the renderer, never `input.css`.** When a
third-party engine's theming surface has a gap (mermaid's shared
`.label` colour chain is the diagram pilot's case), the patch belongs in the
renderer's own output — appended to the engine's in-output `<style>` where
possible, so the artefact stays portable outside the app.

---

## Rule 1 — Go Owns All YAML. JS Never Generates It.

**Why:** YAML has many edge cases (quoting, multiline scalars, special characters). Having two generators (Go and JS) guarantees divergence. Go's `gopkg.in/yaml.v3` is the authoritative serialiser.

**How:**
- Go writes the initial `PENDING` fence and the final `COMPLETE`/`ERROR` fence.
- JS parses YAML (via `js-yaml`) to extract attributes for rendering. It never constructs YAML strings.
- The TipTap markdown serialiser uses a `rawYaml` attribute (stored verbatim from the original fence) and replays it unchanged:

```js
serialize: function (state, node) {
  state.ensureNewLine()
  state.write('```web-clip\n' + node.attrs.rawYaml + '\n```')
  state.closeBlock(node)
}
```

The fence hook stores the raw content in `data-raw-yaml` on the HTML element, which becomes `rawYaml` in TipTap attrs. The serialiser echoes it back out — no round-trip generation.

**Consequence:** After a background job completes, JS cannot update `rawYaml` in-place (the old value is still in TipTap's state). The correct completion flow is always `softReloadContent` — Go has already written the canonical YAML to disk; JS discards its stale state and reloads.

**Corollary — JS must flush its buffer before triggering any Go document write:** Go reads the document from disk when inserting a `PENDING` block, and again when resolving it. If the JS autosave debounce (1 s) has not yet fired, Go sees stale content; when `softReloadContent` runs on completion, the user's unsaved text is silently discarded.

Chain every backend request that causes Go to modify the document inside `flushSave().then(...)`:

```js
// Correct — save lands before Go reads the file.
flushSave().then(function () {
  fetch('/api/ai/ask', { method: 'POST', body: JSON.stringify({ /* ... */ }) })
    .then(function (r) { return r.json() })
    .then(function (resp) { /* insert PENDING node */ })
    .catch(function (err) { /* handle error */ })
})
```

Apply to: initial Ask / Explain (`runAiJob`), retry (`sieve:ai-retry` handler), and web-clip fetch / summarise (`doInternalize`). Any future handler that calls `InsertAfterRef` or otherwise mutates the document body must follow the same pattern.

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

## Rule 3 — Block Scalar Content Must Be Indented ≥ 4 Spaces

**Why:** CommonMark allows a closing fence to have 0–3 leading spaces. A 2-space indented line starting with three backticks (e.g. from a code block inside fetched content) will prematurely close the outer fence and corrupt the document.

**How:** Use `fencedblock.Serialize` (which calls `yaml.NewEncoder` with `SetIndent(4)`). This is handled automatically — you do not need to write indentation logic by hand. A 4-space indent makes any ` ``` ` inside block scalar content unparseable as a fence delimiter.

Do not hand-roll YAML serialization for fenced blocks. If you find yourself writing `lines = append(lines, "    "+l)`, stop and use `fencedblock.Serialize` instead.

---

## Rule 4 — Let the YAML Library Handle Quoting

**Why:** YAML has many edge cases for scalar values — colons, hashes, brackets, leading/trailing spaces, values that look like timestamps or booleans. A hand-written `yamlScalar()` helper will always have gaps.

**How:** Use `fencedblock.Serialize`, which uses `gopkg.in/yaml.v3`. yaml.v3 handles quoting automatically — values like `"React: A Complete Guide"`, `"https://example.com"`, and `"2026-05-22T10:00:00Z"` are all emitted safely and round-trip correctly without any helper function.

The `yamlScalar()` helpers that previously existed in `aiblock` and `webclip` have been deleted. Do not reintroduce them.

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

## Rule 7 — Active Job Tracking via Shared JobTracker + SSE

**The problem:** When the user switches notes and returns, TipTap reloads the document from disk. A `PENDING` block evaluates `isStale(createdAt)` against the current time. If the job has been running longer than the timeout window it shows "interrupted" — even though the job is still in flight.

**The solution — shared `JobTracker` + SSE lifecycle events:**

**Go-side:** All handlers share a single `*requesthandlers.JobTracker` (constructed in `handlers.go` and injected). Emit lifecycle SSE events at job boundaries:

```go
// handlers.go — one tracker shared across all handlers
jobTracker := requesthandlers.NewJobTracker()
// ...
AiHandler{JobTracker: jobTracker, ...}
InternalizeHandler{JobTracker: jobTracker, ...}
```

```go
// In any handler's background goroutine:
h.JobTracker.Start(JobInfo{JobID: blkID, Label: "Fetching example.com", DocID: uuid, SpinTab: true})
defer h.JobTracker.End(blkID)

hub.Broadcast("ai:job-started", mustJSON(jobInfo))
// ... do work ...
hub.Broadcast("ai:job-ended",   mustJSON(map[string]string{"jobId": blkID}))
```

`GET /api/ai/active-jobs` is served by `h.JobTracker.ServeActiveJobs` and returns all currently in-flight jobs — used by JS to restore state on tab switch.

**JS-side:** `renderers/job-status.js` owns job tracking — a stateful `JobStatusTracker` singleton (seeded from `/api/jobs` on module load, kept current by the `sse:jobs:changed` full-snapshot listener). It exports `isJobActive(id)` / `isJobQueued(id)` / `isJobStale(createdAt, id)` / `isStaleByTime(createdAt)` — import and call them in every block extension's `isStale`:

```js
import { isStaleByTime, isJobActive } from '../../../renderers/job-status.js'

function isStale(createdAt, id) {
  if (isJobActive(id)) return false
  return isStaleByTime(createdAt)
}
```

No manual `window.__sieve*` Set management in the extension. No `trackJob()` calls. The status bar is also driven automatically by the same SSE events via `ai-actions.js`.

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

## Rule 9 — Status Bar Integration via SSE (No Manual trackJob Calls)

The status bar spinner ("Evaluating…") is driven automatically by `ai:job-started` / `ai:job-ended` SSE events broadcast by Go. `ai-actions.js` listens and maintains the counter — **the extension JS does not call `trackJob()` manually**.

What the extension must do: ensure Go emits the lifecycle events (see Rule 7). That is all. The status bar, the active-job map, and the tab spinner are all consequences of Go broadcasting correctly.

The old pattern of `window.__sieveActiveWebClips.add/delete` + `SieveAI.trackJob(±1)` from JS has been removed. Do not reintroduce it.

---

## Rule 10 — JS Extension Structure: Import Shared Utilities from `renderers/`

All fenced block extensions are loaded as `type="module"`. Import shared utilities directly from their owning modules in `frontend/src/static/renderers/` (the old `base/fenced-block-base.js` single import point was dissolved by #49 P5) — do not duplicate them:

```js
import { esc } from '../../../renderers/html-escape.js'
import { renderSanctionedMarkdown } from '../../../renderers/sanctioned-markdown.js'
import { applyHighlighting } from '../../../renderers/highlighting.js'
import { isStaleByTime, isJobActive } from '../../../renderers/job-status.js'
```

| Export (module) | Purpose |
|--------|---------|
| `esc(str)` (`html-escape.js`) | HTML-escape a string for `data-*` attribute values |
| `renderSanctionedMarkdown(text)` (`sanctioned-markdown.js`) | Render markdown via the SANCTIONED dedicated markdown-it instance (html:false — never the editor's own html:true one, DEFECT SEC-B / issue #48); plain-text fallback. |
| `isStaleByTime(createdAt)` (`job-status.js`) | Time-based PENDING staleness — always the final fallback in `isStale` |
| `isJobActive(id)` (`job-status.js`) | Returns true if the block's job ID is currently in-flight on the server — check this first in `isStale` |
| `applyHighlighting(container)` (`highlighting.js`) | Box styling + line numbers + syntax colours for rendered content (see Rule 11) |

The IIFE wrapper in extension files is kept for compatibility; the `import` line goes before it.

---

## Rule 11 — Rendered Content: Call `applyHighlighting` After Setting innerHTML

After rendering a markdown field into a container div, call `applyHighlighting`:

```js
var contentEl = document.createElement('div')
contentEl.className = 'my-block__content'
contentEl.innerHTML = renderSanctionedMarkdown(data.content)
applyHighlighting(contentEl)          // adds sieve-rendered-content class + processes pre>code
container.appendChild(contentEl)
```

`applyHighlighting` does three things in one call:
1. Adds the `sieve-rendered-content` CSS class to the container
2. Wraps each `<pre><code>` block in a `.sieve-code-block` flex layout with a line-number gutter (mirrors the TipTap editor's native code block appearance)
3. Applies lowlight syntax highlighting to any `language-*` code block

All colours come from existing theme variables — no extra CSS needed in the block's own stylesheet.

---

## Rule 12 — Context Menu via `sieve:contextmenu`

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

## Rule 13 — Chain-Active Hover: The CSS Pattern

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

## Rule 14 — AI History/Context Must Be Human-Readable

When a block is used as context for a follow-up AI question, send clean prose — not raw YAML fences. Claude cannot reason about YAML structure as conversation history; it needs the *meaning*.

**The pattern for any block type:** write a `<blockType>Summary(node)` function that extracts the semantically meaningful fields and formats them as readable prose or Markdown. The right fields depend on what the block *is*:

| Block type | Meaningful content to pass |
|------------|---------------------------|
| `ai-block` | `question` + `response` as `**Q:**` / `**A:**` |
| `web-clip` | `title`, `source` URL, and `content` (the fetched/summarised text) |
| `diagram` *(future)* | diagram description/caption + the diagram source (e.g. Mermaid syntax) as a labelled code block |
| Any block | Whatever a human would read to understand what the block *contains* — not the YAML wrapper |

**Bad:** Pass the raw ` ```ai-block ... ``` ` fence text.

**Good (ai-block example):**

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

**Good (web-clip example):**
```js
function webClipSummary(node) {
  var parts = []
  if (node.attrs.title)   parts.push('**' + node.attrs.title + '**')
  if (node.attrs.source)  parts.push('Source: ' + node.attrs.source)
  if (node.attrs.content) parts.push(node.attrs.content.trim())
  return parts.join('\n\n')
}
```

When building a new block type, ask: *"if I were pasting this block's content into a chat message, what would I write?"* — pass that.

---

## Rule 15 — Adjacent Block Detection for `nodesBetween`

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

**Go side**
- [ ] Go struct with yaml tags; use `fencedblock.Serialize` (yaml.v3, SetIndent 4) — no hand-rolled YAML, no `yamlScalar()` helper
- [ ] `PREFIX-XXXX` ID generation (`randomHex(2)` → 4 hex chars)
- [ ] HTTP handler: new block appends PENDING fence; retry reuses caller-supplied ID
- [ ] Handler holds `*requesthandlers.JobTracker` (injected from the shared instance in `handlers.go`)
- [ ] Background goroutine: calls `h.JobTracker.Start` + `hub.Broadcast("ai:job-started", ...)` at start; `h.JobTracker.End` + `hub.Broadcast("ai:job-ended", ...)` after SSE resolution broadcast

**JS side**
- [ ] Extension file is `type="module"`; import shared utilities directly from `renderers/` (`esc` ← html-escape.js, `renderSanctionedMarkdown` ← sanctioned-markdown.js, `applyHighlighting` ← highlighting.js, `isStaleByTime`/`isJobActive` ← job-status.js — Rule 10)
- [ ] `flushSave().then(...)` wraps every `fetch` that causes Go to write the document
- [ ] TipTap Node extension:
  - [ ] Fence hook replaces ` ```tag ``` ` → `<div data-type="...">` with `data-*` attributes including `data-raw-yaml`
  - [ ] Non-destructive: passes through to `defaultFence` on parse failure or missing `id`
  - [ ] `addAttributes()` parsers read from `data-*` HTML attributes
  - [ ] `addNodeView()` renders from attrs (never generates YAML)
  - [ ] Markdown serialiser replays `node.attrs.rawYaml` verbatim
- [ ] After `contentEl.innerHTML = renderMarkdown(...)` → call `applyHighlighting(contentEl)`
- [ ] Block identity `data-*` (`data-id`/`data-kind`) is stamped by the renderer's own `render()` from the envelope — adapters never write renderer DOM
- [ ] `isStale(createdAt, id)`: call `isJobActive(id)` first (from `renderers/job-status.js` — or just use its `isJobStale(createdAt, id)`), then `return isStaleByTime(createdAt)` — no manual Set management needed
- [ ] Context menu dispatches `sieve:contextmenu`; sets node selection before opening
- [ ] SSE/server completion arrives as a render-back op (insert-block / replace-block / block-attrs-updated) applied as a TRACKED transaction — never `softReloadContent` for an operation (that wipes undo; backend-is-source-of-truth rule)

**Visual / UX**
- [ ] Chain-active hover: `::after` CSS + `mouseenter`/`mouseleave` toggling class in both directions
- [ ] AI context: pass clean prose summary, not raw YAML

**Renderer / NodeView split (see "JS Architecture" above; NORMATIVE: the Block Renderer Contract rev 2) — required for any new kind (every existing kind complies):**
- [ ] Look-and-feel lives in a `BlockRenderer` subclass: base constructor `(block, blockService?, handleBuild?)` (typed `SieveBlock` envelope, never a raw attr map), `build*` region hooks + base `render()`, `update(block)` calling `super.update(block)` FIRST, `destroy()`; zero PM/editor/`window.*`-app-bus imports; state read from `this.block.payload` only (no shadow attr caches)
- [ ] Outbound effects are SEMANTIC VERBS (core `setMode`/`setContent`/`retry`/`expand`, kind verbs on the subclass) mapping to schema privately via `_pushAttrs`/`_pushContent` — consumers never see an attr name
- [ ] `static styles` carries the kind's CSS, using ONLY `--theme-*` vars for colour; moved out of `input.css` in the SAME change (never a separate pass)
- [ ] NodeView is a thin adapter in `lens/document-editor/surfaces/node-views/`: constructs the renderer from `sieveBlockFor(node[, overlay])` + `ctx.blockService`, claims a live-PM body via `handleBuild` where the kind needs one, registers the v1 applier (unregistered in `destroy`), calls `renderer.update(sieveBlockFor(...))`/`renderer.destroy()`; owns `ignoreMutation`/`selectNode`/`stopEvent`/attr parsing/`buildPlugins` — no look-and-feel logic
- [ ] Build hooks construct chrome DOM once; `update(block)` patches via `textContent`/`className`/`hidden`/property assignment — never rebuilds skeleton via `innerHTML`; no attrs-derived text is ever concatenated into an `innerHTML` string (injection hazard — see "Build-once/patch-on-update" above)
- [ ] Renders correctly against `frontend/test/harness/bare-page-renderer.html` (only `:root` theme vars, no app stylesheet)
