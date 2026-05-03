# Specification: AI Block Migration to Fenced JSON Format

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
- `[!ai-end]` going missing has caused rendering corruption
- The in-flight placeholder during AI generation is string-injected markdown pretending to be a data structure, then regex-replaced on completion — fragile and hard to reason about
- Not standard Markdown — renders as raw text in any other editor
- Inconsistent with the planned approach for Diagram blocks and Rich Link cards

**Goal:** migrate to a fenced JSON block format. All fields are explicit named properties — no delimiter conventions that can collide with content.

---

## 2. New Format

````markdown
```ai-block
{
  "id": "abc123",
  "ref": "doc",
  "status": "complete",
  "question": "What is the **strangler fig** pattern?",
  "response": "It's a migration strategy where you:\n\n1. Build the new thing alongside the old\n2. Route traffic gradually\n3. Delete the old once empty",
  "model": "claude-sonnet-4-6",
  "createdAt": "2026-05-02T10:00:00Z"
}
```
````

### Why JSON is safe for markdown content

Markdown inside a JSON string value is preserved exactly. `JSON.stringify` / `json.Marshal` escape only what JSON requires (`"` → `\"`, `\` → `\\`, newlines → `\n`). Markdown characters (`*`, `#`, `` ` ``, `_`) pass through unescaped. Triple backticks inside a string value cannot terminate the fence because they are not on their own line.

### Schema

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID, unique per block |
| `ref` | string | Comma-separated block IDs for chain highlighting. `"doc"` means anchored to document root |
| `type` | string | `"ASK"` \| `"EXPLAIN"` \| … extensible — drives badge label and any type-specific UI |
| `status` | string | `"PENDING"` \| `"COMPLETE"` \| `"TIMEOUT"` |
| `question` | string | The prompt sent to the AI. Markdown string |
| `response` | string | The AI's response. Markdown string. Empty when status is not `COMPLETE` |
| `model` | string | Model ID used for this response |
| `createdAt` | string | ISO 8601 timestamp — set when block is inserted |
| `completedAt` | string | ISO 8601 timestamp — set when response is written. Absence confirms incomplete |

Fields are open — additional metadata (token counts, temperature, etc.) can be added without a format change.

---

## 3. AI Blocks as Reasoning Artifacts

AI blocks are **scratchpad containers**, not document content. They capture a moment of reasoning — a question asked and an answer received — embedded in the document as a reference object.

When an AI response produces something worth keeping as first-class document content, the user explicitly **promotes** it. This is a deliberate act, not automatic.

### "Promote to Document" action

Right-click an AI block → **"Promote to Document"**:

1. Parse the `response` field as markdown
2. Insert the resulting nodes into the document at the block's position
3. Remove the `ai-block` fenced node

The document now contains the content as normal prose — indistinguishable from human-written text. The AI block is gone. This is the portability story: you don't need the raw file to be readable in other editors, because content worth keeping gets promoted into the document body.

This replaces the "Accept" concept from the feature backlog and gives it a concrete trigger and implementation path.

---

## 4. Migration Strategy — Strangler Fig

No big-bang file conversion. Two extensions run side by side; documents self-migrate on first save.

### 4.1 New Extension: `AiBlock` (well not new in name but new in implementation - assume the AiBlock name)

Full parse + serialize. Handles the fenced JSON format.

**Parse:** markdown-it fence rule intercepts language tag `ai-block`, parses JSON payload, produces the `aiBlock` ProseMirror node with attributes from the JSON fields.

**Serialize:** writes the fenced JSON format. This is the only write path — `AiBlockLegacy` has no serializer.

The NodeView, chain highlighting, toggle behaviour, and keyboard shortcuts are **unchanged** — they operate on the `aiBlock` node type regardless of how it was parsed.

### 4.2 Legacy Extension: `AiBlockLegacy`

Parse-only. No serializer.

Moves the existing `updateDOM` logic (the `[!ai]...[!ai-end]` DOM mutation) into a dedicated extension. Produces the same `aiBlock` node as `AiBlockFenced`, mapping:

| Legacy | JSON field |
|--------|-----------|
| `id="..."` attr | `id` |
| `ref="..."` attr | `ref` |
| Text before `---` | `question` |
| Text after `---` | `response` |
| Presence of `(thinking…)` | `status: "thinking"` |

Because TipTap serializes the full document on every save, any document opened with legacy blocks is written back in fenced JSON automatically — no migration script, no bulk conversion.

### 4.3 Removal Condition

`AiBlockLegacy` can be deleted when no `[!ai]` tags remain in the filestore:

```go
count := store.GrepAllDocuments(`\[!ai\]`)
fmt.Printf("%d documents still contain legacy AI blocks\n", count)
```

Once count reaches zero, delete the extension and the legacy regex from `extensions.js`.

---

## 5. JSON as Storage Format, Node Attrs as Runtime

The fenced JSON is the **on-disk representation only**. At parse time the extension extracts every field from the JSON payload and maps it to a ProseMirror node attribute. The JSON string itself is not stored as node content.

```js
// Parse: JSON → node attrs
const data = JSON.parse(token.content)
// node.attrs = { id, ref, type, status, question, response, model, createdAt, completedAt }

// Serialize: node attrs → JSON
const payload = JSON.stringify({
  id: node.attrs.id,
  ref: node.attrs.ref,
  // ... all attrs
}, null, 2)
state.write('```ai-block\n' + payload + '\n```')
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

Updating a block on AI completion is a standard attribute transaction — find the node by `id`, set `status`, `response`, `completedAt`. No string manipulation, no regex.

---

## 6. File Layout Convention

New extensions follow the pattern established by `smart-link-extension.js`: one file per extension in `frontend/src/static/`, loaded as `<script type="module">` in `index.html`, exported by attaching to `window.TipTap` (e.g. `T.AiBlockFenced = AiBlockFenced`).

`extensions.js` is legacy and will shrink over time as extensions are extracted. No new work goes there.

New files for this migration:
- `frontend/src/static/ai-block-extension.js` — `AiBlockFenced` (canonical)
- `frontend/src/static/ai-block-legacy-extension.js` — `AiBlockLegacy` (parse-only shim, temporary)

---

## 6. Implementation Phases

### Phase 1 — Fenced extension + legacy shim

1. Create `ai-block-extension.js` with `AiBlockFenced`
   - markdown-it fence rule for `ai-block` tag, JSON.parse of content
   - Serialize to fenced JSON
   - Attach to `window.TipTap` as `T.AiBlockFenced`

2. Create `ai-block-legacy-extension.js` with `AiBlockLegacy`
   - Move `updateDOM` parse logic from `extensions.js`
   - No serializer
   - Map legacy fields to JSON schema fields on the node

3. Register both in `editor.js` — `AiBlockFenced` first, `AiBlockLegacy` as fallback

4. Smoke test: open a legacy document, confirm render. Save. Confirm file now contains fenced JSON.

### Phase 2 — Fix AI block creation

Replace the string-injection approach in `editor.js`:

```js
// Current — inserts raw markdown string, then regex-replaces it on completion
var block = '\n\n[!ai] id="' + blkId + '" ref="' + ref + '" thinking="true"\n...\n[!ai-end]\n\n'
```

Replace with a ProseMirror command that inserts an `aiBlock` node directly with `status: "thinking"`. On completion, find the node by `id` attribute via a document traversal and update it with a transaction — no regex, no string replace.

### Phase 3 — Interrupted block recovery

Because the JSON block is self-describing, any block left with `status: "thinking"` — from a timeout, app close, or network failure — contains everything needed to retry: `question`, `ref`, and `model`.

The Go backend owns all status transitions. When the AI request settles — completion or timeout — it returns the complete updated JSON payload. The frontend applies it directly to the node via ProseMirror transaction. No inference, no date math on the frontend for normal flows.

**Backend responsibilities:**

| Event | Sets |
|-------|------|
| Block inserted | `status: "PENDING"`, `createdAt` |
| AI completes | `status: "COMPLETE"`, `response`, `completedAt` |
| CLI timeout | `status: "TIMEOUT"` |

**NodeView render logic:**

```js
resumeButton.visible = status !== 'COMPLETE' && (status === 'TIMEOUT' || createdAt + cliTimeout < now)
```

`COMPLETE` hides the button. `TIMEOUT` always shows it. `PENDING` shows it only once the timeout window has elapsed — which covers both normal timeout (backend sets `TIMEOUT` before this triggers) and crash recovery (backend never got to write anything).

**Resume** re-submits `question` + resolved `ref` context through the same AI request code path, reusing the existing block `id`. Identical to a new request with a pre-existing block ID — no special recovery logic needed.

### Phase 4 — Promote to Document

Implement the right-click "Promote to Document" action on `AiBlockFenced` NodeView:
- Parse `response` field as markdown via the editor's existing markdown parser
- Insert resulting nodes at block position via ProseMirror transaction
- Delete the `aiBlock` node

### Phase 5 — Cleanup

- Remove `AiBlockLegacy` once filestore is clean
- Update `stripAiBlocks` regex in `extensions.js` to match fenced `ai-block` blocks
- Remove the legacy `[!ai]` regex (line 56 of current `extensions.js`)

---

## 7. Edge Cases

- **Malformed JSON:** if the fenced content fails `JSON.parse`, render a degraded block showing a parse error badge. Do not crash the editor.
- **Thinking state during auto-save:** with Phase 2 in place, the in-flight node is a real ProseMirror node updated via transaction. Auto-save serializes its current state (`status: "thinking"`, empty `response`) cleanly. On completion the node is updated and the next save writes the full response.
- **Chain refs:** `ref` comma-separation semantics unchanged. `gatherChain` reads from the DOM attribute (`data-ai-ref`), which the NodeView sets from `node.attrs.ref`.
- **Nested AI blocks:** not currently supported. Migration does not change this.
- **Legacy `---` collision:** documents that already have corrupted blocks due to the `---` issue are handled best-effort by the legacy parser. The fenced format eliminates this class of bug entirely for all new blocks.
