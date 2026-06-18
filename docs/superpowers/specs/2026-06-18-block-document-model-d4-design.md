# D.4 (revised) Design — Delimited Block Tree + Shadow-as-Source Identity

Status: **design in progress** — 2026-06-18. Supersedes the single-marker handle
scheme (Stage B) and blank-line segmentation. Approved direction; written spec
pending final user review.
Branch: `feature/refactor_editor_layout`
Plan: `docs/superpowers/plans/2026-06-17-block-document-model.md` (Stage D)

## Governing principle (NEW — load-bearing)

**Whitespace is meaningless to the parser. Block structure derives ONLY from
explicit, paired, strippable delimiters — never from blank lines or indentation.**

Anywhere blank lines currently influence parsing (e.g. `segmentBlockDoc` /
`splitProseRun` splitting prose on blank lines, or the single `<!--s:ID-->`
marker "binding to the next block") is the exact ambiguity to remove. Blank lines
are content; they carry no structural signal.

## Whitespace: the XML rule

One rule, like XML: whitespace **between** blocks (outside the delimiters) is
insignificant; whitespace **inside** a block is preserved content. The parser
never reads whitespace for structure (delimiters do that); it stores in-block
whitespace faithfully as content.

Because a block is a container of children, the common case is free: a paragraph
break inside a block is a child node and round-trips as a blank-line-separated
paragraph. Only exotic whitespace (3+ consecutive blanks, trailing spaces) is
lossy through the markdown↔PM round-trip, and that is accepted. (Today Sieve drops
more than that because the whole doc re-serializes; the diff-only-changed observer
already limits loss to edited blocks. Markdown mode is fully verbatim.)

## Storage format: a comment-tag block tree

Each block is delimited by a matched open/close pair of strippable HTML comments:

```
<!--s:pr-1-->
Any markdown content, including

blank lines and multiple paragraphs — all just content.
<!--/s:pr-1-->
```

- **Block = ID + content**, written `OPEN:ID … CONTENT … CLOSE:ID`.
- **Children = nested pairs** inside a container block's content.
- **Unbalanced open (no matching close) = literal text**, not a block.
- IDs are unique, so open/close match by ID; nesting is unambiguous.
- Comments are invisible in any markdown renderer (silent/strippable) — the
  "markdown = storage" property holds; the block tree lives in the comments, the
  markdown is leaf carrier content.

### Opacity (the one collision rule)
The scanner only treats nested pairs as child blocks **inside container blocks**.
**Leaf** blocks (prose paragraph, code, image, ai-block, …) are **opaque**: their
interior is copied verbatim and never re-scanned for markers. This prevents a
literal marker string inside content (e.g. code that contains `<!--s:x-->`) from
being mis-parsed as structure. Practically:
- **Structured blocks stay fence-delimited** (a fence is already self-delimiting
  AND self-evidently opaque); the comment-scanner skips fenced regions atomically
  (today's behaviour).
- The residual case — a literal `<!--s:…-->` on its own line inside prose — is an
  escape-rule / break-glass edge, not a structural signal.

### Undelimited content
Content with no surrounding pair is **not** whitespace-split (that would
reintroduce the smell). It is carried as a single opaque prose block (or attached
to the enclosing block) and gets a minted handle on load. **Structure is created
explicitly in the editor** (split mints a delimiter pair), never inferred from
blank lines. Consequence: a hand-written markdown file with N blank-line-separated
paragraphs opens as ONE prose block until the user explicitly splits it.

### Consequence: a block is a container of children
With whitespace non-structural, a prose block's content is arbitrary markdown
(multiple paragraphs, lists). The earlier "one paragraph per block" assumption is
**revised**: a block is a **container of children**, block extent is
delimiter-only, and the editor anchor (`content:'block+'`) already holds
multi-node content.

This makes whitespace preservation mostly **free**: a blank line inside a block
is just a markdown paragraph break → a child paragraph node → round-trips as a
blank-line-separated paragraph. Meaningful whitespace (paragraph breaks) is
preserved by construction; only exotic whitespace (3+ consecutive blanks, trailing
spaces) is lossy, and that is accepted.

### Editing model: Enter = new block, Shift+Enter = in-block content
The Notion convention, which removes the need for a bespoke split command:

- **Shift+Enter** → a newline/paragraph as *content* within the current block. The
  block (a container) renders these as paragraph children. Stays one block;
  whitespace preserved as content.
- **Enter** → PM creates a new block *node* via **standard insert-node behaviour**.
  The diff observer sees a new top-level node → `create-block` (new minted id).

So "split" is just Enter through PM's native machinery; "merge" is just
Backspace-at-start joining nodes (diff sees a node gone → `delete-block`, removed
id+aliases fold into the survivor). `splitHandles`/`mergeHandles` reduce to "new
block mints an id / removed block's handles union into the survivor" — already
expressed by the create/delete ops. Keymap work shrinks to: Enter creates a new
block-anchor (not a paragraph inside the current one); Shift+Enter adds in-block
content.

### RESOLVED: identity granularity
Identity lives on the **block (container)**. A block may hold multiple paragraphs
(added via Shift+Enter) that are unidentified content; **Enter starts a new
identified block**. Promotion isn't a special operation — it's pressing Enter.
References point at a block, not a paragraph. (Confirmed with user 2026-06-18.)

## Parser / serializer changes (the spine)

- **Serialize** (`SerializeBlockDocWithHandles` → delimited-tree writer): emit
  `OPEN:ID` + content + `CLOSE:ID` for every block; recurse into container
  children; structured blocks keep fences. Whitespace between blocks is cosmetic.
- **Parse** (`ParseBlockDocWithHandles` → stack-based scanner): scan for matched
  pairs; build the tree; leaves opaque; fenced regions atomic; unbalanced open =
  text; undelimited top-level content = single minted prose block.
- **Retire** blank-line segmentation (`segmentBlockDoc` / `splitProseRun`) as the
  source of block boundaries.

## Identity — the shadow is the single source of truth

- **Mint on open**: `EditorService.Open` assigns `GenerateBlockID(KindProse)` to
  every prose `DocBlock` with an empty ID, in the shadow's `Doc`. In-memory;
  persisted on next save via the delimited-tree writer. `Open` is idempotent.
- **Load through the shadow**: `handleEditorLoad` ensures the shadow is open and
  returns the shadow's blocks (`BlockDocToFrontendBlocks`). Editor and shadow
  share identity → anchors render with real `data-id`, sync cache seeded.

## Sync — the observer becomes a full diff (retires doc-update for WYSIWYG)

Extend pure `computeBlockSync` into an id-keyed diff over top-level blocks:
- id in curr not prev → `create-block {blockId, kind, content, index}`
- id in prev not curr → `delete-block {blockId}`
- changed content/aliases → `update-block {blockId, kind, content, aliases?}`
- order-only change → no op (drag-reorder keeps its `move` path)

Triple gains `aliases`. Empty-id remains a defensive-only fallback.

## Editor behavior — split/merge keymap

- **Enter** in an anchor → split into two delimited sibling blocks; the new tail
  block mints a fresh client-side id (matching `pr-xxxx`); head keeps id+aliases
  (mirrors Go `splitHandles`).
- **Backspace** at an anchor start → merge into the previous block; survivor keeps
  id, removed id+aliases union into survivor `aliases` (mirrors `mergeHandles`).
- Keymap only edits + mints (a user transaction); the debounced observer derives
  all ops from the diff. One sync path, no double-emit.

## Scope / sequencing note

This is larger than the original D.4: it changes the serialization spine (paired
delimiters, scanner, opacity) and retires whitespace segmentation — touching
Stage B foundations. Recommended sequencing:
1. **Spine swap (TDD, Go):** paired-delimiter writer + scanner, opacity, leaf vs
   container, unbalanced=text, undelimited=single minted block. Round-trip tests.
2. **Identity:** shadow mints on open + load-through-shadow.
3. **Sync:** unified-diff `computeBlockSync` (vitest TDD).
4. **Keymap:** split/merge mint/merge delimiter pairs (eyeball-only).

## Testing

Go TDD: paired round-trip; opacity (marker-in-code not parsed); unbalanced=text;
undelimited=single block; open mints; load returns shadow blocks; save persists
pairs. Vitest TDD: extended `computeBlockSync`. Manual eyeball (CDP unavailable):
Enter adds one block, Backspace removes one, undo stable, fresh-note typing emits
block-ops, reopen round-trips, blank lines never alter block structure.

## Risks

- Spine swap is foundational — gate behind exhaustive Go round-trip tests before
  wiring the frontend.
- Opacity rule must be airtight (marker collision in code/prose).
- Load-ensures-open lifecycle (keep `Open` idempotent; WS disconnect closes).
- Client id format matches Go `pr-xxxx`; one shared generator.
- Keep the `ignoreMutation` guard on content-bearing anchors (D.3 fix — do not
  regress).
