# Node-granular Blocks: many prose blocks, one id each

**Status:** Approved design (2026-06-18). Amends the **prose-granularity** decision in
`2026-06-18-block-document-model-d4-design.md` (the D.4 spec). Everything else in D.4
— the comment-tag storage tree, paired `<!--s:ID-->` delimiters, leaf-opacity,
whitespace-is-content, and the shadow doc being authoritative — **still holds.** The
single thing this changes: the document no longer traps the entire prose run in **one**
`sieve-prose` block. It holds **many** prose blocks, one id each.

## What this corrects

The current implementation wraps the whole prose run in a single `sieve-prose`
(`content:'block+'`). Its one handle is therefore the only id for all of it →
**N paragraphs = ONE id.** Because prose is the dominant content type, that means the
**entire document is effectively one targetable unit** — coarse to the point of being
"DOC all the way through." An AI question on a paragraph degrades to a whole-document
question; the gutter shows one line for the whole run.

**`content:'block+'` is not the villain — it is required (see Cement below) and stays.**
The villain is the **single container plus Enter-grows-the-block**: everything PM
creates lands as a child *inside* the one block. The fix is to draw block **boundaries**
so the doc holds many prose blocks, each with its own id.

## The principle

**A block is a top-level region of the document — a `sieve-prose` block or a structured
block. Its content is markdown; we do not categorise it.** A prose block's content may
be a single paragraph (typed) or a whole rich payload of headings/lists/paragraphs
(cemented). The block list mirrors the doc's **top-level blocks** 1:1; **editing decides
where the boundaries fall**:

- A boundary is created → `create-block`.
- A block's content is edited → `update-block`.
- A block is removed → `delete-block`.

Each block is bracketed by its `<!--s:ID-->…<!--/s:ID-->` pair; content between is the
block's verbatim markdown.

## Where boundaries fall

- **Live typing — Enter splits.** Pressing Enter splits the current `sieve-prose` into
  **two `sieve-prose` siblings**, so each typed paragraph becomes its own block (new id,
  new gutter line, independently targetable). The tail mints a fresh handle
  (`splitHandles`, Stage B); Backspace-at-start merges and unions handles
  (`mergeHandles`).
- **Lists / tables — PM keeps them one node → one block.** Enter inside a list adds a
  list *item* (still one list node) → **same block**. We follow PM; a list is one block.
- **Shift+Enter — same block.** A hard break inside the current node; the break is
  whitespace content between that block's markers, never a boundary.
- **Insert a structured block mid-prose — PM-native split-to-place.** A sieve node is
  disallowed in prose content, so PM splits the prose block and drops the structured
  block between as a sibling (the D.4 "insert splits" move, unchanged).

## Cement / embed: a single rich prose block

When smart behaviour finishes and a result is **cemented/embedded** into the document —
a web clip, a large AI answer with markdown throughout — it lands as **one `sieve-prose`
block, one id**, carrying the entire rich markdown payload (multiple headings, lists,
paragraphs). This is the legacy block-anchor behaviour and is exactly why prose keeps
`content:'block+'`: a prose block must be able to hold complex markdown under a single
handle. Cement and live-typing are the **same node kind and schema** — they differ only
in where the boundaries fall (cement draws one boundary around the whole blob; typing
draws one per paragraph).

## Whitespace

Whitespace is **non-semantic string material**, preserved verbatim if it lands inside a
block's content (manual markdown, Shift+Enter hard breaks, trailing spaces) because the
markers bracket the whole content — but it is **never** structure. Sieve does not split,
normalise, or interpret it. No "whitespace as delimiter."

## Schema

`sieve-prose` keeps **`content:'block+'`** (it must carry rich markdown for cement). The
schema barely changes — `doc` is already `sieveBlock+` and already permits **many**
`sieve-prose` siblings. The current single-block behaviour is not a schema constraint;
it is the **render + Enter** behaviour:

- **Render** (Stage D.2): load each shadow prose block into its **own** `sieve-prose`
  node, rather than concatenating the whole run into one.
- **Enter** (Stage D.4): split the enclosing `sieve-prose` into two siblings instead of
  appending a child paragraph. This is the one deliberate keymap — bounded, not a
  per-keystroke whole-tree rewrite.

Two block **families** remain, both `sieveBlock` group members:
- **Prose** (`sieve-prose`): marker-delimited, `content:'block+'`, edited inline.
- **Structured** (`sieve-code`/`sieve-image`/`sieve-diagram`/…): fence-delimited,
  self-opaque, unchanged.

**Open implementation fork (settle in the plan):** whether the prose family stays a
single uniform `sieve-prose` (`block+`) with a **split-on-Enter keymap** (recommended —
one prose representation, prose always able to hold rich markdown), **or** live
paragraphs render as bare top-level nodes (PM-native Enter split) with `sieve-prose`
reserved for cemented rich blocks (more PM-native on Enter, but two prose
representations). Both honour the principle; this is a mechanic choice, not a model
choice.

## Identity

`proseIdentity` generalises to **`blockIdentity`**: on a doc change, mint a handle for
any id-less prose block that has real content; leave empty editing surfaces and parse
artifacts id-less (never delete them — that was the freeze). `splitHandles` /
`mergeHandles` (Stage B, already built and tested) do the split/merge handle math.
Structured blocks keep their existing id provenance. Ids are invisible plumbing.

## Sync: the observer mirrors the top-level block list

`computeBlockSync` already diffs the **top-level** blocks by id and emits
`create/update/delete-block`. It keeps doing exactly that — there are simply now many
small prose blocks instead of one. A split emits one `create-block`; an edit one
`update-block`; a merge one `delete-block`.

One refinement: today an id-less block trips the `anyEmptyId` guard and forces a
whole-document `doc-update` fallback. The empty trailing editing surface is id-less by
design, so the diff must treat an **id-less, empty prose block as pending** (skip it,
like `isPendingEmptyProse`) rather than as unaddressable — so its presence doesn't
collapse every sync to a fallback. `create-block` still fires on first content.

## Hydration of legacy documents

A document that never followed the block model is hydrated **best-effort** on Open:
- **Legacy block anchors present** → honour them as the obvious block grouping (each
  anchored region → one prose block, rich content intact — the cement shape).
- **Otherwise** → let goldmark/markdownit parse into blocks; each parsed top-level node
  becomes a prose block and is minted a handle. (Per D.4, delimiters — not blank lines —
  define blocks at rest; hydration is the one-time best-effort that *assigns* the
  initial boundaries.)

## Out of scope / deferred

- **Container blocks / "blocks all the way up"** (a block holding child *blocks*) remain
  future work; this spec is flat top-level blocks only.
- **Sub-block targeting** (a single list item, a highlighted phrase) is unchanged;
  block-granular ids are the new floor, finer targeting layers on later.
- **Granular structured-block sync** (still the doc-update fallback) is unchanged.

## Testing

- **vitest, real PM schema:** Enter splits one `sieve-prose` into two top-level prose
  blocks; Shift+Enter stays one block with a hard break; a list stays one block; a
  cemented multi-paragraph block stays one block with one id; minting is per block and
  idempotent (keep the runaway guard + a no-loop stability assertion).
- **vitest, serialization round-trip:** each prose block ↔ its `<!--s:ID-->` markdown;
  whitespace (hard breaks, blank runs, trailing spaces) survives verbatim; a rich
  cemented block round-trips under one id; structured blocks still fence-serialise.
- **vitest, `computeBlockSync`:** split → one `create-block`; edit → one `update-block`;
  merge → one `delete-block`; the empty trailing surface emits nothing.
- **Manual (WebKitGTK):** type, press Enter → a new gutter line + AI targeting hits the
  single paragraph; cement a blob → one block/one id; load a legacy file → best-effort
  per-block hydration.
