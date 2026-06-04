# Block Lifecycle: Upgrade and Harden

## The Core Idea

Sieve blocks exist on a spectrum between **dumb markdown** and **live intelligent objects**. A user should be able to move an asset along that spectrum in both directions.

```
Standard Markdown  ←→  Smart Block  ←→  Hardened Markdown
  (portable)             (live AI)         (frozen artefact)
```

---

## Upgrading: Standard → Smart

A plain markdown image like:

```
![Hugo Keenan experienced heartbreak against UBB](/path/to/img.jpg)
```

is just static text. The user can right-click it and choose **Upgrade to Smart Image**, which:

1. Wraps it in a `sieve-smart-image` fenced block
2. Triggers the AI pipeline — description generation, alt text enrichment, etc.
3. The image is now a live block: editable attrs, AI-enrichable, context-aware

The same pattern applies to any block type. A plain URL could become a Web Clip. A plain code snippet could become a Code Block with language detection and AI explanation. The underlying principle is:

> Standard markdown is the raw material. A Smart Block is what Sieve does with it.

---

## Hardening: Smart → Markdown (Convert to Markdown)

The reverse path also matters. "Promote to Document" is really **Convert to Markdown** — taking a living intelligent block and freezing it into durable, portable markdown.

The AI's work is not lost — it is baked in:

| Block | Hardens to |
|---|---|
| SmartImage | `![AI-generated description](src)` |
| Web Clip | `[Title](url)` |
| Code Block | standard ` ``` ` fence with language tag |
| AI Block | the response as plain markdown prose |

The result can go anywhere — any markdown renderer, any editor, any tool. The intelligence has been **graduated into content**.

---

## Why This Matters

- **Upgrade** means Sieve can always add value to existing content. Users don't need to author smart blocks from scratch — they can start with what they have.
- **Harden** means Sieve is never a lock-in. A document that has been through the AI pipeline produces something durable and self-contained.
- Together they form a **reversible, non-destructive workflow**: enrich when you want intelligence, export when you want portability.

---

## The Chain Problem: AI Blocks Are Not Independent

A single AI Block hardens trivially — take the response text, emit it as markdown prose. But AI Blocks are almost never singular. They form **chains**: a sequence of questions, explains, follow-ups, each building on the last.

A chain is not a list of answers. It is an **enrichment arc** — the user has been probing a topic from multiple angles, accumulating context and understanding. The naive convert (flatten each block to its response text in sequence) produces a transcript, not a document.

### The Bigger Idea

Once a chain has run its course, the user has something richer than any individual block: they have the full context of what was asked and what was learned. **Convert to Markdown on a chain could synthesise the entire arc into a single coherent section** — not a dump of responses, but a rewrite that incorporates everything the chain explored.

This is the same operation as **Rewrite Section** (backlog), but triggered by conversion rather than as a standalone action. The difference is intent:

- **Rewrite Section** = "I want to improve this existing prose"
- **Chain → Convert to Markdown** = "I've finished exploring, now synthesise what I learned into the document"

In both cases the AI has the full chain context. In both cases the output is polished prose that replaces the exploratory scaffolding. They may converge into the same underlying operation with different entry points.

### What This Could Look Like

```
[!block] id="blk-001"
  Some prose or content        ← the focal subject
[!block-end]

[AI Block] Explain this        ← chain focused ON the anchor
[AI Block] What about Y?
[AI Block] How does this relate to Z?

           ↓ Convert to Markdown (operating on block + chain)

Rewritten prose incorporating everything
the chain learned — replaces the focal section.
Q&A scaffolding is removed.
```

The block anchor identifies **what is being discussed**. The chain builds context **about it**. Convert to Markdown says: take the focal content and the accumulated chain context, synthesise a rewrite of the focal section, and remove the scaffolding.

### Why This Is the Right Shape

- The user does not need to write a summary prompt — the chain already contains the intent
- The AI already has the full context in memory for that chain
- The result is integrated into the document at exactly the right position
- The exploratory scaffolding (Q&A, explains) disappears; the distilled knowledge remains

This is Sieve's core value proposition operating at full depth: **scratchpad thinking that graduates into document content**.

---

## Context Capture: Stored in AI Block vs BlockAnchor Reference

### The Problem BlockAnchor Was Solving

For SieveBlock components, ref IDs work well — they point to stable, identifiable objects. For plain markdown content (a paragraph, a word, a table cell), there is no built-in ID. BlockAnchor was invented to give plain content an identity so an AI block could reference it.

This creates fragility: the user deletes the paragraph. The BlockAnchor is gone. The AI block has a dangling `ref=blk-1234` pointing at nothing.

### Cleaner Approach: Store Context as AI Block Attributes

Instead of injecting a BlockAnchor into the document and pointing at it, capture the context **directly in the AI block's YAML at the time of creation**:

```yaml
question: What does this mean?
context: "this is a sentence with a complicated word"
target: "complicated"
status: PENDING
```

- Self-contained — the AI block has everything it needs
- Deletion-proof — original content can be removed without breaking the block
- Immutable snapshot — records exactly what the user asked about at that moment
- No document modification around the selection — no injected markers

The trade-off is staleness: if the user edits the paragraph after asking, the stored `context` no longer matches the document. This is acceptable — a stale snapshot is better than a broken reference, and it preserves the record of what was actually asked.

### What BlockAnchor Is Now

With context captured in the AI block itself, BlockAnchor reverts to its proper role: **visual and structural scoping**, not context capture.

| Use case | Mechanism |
|---|---|
| AI question about a word or paragraph | `context` + `target` attrs on the AI block |
| AI question about a SieveBlock | `ref=` pointing to the SieveBlock's stable ID |
| Explicit scoping for Convert to Markdown / chain synthesis | BlockAnchor (opt-in, not required) |
| Visual grouping of a chain | BlockAnchor (opt-in) |

BlockAnchor becomes a power-user tool for deliberate document structure, not a plumbing requirement for every AI interaction.

---

## Precision Targeting Within a Block Anchor

The current `[!block]` is block-level — it wraps paragraphs, code, sections. But many AI chain use cases operate at word or phrase granularity. The solution is not a separate inline anchor construct — it is an **optional target marker inside the existing block**.

### The Design

A special delimiter pair (`<:::>...</:::>`) marks the precise target within a block's content:

```
[!block] id="blk-1234"

this is a sentence with a <:::>complicated<:::> word

[!block-end]

[AI Block ref=blk-1234] Define this and suggest simpler alternatives
```

The `BlockAnchorNode` exposes two things to `ContextProvider`:

- **Context** — the full block content (the sentence, paragraph, table cell, whatever was selected)
- **Target** — the text between `<:::>` delimiters (the specific word or phrase in focus)

When no `<:::>` is present, the block behaves exactly as today — context only. Target is purely optional and additive. No behaviour changes for existing usage.

### Why This is the Right Shape

- No new TipTap mark type, no new inline Goldmark parser, no structural changes to block anchors
- The block IS the context; the target tag IS the precision layer — both in one place
- Works naturally for table cells and list items where "parent paragraph" is meaningless — the user selects the cell content as the block, then marks the target word within it
- `ContextProvider` prompt becomes richer automatically: "Given this context: [...] Specifically regarding: [target]"

### TipTap Rendering

The `<:::>` delimiters are replaced in TipTap by a `<span>` with a class that visually matches the left-bracket chain indicator already used for AI chains. The target word is highlighted in the same visual language as the chain it belongs to — no separate affordance needed, the user sees at a glance which word drove which chain.

A lightweight TipTap mark handles rendering only. Serialisation and parsing stay entirely on the markdown/backend side.

### Open Questions

- Delimiter choice: `<:::>` is distinctive but verbose. Worth confirming nothing in standard markdown or existing Sieve syntax collides with it.
- Multiple targets: can a single block have more than one `<:::>` range? Probably not for the first iteration — one target per block keeps the AI prompt clean.

---

## Implementation Status

| Feature | Status |
|---|---|
| SmartImage (paste → fenced block) | Done |
| Standard image rendering (`T.Image`) | Re-enabled |
| Upgrade right-click (image → SmartImage) | Not started |
| Convert to Markdown / Promote | Partial — Web Clips degrade to standard markdown images today |
| Per-block harden logic | Not designed |
