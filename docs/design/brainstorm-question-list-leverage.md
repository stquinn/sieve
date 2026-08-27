# Brainstorm: leverage from the question-list machinery (#101 close)

Captured 2026-08-27, at the close of epic #101 (question becomes `List<Block>`,
pointing is a kind of block, `rel` is the authored role). These are directions the
epic's machinery makes cheap, recorded before the context that produced them is
gone. None are commitments.

## The provenance invariant (write-down, not an idea)

**Nothing foreign is fetched at prompt-composition time.** Everything the model
sees is either (a) content the author placed locally — the question body and
local targets, inlined — or (b) an explicit, loggable MCP fetch (`get_by_uri`)
the model performed against an offer (the attachments manifest, a foreign
target's in-place reference). The prompt's content provenance is therefore fully
reconstructible: author-placed content + the MCP fetch log = exactly what the
model saw.

This fell out of the #101 design conversation (foreign targets render in place;
the manifest's no-fetch discipline extended to the target slot). It is an
INVARIANT to defend, not an optimization: #42's prompt-recomposition experiments
must not trade it away silently.

## 1. Transclusion ("virtual embed") — best power-to-cost

Resolve address → get block → render full-anatomy via the renderer registry with
`readOnly` set. Every piece exists post-#101. A reference block rendered
as-if-in-document gives live transclusion (bare = re-reads; the glow/lineage
affordances gain a local hook) and frozen quotes (pinned = the cited version)
with zero new model concepts — it is renderer behaviour on the existing
reference kind. Also retroactively completes the foreign-target story.

## 2. The exchange as a general derivation record

An ai-block is inputs-with-roles → output, complete in isolation, replayable.
`resolveChain` already classifies by geometry, not type ("a future DATA → GRAPH
→ AI chain classifies correctly with no change"). If the answer side becomes
`List<Block>` (the open symmetry question), the same record shape covers data
queries, diagram renders, code execution — one uniform "computed-from" record
with provenance built in, runnable by the existing job engine. Do not build
speculatively; do keep #102 from specializing the shape to conversation.

## 3. A typed-edge graph, harvestable today

Every reference element carries an address plus an authored role. Folding that
harvest across a library yields a cross-document knowledge graph — edge types
included — from storage that already exists: no new index, no new authoring
gesture. A backlinks panel or graph lens is a read-only consumer of #101
machinery; the unwired GC producer is the natural first consumer.

## 4. The showcase note as an institution

`sieve/block/processors/testdata/question-list-showcase/` is one artifact that
is simultaneously Go fixture, JS fixture, app-drive target, and the human UAT
surface — and it caught real defects at three layers (element-id prompt leak,
mermaid's data-id stamping, the `.meta` type bug). Convention worth adopting:
every epic ships its showcase note; the collection is a living examples library
CI keeps honest, and could eventually surface in-app.

## 5. The eval harness #112 lacked is now cheap

The fold is pure over observables; questions are structured; bare references
resolve current-at-replay. Prompt experiments (#42: free-order, recomposition)
become policy swaps over a corpus of real recorded exchanges — re-fold, diff the
rendered prompts, eval the answers — using the absolute-golden infrastructure as
the harness. The blast-radius blindness that made prompt changes risky is
structurally gone.
