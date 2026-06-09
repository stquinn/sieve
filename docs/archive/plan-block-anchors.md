# Plan: Migrating AI Context Blocks to Block Anchors

The goal is to bring AI Chain Context Retrieval entirely into the Go backend, moving away from parsing the document state in the frontend.

## 1. Architectural Distinction: Anchors vs. Sieve Blocks

Previously, there was a question of whether `[!block]` should be integrated into the existing **Sieve Block Framework**.

- **Sieve Blocks** exist to contain and process **Data**. They offer functionality and enrichment, backing active UI components (e.g., executing code, resolving links, streaming AI imagery). They have an active lifecycle, state, and a registered `BlockProcessor`.
- **`[!block]`** is entirely different: it is an **Anchor**. It does not have an active lifecycle, state, or data payload. It merely marks a selection of structural text within the document so it can be referenced as context in an AI chain.

Therefore, we will **not** wedge this into the Sieve Block Framework or the `BlockProcessor` registry. Instead, it will be treated purely as an AST structural element via a standalone Goldmark extension. We will refer to these markers internally as **Block Anchors**.

## 2. Proposed Architecture: Block Anchors

The frontend TipTap editor currently saves its selections by wrapping Markdown like so:

```markdown
[!block] id="blk-1234"

... arbitrary markdown paragraphs or content ...

[!block-end]
```

Because this syntax spans multiple lines and wraps arbitrary inner Markdown (which itself needs to be parsed), it is a **Container Block** in Markdown terminology.

### A. Dedicated Goldmark Extension (`sieve/block_anchor.go`)
We will create a new, lightweight Goldmark parser extension focused solely on these anchors.
- **AST Node**: Create `BlockAnchorNode` that embeds `ast.BaseBlock` (allowing it to be a container for paragraphs, lists, etc.) and stores the `ID`.
- **BlockParser**: Implement `blockAnchorParser` conforming to Goldmark's `parser.BlockParser` interface:
  - **`Trigger()`**: Fires when it sees `[` followed by `!block]`.
  - **`Open()`**: Parses the `id`, creates the `BlockAnchorNode`, and starts parsing child block elements.
  - **`Continue()`**: Defers to child parsers for the inner content.
  - **`Close()`**: Finalizes the node when it hits the `[!block-end]` line.

### B. Update EditorService / Markdown Parser
We will attach this new extension to the primary Goldmark parser used by the backend in `sieve/markdown_parser.go`. This means whenever the document is parsed, `BlockAnchorNode` elements are natively and robustly represented in the tree.

### C. Context Retrieval API (`sieve/block_anchor.go`)
We will provide a simple API for the AI service to call when it needs context to send to the LLM:

```go
// ExtractAnchorContent parses the markdown, finds the BlockAnchorNode with the matching ID,
// and renders its children back to clean markdown for the AI context window.
func ExtractAnchorContent(markdown, anchorID string) (string, error) {
    // ...
}
```

## 3. Why this approach?

- **Separation of Concerns**: Sieve Blocks remain dedicated to complex, data-driven components. Anchors remain lightweight structural markers.
- **Robustness**: By using a native Goldmark container parser, we ensure that complex nested Markdown inside the selection (like code blocks, lists, or tables) is perfectly preserved. It avoids the brittleness of regular expressions that might accidentally match string literals inside code blocks.
- **Simplicity**: There is no need to pollute the Processor Registry with a dummy processor that does no processing.
