# Deserialization is a BlockProcessor concern — the mirror of serialization

**Status:** Design direction captured 2026-06-19 (branch `feature/refactor_editor_layout`).
The **serialization** half is BUILT (`BlockProcessor.Serialize`; the save spine walks
blocks and asks each flavour — see [memory `project_serialization_is_a_processor_concern`]).
This note pins the **deserialization** half so it can't get lost. **Not yet implemented.**

## The principle

A flavour owns BOTH sides of its SerDes. Serialization is done:

```
Serialize(block) → text          // dispatch by block.Kind (a map lookup — you know the kind)
```

Deserialization is the mirror, but the dispatch is by **recognition**, not by a known
kind (on the way in you don't know the kind yet — you have to discover it):

```
accepts(input) bool              // does this flavour claim this region?
deserialise(input) → SieveBlock  // build the block from it
```

## How the document parser works

The parser holds the processor **registry** and walks the document's candidate
regions. For each region:

1. ask each processor `accepts(region)` **in priority order**;
2. the **first** processor that accepts it calls `deserialise(region)` → a block;
3. **`ProseProcessor` accepts everything** and is asked **LAST** — the terminal
   mop-up, so anything no structured flavour claimed becomes a prose block.

This is chain-of-responsibility. There is no kind-switch and no special tag-lookup
path: a fenced kind is just a flavour whose `accepts` cheaply checks the fence tag
(`` ```code ``); an untagged smart-paste kind (a bare URL → smart-link, an image →
smart-image) is a flavour whose `accepts` inspects content. **Prose last makes
"everything is a block" hold** — no input is ever unclaimed.

> Ordering rule: prose must be terminal (lowest priority) or it shadows every
> structured recogniser. Structured flavours get first crack; prose mops up.

## It UNIFIES parse and paste-match (the prize)

The processor already has this exact shape — for paste:

```
IsBlock(entries) bool            // == accepts
Transform(entries) → attrs       // == deserialise
```

So **parse-from-disk and paste-from-clipboard are the same operation**: recognise
input, build a block. The brainstorm already said it — *"embed is the inverse of
paste over one representation"* (brainstorm-block-document-model §87). `deserialise`
(parse) and `Transform` (paste) are both **the inverse of `Serialize`, over different
input representations.** The convergence folds them into one recogniser:
`accepts`/`deserialise`, with the clipboard path as one `input` representation and a
markdown region as another.

## The fork: what is `input` (the `any`)?

Do **NOT** make it a goldmark `ast.Node`. That welds every flavour to goldmark, and
the whole point is that **markdown is ONE serialization, not the model** — the Store
seam wants JSON / DB rows / S3 too. Make `input` the **portable recognised region**:

- a fenced region → `{kind, body}` (the literal inverse of what `Serialize` emits),
- an untagged region → raw text / `[]ContentEntry`.

Then `deserialise` is the true inverse of `Serialize` (text→block ↔ block→text),
library-agnostic, and the same processor method works whether the bytes came from
disk-markdown, a clipboard, or a future JSON store.

## goldmark's role shrinks

goldmark (or any markdown reader) stops knowing kinds. Its only job becomes: **split
the document into candidate regions** (fences, prose runs, inline spans) and hand each
to the registry dispatch. The kind-specific parsers we have today —
`sieveBlockParser` / `sieveInlineParser` / `blockAnchorParser`, and the dead/test-only
`ParseAllBlocks` / `FindBlockByID` / `PromoteBlock` byte-mutation — collapse into
`accepts`/`deserialise` on the flavours.

## What it retires (the parse-side audit remainders)

The markdown-usage audit (2026-06-19) found these parse paths OUTSIDE the one document
parser — they fold into this convergence:
- `PromoteBlock` (markdown byte-mutation) → a block op / flavour deserialise.
- `FindBlockByID` (markdown-mode fallback parse) → registry dispatch.
- `BlockAnchorProvider.BuildContext` parsing markdown for `[!block]` → Stage E retire.
- inline `[!kind]` parser → (inline ≠ block; deferred — see `project_inline_not_a_block`).
- `ParseAllBlocks` / `SerializeBlockDoc` (handle-less) → dead/test-only, delete.

## Sequencing

This is the natural successor to the serialization convergence. It is bigger (it
touches the goldmark integration and can absorb the paste path), so it wants its own
plan + TDD, and the round-trip is validated against the REAL parser (see
`project_serialization_is_a_processor_concern` — round-trip tests must use the
production parse path, never a duplicate). It also wants the **container/children**
model (Stage E) settled first, since "an inline thing inside prose" is really "a child
of the prose block".

See [[project_serialization_is_a_processor_concern]], [[project_inline_not_a_block]],
[[project_shadowdoc_uniform_block_refactor]], brainstorm-block-document-model.md,
brainstorm-blocks-all-the-way-up.md.
