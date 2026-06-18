# Node-granular Blocks: the block list mirrors PM's top-level nodes 1:1

**Status:** Approved design (2026-06-18). Amends the prose-granularity decisions in
`2026-06-18-block-document-model-d4-design.md` (the D.4 spec). Everything in D.4
about the comment-tag storage tree, paired `<!--s:ID-->` delimiters, opacity, and
the shadow doc being authoritative **still holds**. The single thing this changes:
a prose block is **no longer a multi-paragraph container** — each top-level PM node
is its own block.

## The principle

**A block is one top-level ProseMirror node. Its content is whatever markdown PM
put there — we do not categorise it.** PM owns everything *inside* a node (one node
or many, paragraph or list, hard breaks, trailing spaces). Sieve's only job is to
mirror PM's **top-level node list** into the ShadowDoc, 1:1:

- PM creates a top-level node → `create-block`.
- PM edits a node's content → `update-block`.
- PM removes a node → `delete-block`.

Content = that node's markdown, bracketed by its `<!--s:ID-->…<!--/s:ID-->` pair.
That's the whole contract. There is no per-kind enumeration, no bespoke split/merge
logic — "do what PM wants; if PM makes 2 nodes, we have 2 blocks."

## What this corrects

The block-model refactor made `sieve-prose` a `content: 'block+'` **container**: PM's
paragraphs/headings/lists became *children* of one block under one id. Consequence:
Enter added an anonymous paragraph *inside* the single block, so all of a user's
prose collapsed to **one targetable unit** — an AI question on a paragraph degraded
to a whole-document question; the gutter showed one line for the whole run. This
spec restores **node granularity** (the pre-refactor behaviour) inside the clean
delimited-block storage.

## Whitespace

Whitespace is **non-semantic string material**. It is preserved verbatim if it ends
up inside a node's content (manual markdown, Shift+Enter hard breaks, trailing
spaces), because the markers bracket the entire node content — but it is **never**
structure. Sieve does not split, normalise, or interpret it. No "whitespace as
delimiter," no single-paragraph-+-hard-breaks model: that question dissolves once
each node is its own delimited block.

## Editor behaviours (all fall out of the principle — nothing intercepted)

- **Enter** in a paragraph → PM `splitBlock` → a *new top-level node* → **new block**
  (new id, new gutter line, independently targetable).
- **Enter** inside a list/table → PM keeps it as one list/table node → **same block**.
- **Shift+Enter** → hard break inside the current node → **same block**; the break is
  whitespace content between that block's markers.
- If some extension/keymap makes PM treat a span of content as one node, it is one
  block. We follow PM.

## Schema: dissolve the container

The `sieve-prose` *container* is removed. The doc top level holds PM's block nodes
**directly**, each a member of group `sieveBlock` and carrying a block `id`:

- Stock prose-family nodes — `paragraph`, `heading`, `bulletList`/`orderedList`,
  `table`, `blockquote`, … — are admitted at the top level (group `sieveBlock`) with
  an `id` attribute, rather than only inside a container.
- Existing **structured** nodes (`sieve-code`, `sieve-image`, `sieve-diagram`, …)
  are unchanged: they remain `sieveBlock` members with their fence representation.
- `doc` content stays `sieveBlock+`. "All content is blocks" still holds
  structurally — there is just no longer a prose wrapper between the doc and PM's
  nodes.

Two block **families** live under the one `sieveBlock` umbrella:
- **Prose family** (paragraph/heading/list/table/…): marker-delimited
  (`<!--s:ID-->…<!--/s:ID-->`), content is the node's markdown, edited inline.
- **Structured family** (code/image/diagram): fence-delimited, self-opaque, as today.

Identity attribute and gutter/targeting chrome attach to **any** top-level node via a
shared mechanism (a block-id attribute + a decoration-based chrome keyed on the
node's id), not a per-kind NodeView. (Implementation chooses the least-fighting-PM
path; the principle is: chrome decorates the node, identity rides on the node.)

## Identity

`proseIdentity` generalises to **`blockIdentity`**: on a doc change, mint an id for
any id-less top-level prose-family node that has real content; leave empty editing
surfaces and parse artifacts id-less (never delete them — that was the freeze).
Structured blocks keep their existing id provenance. Ids are invisible plumbing,
minted silently; the user never sees a "create block" gesture.

## Sync: the observer mirrors the top-level node list

`computeBlockSync` already diffs the **top-level** blocks by id and emits
`create/update/delete-block`. It keeps doing exactly that — the change is only that
there are now more, smaller top-level blocks (one per node) instead of one prose
container. Content for a prose-family block is its node markdown.

One small refinement: today an id-less block trips the `anyEmptyId` guard and forces
a whole-document `doc-update` fallback. The empty trailing editing surface is id-less
by design, so the diff must treat an **id-less, empty prose-family node as pending**
(skip it, like `isPendingEmptyProse`) rather than as an unaddressable block — so its
presence does not collapse every sync to a fallback. `create-block` still fires on
first content. This is the only sync change.

## Hydration of legacy documents

A document that never followed the block model is hydrated **best-effort** on Open:
- **Legacy block anchors present** → honour them as the obvious block grouping.
- **Otherwise** → let goldmark/markdownit parse the markdown into top-level nodes;
  each parsed top-level node becomes a block and is minted a handle. A hand-written
  file with N blank-line-separated paragraphs therefore opens as **N blocks** (one
  per parsed node) — consistent with the live-edit rule, superseding D.4's
  "undelimited content opens as ONE block."

## Out of scope / deferred

- Container blocks / "blocks all the way up" (a block holding child blocks) remain
  future work; this spec is flat top-level nodes only.
- Sub-node targeting (a single list *item*, a highlighted phrase) is unchanged from
  today; node-granular ids are the new floor, finer targeting layers on later.
- Granular **structured**-block sync (still the doc-update fallback) is unchanged.

## Testing

- **vitest, real PM schema:** Enter splits one prose node into two top-level blocks;
  Shift+Enter stays one block with a hard break; a list stays one block; minting is
  per top-level node and idempotent (no appendTransaction loop — keep the runaway
  guard + stability assertion).
- **vitest, serialization round-trip:** each top-level node ↔ its `<!--s:ID-->`
  markdown; whitespace (hard breaks, blank runs, trailing spaces) survives verbatim;
  structured blocks still fence-serialise.
- **vitest, `computeBlockSync`:** splitting a node emits one `create-block`; editing
  a node emits one `update-block`; deleting emits one `delete-block`; the empty
  trailing surface emits nothing.
- **Manual (WebKitGTK):** type, press Enter, confirm a new gutter line + that AI
  targeting hits the single paragraph; load a legacy markdown file and confirm
  per-node blocks.
