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

## Vocabulary (Block vs Container) — load-bearing

"Block" was overloaded; fix the words:

- **Block = a LEAF.** Represents one content *type* (`Kind = prose | code | image
  | diagram | …`). It has **content** but no child **blocks**. Opaque to the block
  scanner. The new `sieve-block-anchor` is a **prose Block (leaf)** — not a
  container. Its paragraphs are its *content* (ProseMirror child nodes), not child
  blocks. It only *looks* like a container because PM's `content:'block+'` literally
  holds child nodes — that's PM's meaning of "contains," not Sieve's.
- **Container = groups child Blocks/Containers** (`Kind = column-row`, and the tab
  root). The only thing that nests; only Containers are scanned for child blocks.

Two senses of "children", kept distinct: **content** (what a Block is made of —
prose paragraphs, code lines) vs **child blocks** (independent Blocks a Container
groups).

### Naming: the prose block is `prose`, not `block-anchor`
Node name == kind, no exceptions: `sieve-prose`, `sieve-code`, `sieve-diagram`,
`sieve-image`. The D.1 name `block-anchor` is retired — "block" is superfluous
(the `sieve-` prefix already means Sieve Block) and "anchor" both no longer
distinguishes anything (every block carries a handle) and collides with Sieve's
existing gutter/lineage "anchor" concept. Mechanical rename (do it first, before
layering more on the old name):
- `block-anchor-renderer.js` → `prose-renderer.js`
- `registerSieveRenderer('block-anchor', …)` → `'prose'`
- node `sieve-block-anchor` → `sieve-prose` (and `data-type` in `block-render.js`)
- `name === 'sieve-block-anchor'` checks in `editor.js`
- `index.html` script tag

### Leaf constraint is Sieve policy, enforced via the PM schema
PM is **mechanism, not policy** — it enforces whatever `content:` expression we
declare and has no opinion otherwise. "A prose Block can't contain a code Block"
is a **Sieve** decision *expressed* in the schema:
- The prose block-anchor's `content` allows prose nodes (paragraph/heading/list/
  blockquote) and **excludes** sieve-* and container nodes.
- Structured Blocks + Containers live at the doc/container level (siblings).
- **Why:** to keep a prose Block an opaque leaf in storage. If PM let a sieve node
  sit in the anchor's contentDOM, the serialized prose Block would contain a fence
  inside its delimiters → the scanner must descend into prose → prose stops being
  opaque → marker-collision hole reopens.
- **Free payoff:** insert a code Block mid-prose and PM (node disallowed here but
  allowed at the parent) runs its native split-to-place — it **splits the prose
  Block and drops the code Block between as a sibling**. That is the "insert splits"
  behaviour with no bespoke split command; the schema does it.

## Whitespace: the XML rule (a content-fidelity requirement)

One rule, like XML: whitespace **between** blocks (outside the delimiters) is
insignificant; whitespace **inside** a block is preserved content. The parser
never reads whitespace for structure (delimiters do that); it stores in-block
whitespace faithfully as content.

**Source-agnostic.** It does not matter how the whitespace got there — existing
markdown on disk, a manual edit, or keystrokes. If it is inside a block, it is
block content. The "how it was produced" is a non-question.

**The one real engineering problem: make PM render and round-trip it as
whitespace.** markdownit/PM normalize by default (collapse blank-line runs, trim
trailing spaces, reflow), which is why Sieve drops whitespace today. This is a
genuine requirement to solve, not just an accepted loss — approaches to
investigate: preserve blank-line runs as content, hard breaks / trailing-space
handling, or a more verbatim prose-content path. Two mitigations already help: the
container model makes paragraph breaks free (each is a child node), and the
diff-only-changed observer means unedited blocks are never re-serialized. Markdown
mode is already fully verbatim.

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

### Consequence: a prose Block holds multi-paragraph content (not child blocks)
With whitespace non-structural, a prose Block's **content** is arbitrary prose
markdown (multiple paragraphs, lists). The earlier "one paragraph per block"
assumption is **revised**: block extent is delimiter-only and the prose
block-anchor (`content` = prose nodes) holds multiple paragraphs as content. This
is content, not child blocks — a prose Block is a leaf (see Vocabulary); only
Containers hold child blocks.

This makes whitespace preservation mostly **free**: a blank line inside a Block
is a markdown paragraph break → a child paragraph *node* (content) → round-trips as
a blank-line-separated paragraph. Meaningful whitespace (paragraph breaks) is
preserved by construction; only exotic whitespace (3+ consecutive blanks, trailing
spaces) is lossy, and that is accepted.

### A Block is kind-homogeneous; the boundary IS the kind transition
Each Block holds exactly one content *kind*: a diagram block holds mermaid, a code
block holds source, and the **block-anchor holds markdown prose**. The block-anchor
is not special — it is "the prose-kind Block," same shape as the rest.

A prose Block holds **any amount** of markdown prose. The instant content stops
being markdown prose (code, image, diagram, …) → **new Block, do not pass go.**
This is **schema-enforced**: sieve/container nodes are excluded from a prose
Block's PM content, so inserting one makes PM split the prose to place it as a
sibling (the "insert splits" payoff, free).

### Inside prose, engineer nothing — let PM
Whether a new paragraph stays as content in the current prose Block or becomes an
adjacent prose Block is **immaterial**: both are `Kind=prose`, round-trip
identically, and references behave the same. So there is **no bespoke split/merge
keymap for prose** — PM's native paragraph behaviour (Enter, Backspace) is fine;
we serialize the result as prose Block(s). The default implementation keeps a
prose Block multi-paragraph (fewer blocks, less id churn), but the system is free
to coalesce/split adjacent prose since it is equivalent.

The only structural events that matter: **non-prose inserted → prose splits**
(schema, free) and **block deleted**. The diff observer turns those into
`create-block` / `delete-block`; ids mint silently. `splitHandles`/`mergeHandles`
reduce to "new block mints an id / removed block's handles fold into the survivor,"
already expressed by the create/delete ops — no bespoke command.

### RESOLVED: identity granularity, and IDs are silent
Identity lives on the **Block**. A prose Block may hold multiple paragraphs that
are unidentified content; references point at a Block, not a paragraph. Adjacent
prose Blocks are equivalent, so whether prose is one Block or several is immaterial
to identity (each Block that exists has its own id, minted silently).

**IDs are invisible plumbing.** The user is just editing a page and has no idea
ids exist or are being minted. There is NO "create block" / "promote" gesture, no
UI, no awareness — you type, nodes appear, ids get attached under the hood. Any
framing of block creation as a deliberate identity act is wrong; minting is
automatic and silent. (Confirmed with user 2026-06-18.)

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

## Deferred defects (rewire when the new blocks land — NOT before)

- **AI targeting collapses to `ref: doc`; `==` highlight never applies.**
  Observed 2026-06-18 (prose + Ask-AI-on-selection → ai-blocks recorded
  `ref: doc`, no highlight). Root cause is the legacy `==`/`blockRef`
  sub-phrase anchor colliding with the half-migrated block model, two-fold:
  1. `extensions.js` `wrapInBlockAnchor` builds the wrap range at a HARDCODED
     depth `0` (`new NodeRange(blockRange.$from, blockRange.$to, 0)`). That
     assumed prose paragraphs were direct children of the doc. Since D.2 prose
     is nested inside the `sieve-prose` wrapper (depth ≥ 2), so depth 0 is
     invalid → `tr.wrap` throws → the `catch` swallows it → no `blockRef`, no
     `==` mark.
  2. Targeting then resolves the enclosing `sieve-prose` block, which has NO
     minted id yet (minting is Stage-D step 3), so the AI job's `ref` falls back
     to `doc`.
  **Not caused by the prose-block rename** — `resolveAiTarget` recognizes a
  target via `isSieveName = name.indexOf('sieve-') === 0`, which matches both
  the old `sieve-block-anchor` and the new `sieve-prose` identically. Pre-exists
  this session (introduced by the D.2 `sieve-prose` wrapper).
  **Fix direction (deferred, by user decision):** do NOT patch the legacy
  blockRef path now. Once prose ids are minted (step 3) and blocks are real,
  rewire AI targeting from scratch. **RETAINED FEATURE (user, 2026-06-18):
  highlighted-word/phrase AI targeting INSIDE a prose block stays** — a user
  must still be able to highlight a span and have Ask AI target just that span
  (highlighted-word granularity is core; see the lineage memory). So the rewire
  must support BOTH whole-block targeting (caret in block → `ref: pr-xxxx`) AND
  sub-block phrase targeting (highlighted span within a prose block). The
  *mechanism* may change (the depth-0 blockRef wrap and blockRef node itself can
  be replaced/retired in Stage E), but the phrase-targeting *capability* must
  survive — do not collapse everything to whole-block. No app user until the
  migration is complete, so this is not user-facing yet.

## Risks

- Spine swap is foundational — gate behind exhaustive Go round-trip tests before
  wiring the frontend.
- Opacity rule must be airtight (marker collision in code/prose).
- Load-ensures-open lifecycle (keep `Open` idempotent; WS disconnect closes).
- Client id format matches Go `pr-xxxx`; one shared generator.
- Keep the `ignoreMutation` guard on content-bearing anchors (D.3 fix — do not
  regress).
