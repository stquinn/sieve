# Node-granular Prose Blocks — TipTap runs the editor; we observe and tag

**Status:** Approved design (2026-06-19). Branch `feature/refactor_editor_layout`.
**Amends** the prose-granularity *and* editor-behavior decisions in
[`2026-06-18-block-document-model-d4-design.md`](2026-06-18-block-document-model-d4-design.md)
(the D.4 spec). **Supersedes** the deleted `2026-06-18-node-granular-blocks-design.md`
(removed in `b069bde` together with a broken implementation — reverted because the *code*
churned and the spec was thrashing, **not** because the model was wrong).
**Plan:** [`docs/superpowers/plans/2026-06-17-block-document-model.md`](../plans/2026-06-17-block-document-model.md) (Stage D).

## Why this exists / what it corrects

D.4 contradicts itself on editor behavior:

- §"Leaf constraint" (lines 23–28, 49–63) and the identity section make **all prose ONE
  `sieve-prose` leaf** holding every paragraph as *content* (`content:'block+'`).
- Line 165 says **"no split keymap for prose — PM's native Enter/Backspace is fine."**
- Line 251 (§"Editor behavior — split/merge keymap") then **adds a split/merge keymap.**

Both cannot hold. The single-container premise is what *forces* the keymap, and the keymap
is exactly what churned twice — the reverted C–F big-bang and the reverted node-granular
attempt (per-keystroke re-wrapping via `ensureSieveBlockAnchorsAndIds`, runaway id
minting, `requestAnimationFrame(syncSieveChrome)` after `EditorView` destroy → `nodeDOM`
null `descAt` flood).

**Root cause:** wrapping all prose in one `sieve-prose` (`block+`) container makes native
Enter add a child paragraph *inside* the container (the block grows) → "1 doc == 1 block
ID" → a keymap is then bolted on to claw back out into separate blocks. **Remove the
premise and the keymap evaporates.** This spec removes it.

## Governing principle: TipTap runs the editor

ProseMirror/TipTap owns node creation, splitting, merging, and deletion — **natively.**
Sieve does **not** override Enter / Backspace / Delete, does **not** add a split/merge
keymap, and does **not** mutate the document to maintain structure. Sieve does exactly
**two passive things**, neither of which changes editor behavior:

1. **Attaches a `blockId` attribute** to top-level nodes (TipTap's native
   `addGlobalAttributes` — *data on the node*, not a command, not a key override).
2. **Observes transactions** (debounced, read-only) and persists changed top-level blocks
   as `create` / `update` / `delete-block`.

This restores the pre-block-mode behavior the user described: press Enter → PM makes a
node → the gutter shows its number; delete the line → the node and its number vanish. The
gutter already did this by *watching* native nodes; we keep watching.

## The block model

A prose block is **not a special concept** — it is a Sieve block with `kind:"prose"` whose
payload attribute is `content` (a markdown string), exactly the existing `DocBlock`
`{ID, Kind, Content, Attrs}` pattern: `kind:code`→`source`, `kind:ai`→`response`,
`kind:prose`→`content`. It renders into a `contentDOM` — the **same pattern already shipped**
by `code`/`diagram`/`log` (`content:'text*'`) and `ai`/`web-clip` (`content:'block+'`).

The document's **top-level nodes are the blocks, 1:1.** Each carries a `blockId`.

**This spec ships exactly one new prose kind: `kind:"prose"`.**

**`kind:"prose"` — simple, single-paragraph (the everyday, user-typed case).** A prose block
is a **textblock** (`content:'inline*'`, like `code` is `text*`): one paragraph's worth of
content, its own block, its own id. There is **no shared top-level container DIV** — that
container (today's `prose-renderer` `block+`) is exactly the "one DIV holds everything,
every Enter is an internal paragraph" bug we are fixing. Pressing Enter **natively splits the
textblock into a new sibling block** (new node → new id) — ProseMirror's own `splitBlock`,
**no keymap, no Sieve code in the hot path.** Headings/lists typed via markdown shortcuts are
their own native top-level nodes (each its own block) the same way.

**Structured atoms** — `sieve-code`, `sieve-ai`, `sieve-diagram`, `web-clip`, … — are
unchanged: each its own kind, payload in `attrs` (or its own `block+` contentDOM, as
`ai`/`web-clip` already do). They already cover the rich/tree cases that exist today.

**Deferred — `kind:"nested-prose"`** (see Out of scope): a `content:'block+'` prose tree
under one id, created **only by code** when a future actor needs generic rich prose that
`ai`/`web-clip` don't cover. Not built here; named so the model has an obvious home for it.

This is why there is **no keymap**: the only kind we ship is a textblock that splits
natively, and the one shape that *could* need a split-command (`nested-prose`'s `block+`) is
deferred and would be code-created, never keyboard-split.

## Creation is an open API, not a keymap

`create-block` is a capability available to **any actor** with `(kind, markdown-content
string, index)`:

- **The user pressing Enter** → ProseMirror natively splits the textblock into a new
  top-level node → the observer sees a new, id-less node → emits `create-block` (id minted
  on first sync). **No keymap** — the op is *derived* from the native structure change, not
  driven by an intercepted key.
- **A plugin / Sieve Action / actor** → calls `create-block` directly with `(kind, content,
  index)`. Today that targets the existing kinds (`code`/`ai`/`web-clip`/…); the generic
  rich-prose target (`nested-prose`) is the deferred future home.

The result shape is identical regardless of caller: a top-level block whose `content` is a
markdown string rendered into its `contentDOM`.

## Identity

`blockId` is a **global node attribute** on top-level nodes (`addGlobalAttributes`).

- **Loaded** from the on-disk paired delimiters (`<!--s:ID-->` open … `<!--/s:ID-->` close).
- A node that appears **without** an id (native split, paste) is minted **one** id the
  first time the observer syncs it — so the `create-block` it sends already carries that
  `blockId` — via a single **idempotent, history-excluded, `isDestroyed`-guarded**
  `setNodeAttribute`. Subsequent `update-block`s reuse it. Because minting only *fills
  blanks* (it creates no new nodes), the follow-on transaction finds nothing to do →
  **converges** (no runaway). The existing runaway guard remains a backstop.
- **No `Aliases` / `mergeHandles` / `splitHandles`.** Split = the new node mints a fresh
  id (`create-block`). Merge = the absorbed node's id is simply dropped (`delete-block`);
  any dangling ref is GC'd on serialize. The pure Go split/merge handle-union functions
  from Stage B are **unused for prose** and removed from this path.

## Live sync (WebSocket) — per block, never per document

Every WS message is a **single-block op** keyed by `{uuid, blockId, content}` (plus the
verb and, for create, an `index`). There is **no whole-document send** — the legacy
`doc-update` path is retired for prose. The payload shape is identical whether it is the
first keystroke of a brand-new block or an edit to an existing one; only the verb differs.

`onUpdate` (fires per transaction) is **read-only**: it marks the doc dirty and arms a
debounce. It **never** mutates the doc and **never** diffs the whole tree.

**The debounce is only a rate-limit on outgoing per-block messages** — so we do not emit a
WS frame on every keystroke. It is **not** batching the document. When it fires (guarded by
`view.isDestroyed`), pure `computeBlockSync` runs an **id-keyed diff over top-level nodes
only**, and for **each changed block** emits one op over the existing envelope
(`{type:'block-op', op:{…}}`):

- new node, no id yet → mint id, send `create-block {uuid, blockId, content, index}`;
- existing node, content changed → send `update-block {uuid, blockId, content}`;
- node gone → send `delete-block {uuid, blockId}`.

`content` is that one node's **verbatim markdown**. Unchanged blocks emit nothing.
Tab-switch / save **force an immediate send of any pending dirty blocks** (no debounce
wait). The Go side already handles each op (`block_op.go`, `EditorService.HandleBlockOp`,
`ws_handler` routing — Stage C). An id-less, empty editing surface is treated as **pending**
(emits nothing) so it never forces a whole-document fallback.

## Fidelity

A block's `content` is **verbatim markdown** — stored byte-faithful, never normalized,
handed straight to the block's `contentDOM`. PM owns whatever it parses inside.

**Explicitly NOT entangled here** (per D.4 §86–94, user 2026-06-18): the internal
representation of intra-block blank-line runs / hard breaks (the "one paragraph +
`hardBreak`s" candidate) is the **separate whitespace-fidelity problem**; between-block
separation is structural. Solve top-level block structure first; revisit intra-block
whitespace representation on its own. Do not entangle the two.

## Disk format

**Unchanged from D.4 — the FULL delimited block stays (header AND tail).** Each
`kind:prose` block is bracketed by a matched **paired** pair —
`<!--s:ID-->` … `<!--/s:ID-->` — already implemented in `prose-renderer.js`'s
`markdownSerialize` (open carries `id` + aliases, close carries `id`) and parsed by Go
`scanProseRegion` / `ParseBlockDoc`. Structured blocks remain fences. **The closing tag is
mandatory, not cosmetic:** a prose block's content can contain blank lines, so only the
paired close unambiguously bounds it — structure comes from the delimiters, never from
blank lines (D.4). A bare/lone open marker is unbalanced and Go treats it as literal text.

The new design changes **granularity, not format**: a multi-paragraph run that is one
`block+` block today becomes several full-delimited blocks (one paired pair per typed
paragraph), each `<!--s:ID-->…<!--/s:ID-->`.

**Reserved for `nested-prose`:** when that kind lands, the **open** tag of the pair records
the kind (e.g. `<!--s:ID kind=nested-prose-->`, close stays `<!--/s:ID-->`) so a tree
round-trips back as `block+` instead of collapsing to a flat textblock on reopen.

## Gutter / lineage

The gutter reflects **top-level nodes 1:1**, restoring the pre-block-mode "node number per
line." AI targeting / lineage resolve to a top-level block by `blockId`; finer
(highlighted-word) targeting is unchanged and layers on top (see the D.4 blockRef-rewire
note — the legacy depth-0 `blockRef` *mechanism* may change, but word-granularity stays).

## Schema changes (for the plan to bite-size)

- **Typed prose block = a textblock.** Change `prose-renderer.js` from `content:'block+'`
  to a textblock content spec (`'inline*'`, mirroring `code`/`diagram`/`log`'s `text*`),
  keeping its `contentDOM` + `ignoreMutation` guard (per `project_sieve_nodeview_ignoremutation`).
  This is the change that makes native Enter **split into a new block** instead of adding an
  internal paragraph — and it removes the "one DIV holds everything" shape. **Verify the
  Enter→new-block behavior empirically in the running editor** before locking the exact
  content spec (textblock vs. relying on bare native `paragraph`/`heading`/`list` nodes).
- **`doc` content** admits the typed-prose textblock + heading/list native nodes +
  structured `sieve-*` at top level as siblings. (Today `doc` is `sieveBlock+`; widen it.)
- **`blockId`**: a global attribute on the top-level node types.
- **No keymap extension.** (Remove the D.4 split/merge keymap from scope entirely.)
- **Retire** `block-render.js`'s "one prose container wraps the whole prose run" behavior —
  render each top-level block into its own node on load.

## Hydration (legacy / marker-less docs)

On Open of a doc **without** markers: each parsed top-level node becomes a block and is
minted a marker (so old docs become granular/addressable — fixing "too coarse"). Existing
markers and legacy anchored regions are honored as-is (an anchored region → one block).
This is the **one** time boundaries are assigned automatically; thereafter the on-disk
markers define them.

## Out of scope / deferred

- **`kind:"nested-prose"`** — the `content:'block+'` code-created prose-tree-under-one-id.
  Defined here, **built when a concrete actor needs it** that `ai`/`web-clip` don't already
  cover. Requires kind-in-marker on disk (see Disk format). Never keyboard-split.
- **Containers / blocks-all-the-way-up** (a block holding child *blocks*, not content) —
  future; this spec is flat top-level blocks only.
- **Sub-block (word/phrase) targeting** — unchanged; the new floor is block-granular ids.
- **Granular structured-block content sync** — still the `doc-update` fallback (Go's
  structured `update-block` takes parsed `Attrs` the client can't faithfully rebuild from
  a fence string).
- **Intra-block whitespace representation** — orthogonal (see Fidelity).

## Testing

- **vitest, real PM schema:** native Enter creates a new top-level node → the observer
  emits exactly **one** `create-block` (no keymap involved); native Backspace-merge → one
  `delete-block`; native line-delete → one `delete-block`; typing → `update-block`; minting
  is idempotent + convergent (runaway guard + a no-loop stability assertion); **assert
  `onUpdate` performs no doc mutation** when there is no user edit.
- **vitest, `computeBlockSync`:** split → one `create`; edit → one `update`; merge → one
  `delete`; the empty trailing surface emits nothing.
- **vitest, serialization round-trip:** each block ↔ its paired `<!--s:ID-->…<!--/s:ID-->`
  markdown (close tag present; content with internal blank lines still bounds correctly); a rich
  actor-created block round-trips under one id; structured blocks fence-serialize; content
  byte-verbatim.
- **Manual (WebKitGTK, per `project_test_perf_in_wails_app`):** type → a gutter line per
  node + snappy typing; create a rich block via an actor → one block / one id; load a
  legacy file → per-node hydration; tab-switch → no `nodeDOM`/`descAt` errors; reopen
  stable.
