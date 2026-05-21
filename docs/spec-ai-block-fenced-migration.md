# Specification: AI Block Migration to Fenced YAML Format

---

## Decision Record: Why Markdown is the Canonical Storage Format

This decision was made explicitly and should not be relitigated without revisiting all three constraints below.

### What was considered

**Option A — Custom node format (ProseMirror JSON)**
Store documents as a JSON array of typed nodes. Go manipulates them trivially by index or id. No fence parser. No flush race. TipTap loads its own JSON natively.

Rejected because it locks the knowledge base. Documents stored as JSON are opaque outside Sieve. Users cannot open them in a text editor, grep them, use them in Obsidian, or pipe them into other tools. A markdown exporter was considered as a workaround, but exporting is a manual step — knowledge that lives in JSON is only ever one missed export away from being inaccessible.

**Option B — Markdown as canonical storage (chosen)**
Documents are `.md` files on disk. Always readable in any editor, always portable, always accessible.

### Why markdown wins on all three axes

| Goal | Why markdown |
|------|-------------|
| **Human portability** | Any text editor, any platform, forever. No app required to read your own notes. |
| **Tool interoperability** | Greppable, Obsidian-compatible, scriptable. The knowledge base works with any markdown-aware tool. |
| **AI crawlability** | LLMs are deeply trained on markdown. Structure — headings, lists, code blocks — carries semantic weight in context. JSON node trees would need a serialisation step and lose that fidelity. |

Sieve's purpose is to build up a knowledge base that compounds over time. The storage format must outlive the app. Markdown satisfies that requirement; a proprietary node format does not.

### What this costs

The price is Go-side complexity for structured operations — specifically the fence parser needed to find and update `ai-block` nodes in markdown. This is a bounded cost: one small package, written once, that never changes because we control the format. It is the correct trade-off.

### AI blocks in markdown

Fenced YAML blocks are readable by humans and LLMs alike:

````markdown
```ai-block
id: abc123
status: COMPLETE
question: What is the strangler fig pattern?
response: |
  It's a migration strategy where you incrementally replace an old system
  alongside a new one, routing traffic gradually until the old is empty.
```
````

An LLM crawling the knowledge base sees the question, the answer, and understands their relationship. The format is transparent to any future tooling.

---

## 1. Motivation

The current AI block format uses a custom open/close tag syntax:

```
[!ai] id="abc123" ref="doc"
***Ask:*** What is X?

---

The answer is Y.
[!ai-end]
```

This has caused real bugs in production:

- The `---` divider to separate question from answer collides with Markdown's horizontal rule — if either the question or response contains a `---`, the block structure breaks
- `[!ai-end]` going missing causes rendering corruption — the parser finds the next block's closing tag and swallows everything in between
- The in-flight placeholder during AI generation is string-injected markdown pretending to be a data structure, then regex-replaced on completion — fragile and hard to reason about
- Metadata is limited to what fits on the opening tag line — no room to grow for status, model, timestamps, collapse state

**Goal:** migrate to a fenced YAML block format. All fields are explicit named properties. The question and response are YAML block scalars — no delimiter conventions that can collide with content.

---

## 2. New Format

````markdown
```ai-block
id: abc123
ref: doc
status: COMPLETE
model: claude-sonnet-4-6
createdAt: 2026-05-02T10:00:00Z
completedAt: 2026-05-02T10:01:23Z
question: What is the strangler fig pattern?
response: |
  It's a migration strategy where you:

  1. Build the new thing alongside the old
  2. Route traffic gradually
  3. Delete the old once empty
```
````

With a multiline question:

````markdown
```ai-block
id: abc123
ref: doc
status: COMPLETE
model: claude-sonnet-4-6
createdAt: 2026-05-02T10:00:00Z
question: |
  What is the strangler fig pattern?
  And how does it apply to database migrations
  in a zero-downtime deployment context?
response: |
  It's a migration strategy where you incrementally replace an old system
  alongside a new one, routing traffic gradually until the old is empty.

  ---

  Named after the strangler fig tree, which grows around a host tree
  and eventually replaces it entirely.
```
````

A pending block (no response yet):

````markdown
```ai-block
id: abc123
ref: doc
status: PENDING
model: claude-sonnet-4-6
createdAt: 2026-05-02T10:00:00Z
question: What is the strangler fig pattern?
```
````

### Why the question must be in the metadata

The `---` collision bug was caused by having both question and response in the block body, separated by a `---` delimiter. Moving the question into the YAML metadata eliminates this class of bug entirely. The response body contains only response content — no structural delimiters needed.

Single-line questions serialize as plain YAML scalars. Multiline questions use the `|` literal block scalar. The serializer chooses based on whether the string contains `\n`.

### Why YAML `|` block scalars are safe for markdown content

The `|` literal block scalar preserves content exactly — newlines, blank lines, all markdown characters pass through unescaped. Specifically:

- `---` in the response is safe. YAML only recognises `---` as a document separator at column 0. The block scalar content is indented two spaces — that `---` is just the string `---`.
- Markdown characters (`*`, `#`, `` ` ``, `_`, `[`, `]`) require no escaping in YAML block scalars.
- Triple backticks inside a block scalar value cannot terminate the fence because they are not at the fence indentation level.

The `|` (literal) scalar is correct for both `question` and `response`. The `>` (folded) scalar would collapse single newlines into spaces, destroying paragraph structure. Always use `|`.

### Schema

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID, unique per block |
| `ref` | string | Comma-separated block IDs for chain highlighting. `doc` means anchored to document root |
| `type` | string | `ASK` \| `EXPLAIN` \| … extensible — drives badge label and any type-specific UI |
| `status` | string | `PENDING` \| `COMPLETE` \| `TIMEOUT` |
| `question` | string | The prompt sent to the AI. Plain scalar or `\|` block scalar |
| `response` | string | The AI's response as a markdown string. `\|` block scalar. Absent when status is not `COMPLETE` |
| `model` | string | Model ID used for this response |
| `createdAt` | string | ISO 8601 timestamp — set when block is inserted |
| `completedAt` | string | ISO 8601 timestamp — set when response is written. Absence confirms incomplete |

Fields are open — additional metadata (token counts, temperature, collapse state) can be added without a format change.

---

## 3. AI Blocks as Reasoning Artifacts

AI blocks are **scratchpad containers**, not document content. They capture a moment of reasoning — a question asked and an answer received — embedded in the document as a reference object.

When an AI response produces something worth keeping as first-class document content, the user explicitly **promotes** it. This is a deliberate act, not automatic.

### "Promote to Document" action

Right-click an AI block → **"Promote to Document"**:

1. Parse the `response` field as markdown
2. Insert the resulting nodes into the document at the block's position
3. Remove the `ai-block` fenced node

The document now contains the content as normal prose — indistinguishable from human-written text. The AI block is gone. This is the portability story: content worth keeping gets promoted into the document body. The fenced YAML block is a scratchpad artifact, not a portable document format.

---

## 4. Migration Strategy — Strangler Fig

No big-bang file conversion. Two extensions run side by side; documents self-migrate on first save.

### 4.1 New Extension: `AiBlock`

**Parse + serialize + render only.** The extension has no knowledge of AI jobs, status transitions, or lifecycles. It renders whatever attrs are present.

**Parse:** markdown-it fence rule intercepts language tag `ai-block`, calls `window.jsyaml.load()` on the fence content, maps fields to `aiBlock` node attrs. Done.

**Serialize:** writes the fenced YAML format from node attrs. This is the only write path — `AiBlockLegacy` has no serializer.

**NodeView:** renders based on `attrs.status`. `PENDING` → spinner. `COMPLETE` → response content. `TIMEOUT` → retry badge. The NodeView does not know how status changes — it just renders the current value. Chain highlighting, toggle behaviour, and keyboard shortcuts are unchanged.

### 4.2 Legacy Extension: `AiBlockLegacy`

Parse-only. No serializer.

Moves the existing `updateDOM` logic (the `[!ai]...[!ai-end]` DOM mutation) into a dedicated extension. Produces the same `aiBlock` node as `AiBlock`, mapping:

| Legacy field | YAML field |
|-------------|-----------|
| `id="..."` attr on opening tag | `id` |
| `ref="..."` attr on opening tag | `ref` |
| Text of `aiQuestion` child node | `question` |
| Content after `<hr>` divider | `response` (serialized back to markdown string) |
| Presence of `(thinking…)` text | `status: PENDING` |
| Otherwise | `status: COMPLETE` |

Because TipTap serializes the full document on every WYSIWYG save, any document opened with legacy blocks is written back in fenced YAML automatically — no migration script, no bulk conversion.

### 4.3 Removal Condition

`AiBlockLegacy` can be deleted when no `[!ai]` tags remain in the filestore:

```go
count := store.GrepAllDocuments(`\[!ai\]`)
fmt.Printf("%d documents still contain legacy AI blocks\n", count)
```

Once count reaches zero, delete the extension and remove the legacy `[!ai]` regex from `extensions.js` (`getCleanMarkdown`).

---

## 5. YAML as Storage Format, Node Attrs as Runtime

The fenced YAML is the **on-disk representation only**. At parse time the extension extracts every field from the YAML payload and maps it to a ProseMirror node attribute. The YAML string itself is not stored as node content — it is discarded after parsing.

The extension is a pure renderer. It never updates attrs in response to AI job events — it only re-renders when the document is reloaded from disk.

```js
// Parse: YAML → node attrs (extension's only input)
const data = window.jsyaml.load(token.content)
// data = { id, ref, status, question, response, model, createdAt, completedAt }

// Serialize: node attrs → YAML (extension's only output)
function serializeAiBlockYaml(attrs) {
  const lines = []
  lines.push('id: ' + attrs.id)
  lines.push('ref: ' + (attrs.ref || 'doc'))
  lines.push('status: ' + (attrs.status || 'PENDING'))
  if (attrs.model)       lines.push('model: ' + attrs.model)
  if (attrs.createdAt)   lines.push('createdAt: ' + attrs.createdAt)
  if (attrs.completedAt) lines.push('completedAt: ' + attrs.completedAt)

  const q = attrs.question || ''
  if (q.includes('\n')) {
    lines.push('question: |')
    q.split('\n').forEach(l => lines.push('  ' + l))
  } else if (q) {
    lines.push('question: ' + q)
  }

  const r = attrs.response || ''
  if (r) {
    lines.push('response: |')
    r.split('\n').forEach(l => lines.push('  ' + (l || '')))
  }

  return lines.join('\n')
}

state.write('```ai-block\n' + serializeAiBlockYaml(node.attrs) + '\n```')
```

At runtime all attrs are first-class ProseMirror properties. The NodeView sets `data-ai-id` from `node.attrs.id`. Finding a block by ID is unchanged:

```js
document.querySelector('.ai-block[data-ai-id="' + id + '"]')
```

**Transitions between PENDING and COMPLETE are never done by JS.** Go updates the YAML on disk; JS reloads the document body; the extension parses the updated attrs and the NodeView re-renders. The extension is unaware this happened.

---

## 6. Dependencies

**js-yaml** is required for YAML parsing. It is added to `frontend/package.json` and bundled as a standalone vendor file:

```bash
npm install js-yaml
```

```json
"bundle:jsyaml": "esbuild node_modules/js-yaml/dist/js-yaml.mjs --bundle --format=iife --global-name=jsyaml --outfile=./src/static/vendor/js-yaml.js --minify"
```

Load in `index.html` before extensions:
```html
<script src="/static/vendor/js-yaml.js"></script>
```

Access in extension files as `window.jsyaml.load(str)`.

---

## 7. File Layout Convention

New extensions follow the pattern established by `smart-link-extension.js`: one file per extension in `frontend/src/static/`, loaded as `<script type="module">` in `index.html`, exported by attaching to `window.TipTap`.

New files for this migration:
- `frontend/src/static/ai-block-extension.js` — `AiBlock` (canonical, fenced YAML)
- `frontend/src/static/ai-block-legacy-extension.js` — `AiBlockLegacy` (parse-only shim, temporary)

`extensions.js` is legacy and will shrink over time as extensions are extracted. No new work goes there. The `AiQuestion`, `AiBlock`, and `AiShortcuts` definitions move out of `extensions.js` entirely.

---

## 8. Implementation Phases

### Phase A — Go `sieve/aiblock` package *(no UI impact, safe to ship alone)*

1. Create `sieve/aiblock/block.go` — `AiBlockData` struct, `ParseAll`, `Replace`
2. Write `sieve/aiblock/block_test.go` — cover: basic round-trip, nested fences, missing id, multiline response with `---`
3. No wiring yet — package is inert until Phase C

### Phase B — Fenced extension + legacy shim *(can run in parallel with A)*

1. Add `js-yaml` to `package.json`, build vendor bundle, add `<script>` to `index.html`

2. Create `ai-block-extension.js` with `AiBlock`
   - markdown-it fence rule for `ai-block` tag, `jsyaml.load()` of content → node attrs
   - NodeView: renders based on `attrs.status` only — spinner for PENDING, content for COMPLETE, retry badge for TIMEOUT. No callbacks, no job awareness.
   - `serializeAiBlockYaml` serializer
   - `gatherChain`, `AiShortcuts` moved here from `extensions.js`
   - Attach to `window.TipTap`

3. Create `ai-block-legacy-extension.js` with `AiBlockLegacy`
   - Move `updateDOM` parse logic from `extensions.js`
   - No serializer — produces same `aiBlock` node attrs as `AiBlock`
   - Map legacy fields to new schema

4. Register both in `editor.js` — `AiBlock` first, `AiBlockLegacy` as fallback

5. Remove `AiQuestion`, `AiBlock`, `AiShortcuts` from `extensions.js`

6. Update `getCleanMarkdown` in `extensions.js` to strip fenced `ai-block` blocks

7. Smoke test: open legacy doc → renders correctly → save → file now contains fenced YAML

### Phase C — Go handler changes *(depends on A)*

1. Add `BlkID` and `Body` fields to `askRequest` and `explainRequest`
2. Implement `AIService.ResolveAiBlock(noteUUID, blkId, response, model string) error`
3. Update `handleAiAsk` and `handleAiExplain`: save body first, run AI, call `ResolveAiBlock`, broadcast `ai:block-resolved`
4. Wire `AiHandler` to the SSE broadcast function (same pattern as `EmitNotesChanged`)

### Phase D — JS `runAiJob` rewrite *(depends on B + C)*

1. Replace `runAiJob` with new flow: insert minimal `aiBlock` node, serialize body, POST with `blkId` + `body`
2. Add `softReloadContent` and `ai:block-resolved` SSE listener
3. Delete `resolveAiBlock`, `insertAiPlaceholderMarkdown`, `insertAiPlaceholderWysiwyg`
4. End-to-end test: trigger ask, switch tab mid-flight, return — COMPLETE block is present

### Phase E — Cleanup *(after D is stable)*

- Remove `AiBlockLegacy` once filestore grep returns zero
- Remove legacy `[!ai]` handling from `getCleanMarkdown`

### Phase 2 — Go owns the document, JS owns the cursor

**Root cause of the current tab-switch bug:** `resolveAiBlock` in `editor.js` reads `currentEditor` and `currentUuid` (module-level vars) at response time. Switching tabs reassigns both to the new tab. The PENDING block sits on disk forever as `(thinking…)`.

**Architecture:** responsibilities split cleanly by what each side uniquely knows.

| Side | Owns | Because |
|------|------|---------|
| JS | Cursor position, insert location | Only JS knows where the user is in the ProseMirror doc |
| Go | Document content, all writes | Only Go runs the AI and holds the UUID |
| TipTap extension | Rendering | Parses attrs, renders DOM — nothing else |

---

#### JS side — `runAiJob` (editor.js)

JS does the minimum to mark the position and hand off to Go:

1. Generate `blkId` (short random id)
2. Insert an `aiBlock` node at the cursor position via ProseMirror transaction — minimal attrs only:
   ```js
   { type: 'aiBlock', attrs: { id: blkId, ref: ref, question: question, status: 'PENDING', createdAt: now } }
   ```
   The extension renders a spinner immediately because `status === 'PENDING'`.
3. Serialize the current editor body (`lastSyncedBody` — now contains the PENDING block)
4. Fire `POST /api/ai/ask` with `{ content, question, noteUUID, blkId, body: serializedBody }`
5. On response: nothing. Go has already written COMPLETE to disk and broadcast SSE. JS ignores the HTTP response body for the success path.
6. On error (non-2xx): find the block by `blkId` in the editor, set `status: 'TIMEOUT'` via PM transaction to show the retry badge.

**Deleted:** `resolveAiBlock`, `insertAiPlaceholderMarkdown`, `insertAiPlaceholderWysiwyg`, markdown mode special-case — all gone.

No explicit flush before the request. JS sends `body` in the request — Go works from that snapshot directly. No flush race.

---

#### Go side — `handleAiAsk`, `handleAiExplain`

```go
type askRequest struct {
    Content       string   `json:"content"`
    History       string   `json:"history"`
    Question      string   `json:"question"`
    NoteUUID      string   `json:"noteUUID"`
    ImageBlockIds []string `json:"imageBlockIds"`
    BlkID         string   `json:"blkId"`   // NEW — id of the PENDING block
    Body          string   `json:"body"`    // NEW — full doc body including PENDING block
}
```

Handler flow:

```
receive request
→ save Body to disk immediately  (PENDING block is now on disk)
→ run AI (RunAsk / RunExplain — unchanged)
→ AIService.ResolveAiBlock(noteUUID, blkId, response, model)
→ broadcast SSE  ai:block-resolved  { uuid, blkId }
→ return 200
```

`ResolveAiBlock` loads the doc, calls `aiblock.Replace(body, blkId, updatedData)`, saves. The `aiblock` package (see Phase A below) handles the YAML find-and-replace.

---

#### JS SSE listener — `softReloadContent`

```js
document.addEventListener('ai:block-resolved', function(e) {
  var data = JSON.parse(e.detail)
  if (data.uuid !== currentUuid) return   // inactive tab — ignore, initEditor handles it on focus
  softReloadContent(currentUuid)
})

function softReloadContent(uuid) {
  var savedAnchor = currentEditor ? currentEditor.state.selection.anchor : 0
  fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
    .then(function(r) { return r.json() })
    .then(function(data) {
      currentEditor.commands.setContent(parseBodyForMode(data.body, currentMode))
      var maxPos = currentEditor.state.doc.content.size
      currentEditor.commands.setTextSelection(Math.min(savedAnchor, maxPos))
    })
}
```

The PENDING block was already visible at the cursor position (inserted in step 2 above). After `softReloadContent` the same block now has `status: COMPLETE` and `response` populated. The extension re-parses and renders the answer. Cursor is restored. The user never sees a jump.

For inactive tabs: the SSE event is ignored. When the user focuses the tab, `initEditor` fetches from disk — the COMPLETE block is just there.

---

#### Go: `sieve/aiblock` package (prerequisite)

New package. Two functions:

```go
// ParseAll extracts all ai-block fences from a markdown body.
func ParseAll(body string) []AiBlockData

// Replace finds the block with matching ID and rewrites it with updated fields.
func Replace(body string, updated AiBlockData) (string, error)
```

Line scanner tracks fence depth to handle nested fences. Uses existing `gopkg.in/yaml.v2` for parse and marshal. ~150 lines including tests.

### Phase 3 — Interrupted block recovery

Because the YAML block is self-describing, any block left with `status: PENDING` — from a timeout, app close, or tab-switch mid-job — contains everything needed to retry: `question`, `ref`, and `model`.

**Tab-switch mid-job** is handled automatically by the Phase 2 architecture: Go updates the document regardless of JS state. When the user returns to the tab, the editor loads from disk and displays the completed block. No special recovery needed for this case.

**Hard interruptions** (timeout, app quit before Go writes the result):

**Backend responsibilities:**

| Event | Sets |
|-------|------|
| Block inserted (JS flush) | `status: PENDING`, `createdAt` |
| AI completes (Go `ResolveAiBlock`) | `status: COMPLETE`, `response`, `completedAt` |
| CLI timeout (Go handler) | `status: TIMEOUT` |

**NodeView render logic:**

```js
resumeButton.visible = status !== 'COMPLETE' && (status === 'TIMEOUT' || createdAt + cliTimeout < now)
```

**Resume** re-submits `question` + resolved `ref` context through the same AI request code path, reusing the existing block `id`.

### Phase 4 — Promote to Document

Implement the right-click "Promote to Document" action on the `AiBlock` NodeView:
- Parse `attrs.response` as markdown via the editor's existing markdown parser
- Insert resulting nodes at block position via ProseMirror transaction
- Delete the `aiBlock` node

### Phase 5 — Cleanup

- Remove `AiBlockLegacy` once filestore grep returns zero
- Remove the legacy `[!ai]` regex from `getCleanMarkdown` in `extensions.js`
- Remove `AiQuestion` node type (no longer needed — question lives in attrs)

---

## 9. Edge Cases

- **Malformed YAML:** if `jsyaml.load()` throws, render a degraded block showing a parse error badge. Do not crash the editor.
- **PENDING block with no response attr:** NodeView renders a thinking indicator from `status: PENDING`. No placeholder text is injected into the document.
- **`---` in response content:** safe. The YAML `|` block scalar indents all content two spaces. YAML only recognises `---` as a document separator at column 0.
- **Chain refs:** `ref` comma-separation semantics unchanged. `gatherChain` reads from the DOM attribute (`data-ai-ref`), which the NodeView sets from `node.attrs.ref`.
- **Legacy `---` collision:** documents already corrupted by the `---` issue are handled best-effort by the legacy parser. The fenced format eliminates this class of bug for all new blocks.
- **Auto-migration and markdown mode:** in markdown mode, saves use `lastSyncedBody` directly rather than TipTap serialization. Legacy blocks in documents habitually opened in markdown mode will not auto-migrate via save. The `GrepAllDocuments` removal check handles this correctly — `AiBlockLegacy` stays until count reaches zero regardless of cause.
- **Tab-switch before AI returns (current bug):** `resolveAiBlock` in `editor.js` reads `currentEditor`/`currentUuid` at response time. Switching tabs reassigns both, so the PENDING block is never resolved — it sits on disk as `(thinking…)`. This is fully eliminated by the Phase 2 Go-side update architecture.
