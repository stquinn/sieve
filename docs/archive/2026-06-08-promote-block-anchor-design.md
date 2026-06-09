# Promote-to-Document: Preserve Chain Continuity via Block Anchor

**Date:** 2026-06-08
**Status:** Approved

---

## Problem

When a sieve block is promoted to a document (e.g., an AI block's response becomes plain markdown), the block is removed from `shadow.Blocks` and its fenced node is replaced with plain text in the markdown file. Any downstream AI block whose `ref` attribute points to the promoted block ID (e.g., `ref: ai-95ab`) loses its context — `BuildContextForID` finds nothing and the chain silently breaks.

---

## Goal

After promotion, content previously at `ai-95ab` must remain addressable by that ID so that existing `ref: ai-95ab` chains continue to work without modification.

---

## Existing Infrastructure (no new code needed)

All required machinery is already in place:

| Piece | Where | What it does |
|---|---|---|
| `[!block] id="..."...[!block-end]` syntax | `markdown_parser.go` | Parses into `blockAnchorNode`; regex accepts any ID format, not just `blk-*` |
| `FindBlockByID` | `markdown_parser.go:527` | Falls back to `blockAnchorNode` when a block isn't in `shadow.Blocks` |
| `BlockAnchorProvider.BuildContext` | `block_anchor.go:24` | Extracts plain text content from a block anchor region |
| `blockRef` TipTap node `updateDOM` | `extensions.js:109` | Converts `[!block]...[!block-end]` paragraphs into `div[data-type="blockRef"]` during markdown parse |
| `softReloadContent(uuid)` | `editor.js:809` | Fetches latest markdown from Go, calls `setContent` (runs full markdown pipeline including `updateDOM`), restores cursor position |

The chain continuity path after this change:
`BuildContextForID("ai-95ab")` → miss in `doc.Blocks` (deleted on promotion) → `FindBlockByID(markdown, "ai-95ab")` → finds `blockAnchorNode{AnchorID: "ai-95ab"}` → `BlockAnchorProvider.BuildContext` → returns promoted content as context. ✓

---

## Design

### Go — `sieve/editor_service.go`, `PromoteBlock()`

Currently:
```go
replacement := processor.MarkdownRepresentation(blkCopy)
newMarkdown, ok := PromoteBlock(shadow.Markdown, blockID, replacement)
// ...
es.notifyBlockPromoted(uuid, blockID, replacement)
```

After:
```go
plainContent := processor.MarkdownRepresentation(blkCopy)
markdownReplacement := plainContent
if plainContent != "" {
    markdownReplacement = fmt.Sprintf("[!block] id=%q\n%s\n[!block-end]", blockID, plainContent)
}
newMarkdown, ok := PromoteBlock(shadow.Markdown, blockID, markdownReplacement)
// ...
es.notifyBlockPromoted(uuid, blockID, plainContent)  // send plain — JS does a soft reload
```

The `notifyBlockPromoted` → `OnBlockPromoted` → WebSocket `block-promoted` message is otherwise unchanged. The `replacement` field in the message now carries `plainContent` (unchanged from today's value — the block anchor wrapping is for the markdown file only).

### JS — `editor.js`, `block-promoted` handler (~line 329)

Currently (~15 lines): finds the sieve node by ID, renders `replacement` to HTML, calls `insertContentAt` with a surgical swap.

After:
```js
if (msg.type === 'block-promoted') {
    softReloadContent(currentUuid)
}
```

`softReloadContent` fetches Go's authoritative markdown (which now contains `[!block] id="ai-95ab"`), calls `editor.commands.setContent(body)` which runs TipTap's full markdown pipeline, `updateDOM` fires and converts the block anchor syntax into a `blockRef` node, cursor is restored. No JS-side block anchor knowledge required.

---

## Data Flow After Change

```
User: "Promote to Document" on ai-95ab
  ↓
sieve:promote-block → WebSocket promote-block
  ↓
EditorService.PromoteBlock(uuid, "ai-95ab")
  ├─ plainContent = processor.MarkdownRepresentation(block)
  ├─ markdownReplacement = "[!block] id=\"ai-95ab\"\n{plainContent}\n[!block-end]"
  ├─ PromoteBlock(markdown, "ai-95ab", markdownReplacement)  ← anchored in file
  ├─ delete(shadow.Blocks["ai-95ab"])
  ├─ Flush to disk
  └─ notifyBlockPromoted(uuid, "ai-95ab", plainContent)
  ↓
WebSocket: { type: "block-promoted", id: "ai-95ab", replacement: plainContent }
  ↓
editor.js: softReloadContent(currentUuid)
  ├─ GET /api/editor/load?uuid=...
  ├─ editor.commands.setContent(markdown)   ← full pipeline; updateDOM fires
  ├─ blockRef node created with id="ai-95ab"
  └─ cursor restored
  ↓
Later: downstream AI block with ref: ai-95ab
  ↓
BuildContextForID("ai-95ab")
  ├─ doc.Blocks["ai-95ab"] → not found
  ├─ FindBlockByID(markdown, "ai-95ab") → blockAnchorNode{AnchorID: "ai-95ab"}
  └─ BlockAnchorProvider.BuildContext → plain text of promoted content ✓
```

---

## Scope

- Changes: 2 files — `sieve/editor_service.go`, `frontend/src/static/editor.js`
- No changes to: parsers, `BlockAnchorProvider`, `FindBlockByID`, TipTap extensions, `blockRef` node, individual processors, `PromoteBlock()` in `markdown_parser.go`
- Empty `MarkdownRepresentation()` result: guard ensures no empty block anchor is written (`if plainContent != ""`)
- All block kinds that support promotion benefit automatically (AI blocks, diagram blocks, code blocks, etc.)

---

## Out of Scope

- Visual styling of the resulting `blockRef` node (block anchors are invisible containers)
- Removing or collapsing the block anchor after the user edits the promoted content
- Migrating existing promoted blocks in documents created before this change
