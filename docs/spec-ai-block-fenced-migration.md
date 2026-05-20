# Specification: AI Block Migration to Fenced YAML Format

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

Full parse + serialize. Handles the fenced YAML format.

**Parse:** markdown-it fence rule intercepts language tag `ai-block`, parses YAML payload via `window.jsyaml.load()`, produces the `aiBlock` ProseMirror node with attributes from the YAML fields.

**Serialize:** writes the fenced YAML format. This is the only write path — `AiBlockLegacy` has no serializer.

The NodeView, chain highlighting, toggle behaviour, and keyboard shortcuts are **unchanged** — they operate on the `aiBlock` node type regardless of how it was parsed.

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

```js
// Parse: YAML → node attrs
const data = window.jsyaml.load(token.content)
// data = { id, ref, status, question, response, model, createdAt, completedAt }

// Serialize: node attrs → YAML
function serializeAiBlockYaml(attrs) {
  const lines = []
  lines.push('id: ' + attrs.id)
  lines.push('ref: ' + (attrs.ref || 'doc'))
  lines.push('status: ' + (attrs.status || 'COMPLETE'))
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

At runtime all attrs are first-class ProseMirror properties. The NodeView sets `data-ai-id` from `node.attrs.id` exactly as today. Finding a block by ID is unchanged:

```js
// DOM query — unchanged
document.querySelector('.ai-block[data-ai-id="' + id + '"]')

// ProseMirror traversal — unchanged
doc.descendants((node, pos) => {
  if (node.type.name === 'aiBlock' && node.attrs.id === targetId) { ... }
})
```

Updating a block on AI completion is a standard attribute transaction — find the node by `id`, set `status: COMPLETE`, `response`, `completedAt`. No string manipulation, no regex.

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

### Phase 1 — Fenced extension + legacy shim

1. Add `js-yaml` to `package.json`, build vendor bundle, add `<script>` to `index.html`

2. Create `ai-block-extension.js` with `AiBlock`
   - markdown-it fence rule for `ai-block` tag, `jsyaml.load()` of content
   - NodeView, `gatherChain`, `AiQuestion`, `AiShortcuts` moved here from `extensions.js`
   - Serialize to fenced YAML
   - Attach to `window.TipTap`

3. Create `ai-block-legacy-extension.js` with `AiBlockLegacy`
   - Move `updateDOM` parse logic from `extensions.js`
   - No serializer
   - Map legacy fields to new schema attrs

4. Register both in `editor.js` — `AiBlock` first, `AiBlockLegacy` as fallback

5. Remove `AiQuestion`, `AiBlock`, `AiShortcuts` from `extensions.js`

6. Update `getCleanMarkdown` in `extensions.js` to strip fenced `ai-block` blocks in addition to legacy `[!ai]` blocks

7. Smoke test: open a legacy document, confirm render. Save. Confirm file now contains fenced YAML.

### Phase 2 — Fix AI block creation

Replace the string-injection approach in `editor.js`:

```js
// Current — inserts raw markdown string, then regex-replaces on completion
var block = '\n\n[!ai] id="' + blkId + '" ref="' + ref + '" thinking="true"\n...\n[!ai-end]\n\n'
```

Replace with a ProseMirror command that inserts an `aiBlock` node directly with `status: PENDING` and `question` set from the user input. On completion, find the node by `id` via document traversal and update it with a transaction — no regex, no string replace.

The markdown mode path (`insertAiPlaceholderMarkdown`, `resolveAiBlock` markdown branch) is also replaced at this phase.

### Phase 3 — Interrupted block recovery

Because the YAML block is self-describing, any block left with `status: PENDING` — from a timeout, app close, or network failure — contains everything needed to retry: `question`, `ref`, and `model`.

**Backend responsibilities:**

| Event | Sets |
|-------|------|
| Block inserted | `status: PENDING`, `createdAt` |
| AI completes | `status: COMPLETE`, `response`, `completedAt` |
| CLI timeout | `status: TIMEOUT` |

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
