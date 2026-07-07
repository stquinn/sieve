# Block Search: server-side structured query over the block graph

> **Status: idea / not started.** Worthwhile and to be done — but **enabled by** the Block Document Model, not part of delivering it. Library search already covers the doc-level, full-text need today; this is the block-level, *structured* successor for when cross-note querying becomes a priority. Spun out of Stage F of [`docs/design/archive/plans/2026-06-17-block-document-model.md`](archive/plans/2026-06-17-block-document-model.md) (the search half — F.1/F.2). The lineage/lens half of Stage F (F.3/F.4) is a separate idea, gated on the reconciler project.

## The Core Idea

Once a document is an addressable **tree of blocks** (each with an id, a kind, and ref edges), the whole corpus becomes something you can **interrogate by structure**, not just by words. Block Search is a **server-side index over the block graph** that answers questions like:

- "Show me every **AI answer** that mentions *hero*."
- "What **references** this block?" / "What does this answer **derive from**?"
- "Every **diagram** block across all notes."
- "All **code** blocks in Go that reference this design note."

That is a different capability from full-text search: it filters and traverses on the *structured dimensions* every block carries.

## Three ideas in the name

**Server-side.** The index and query run in **Go**, where the data lives — so it works across **all notes at once** and scales with the corpus. Aligns with the long-term direction (Go server + S3 store + web/mobile clients): clients ask the server "find X," they don't load everything to search locally.

**Tree.** It indexes **blocks**, not flat lines. A hit is "block `ai-d63e` in note Foo," not "line 42." This is only possible *because* the block model gives every block a stable id — there were no addressable blocks to index before.

**Facets.** The payoff, and what "not just full text" means. Beyond matching words, query the structured dimensions:
- **kind** — `ai-block` / `diagram` / `code` / `smart-image` / `prose` …
- **handle / id** — resolve or jump to a block by id.
- **ref edges** — the point-to-point graph: who references this block, what a block derives from, the chain. (Same graph the AI ref-chain resolver already walks; facet search makes it *queryable* rather than only traversed at prompt time.)

Combined with full text it composes: *"AI answers (kind=ai-block) mentioning 'hero' that reference an image block."* Faceted search, where the facets are kind, id, and relationships.

## Why it matters

For a scratchpad-first thinking tool — and for an architect user — *"find all the reasoning that touches this diagram"* or *"every block that references this note"* turns a pile of notes into a navigable knowledge graph. It's the kind of foundational backend capability that makes the block model pay off as a *corpus*, not just per-document.

## What we already have (and why this isn't urgent)

**Library search** already exists and is **server-side** — but it's doc-level / full-text. That covers "find the note that says X" today, which is why Block Search is **not mission-critical yet**. It becomes valuable the moment the need shifts from *"find the note"* to *"find/relate the blocks across notes by kind and reference."*

## Relationship to the Block Model

**Enabled by, not part of.** Block Search depends on the model already delivered — addressable blocks (ids), kinds, and the ref graph — but it adds no requirement to the model itself. It's a consumer of the model, downstream. Nothing in the block-document-model delivery is blocked on it; it's a feature to build on top when prioritised.

## What it could look like (sketch, not a plan)

- `sieve/block/block_index.go` (or a `services`-level indexer) — walk the block tree across the library → a **full-text + facet index** keyed by `{noteUUID, blockId}`, with secondary indexes on `kind` and on **ref edges** (forward: a block's refs; reverse: who references it).
- A query surface: `{ text?, kind?, refersTo?, referencedBy?, … }` → ranked `{noteUUID, blockId}` hits, each resolvable to its block via the existing `DocView.GetBlock` / codec.
- Incremental update: re-index a note's blocks on save (the editor already flushes per-block ops; the index can subscribe).
- Reuse: the ref-edge facet is the same point-to-point graph `AIBlockProcessor.resolveChain` walks — one graph, two consumers (prompt assembly + search).

## Explicitly out of scope here

- **Lineage lenses / doc-map / dirty-glow** (Stage F.3/F.4) — the *visual* projections over the id-graph, and the live "this block is stale" indicator that couples to the separate **reconciler** project. A different idea; do not entangle.
- Ranking/relevance tuning, fuzzy matching, embeddings/semantic search — later refinements, not the first cut.

## Status

| Piece | Status |
|---|---|
| Doc-level full-text (Library search) | ✅ Exists, server-side |
| Block-level full-text index | Not started |
| Facet queries (kind / handle / ref edges) | Not started |
| Lineage lenses / dirty-glow | Separate idea, reconciler-gated |
