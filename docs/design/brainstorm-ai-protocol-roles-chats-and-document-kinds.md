# Brainstorming 5: Protocol Roles, Chats, and Document Kinds

Companion to [brainstorm-smart-code-blocks.md](./brainstorm-smart-code-blocks.md),
[brainstorm-smart-code-blocks-2.md](./brainstorm-smart-code-blocks-2.md),
[brainstorm-blocks-all-the-way-up.md](./brainstorm-blocks-all-the-way-up.md) and
[brainstorm-email-workbench-and-block-store.md](./brainstorm-email-workbench-and-block-store.md).

Brainstorm 4 found the block store and the editor lens. This one interrogates the **AI
side** of that design and falls through a trapdoor: Sieve's AI is not prompts but
*protocol roles*; a chat with an LLM is a *typed document*; and the type system runs at
two grains — atoms and lists. By the end, storage format, editor technology, and the AI
protocol all turn out to be consequences of one axis: **read vs interpreted**.

*2026-07-17. A thinking document, not a spec.*

---

## 1. Protocol roles, not prompts

The email workbench's evaluator (brainstorm 4 §2) has almost everything an "agent
definition" normally carries:

- **Identity and stance** — critic, not ghostwriter; judges, doesn't rewrite unbidden.
- **A typed I/O contract** — the annotation JSON schema, validated by Go, with a repair
  move (one corrective re-prompt) when violated.
- **Conversational obligations** — an open annotation carrying a user refutation *must*
  be conceded or re-argued; it cannot be silently re-raised.
- **Curated grounding** — thread + latest draft + negotiation state, assembled by Go.
- **House policies** — recommend, never decide; `user_intent` untouchable.

What it deliberately lacks is **autonomy**: no tool loop, no self-directed retrieval, no
"keep going until done." The application owns the loop and the human paces it — replay
fires when the user is ready, never when the model wants.

### The block is the memory

`--no-session-persistence` is not an accident of the CLI; it is the architecture. The
model is amnesiac by construction, and **state lives in the artifact**: annotations,
refutations, and verdicts are the transcript — curated and structured, not an append-only
chat log. Every replay reconstructs the conversation from the block. Same shape as a PR
review: the reviewer arrives stateless; the review state lives in threads on the artifact.
State-in-artifact means the "conversation" is inspectable, editable, versioned (free
FileStore history), and survives machine switches — none of which a session gives you.

### Both parties have typed moves

That is what makes this a *protocol* rather than a persona. The human's moves:
apply / refute / edit / replay. The model's moves: annotate / concede / re-argue / assess.
Each annotation is a small state machine:

```
open ──apply──▶ applied
open ──edit───▶ stale
open ──refute─▶ refuted ──replay──▶ conceded (dropped) | re-argued (kept, responds)
```

Write the state machine down and the agent definition is written — the prompt becomes a
*rendering* of the protocol, not the source of truth. That is the inversion: today the
prompt is primary and behaviour is emergent; here the protocol is primary and the prompt
is derived.

### Where the role definition lives

The job-engine design already says processors declare jobs and the framework owns
lifecycle. The natural extension: a processor declares a **role** — prompt template +
response schema + validator + repair policy + context assembly + obligation rules — as a
formal Go shape. Sieve has been accumulating a cast of characters wearing ad-hoc versions
of this: the ai-block's *answerer*, the web-clip's *summariser*, the close-time
*librarian* (`FilingRecommendation` is already a typed contract), image-describe. The
workbench evaluator should be the first to get the formal shape; the others migrate as
opportunity allows.

Two forward echoes:

- **The API swap point.** `ai/cli.go` is documented as the future API-backend seam. A
  typed role maps directly onto structured-output/tool-use machinery — the protocol layer
  is backend-neutral; only the transport changes.
- **The containment boundary is where real agency would enter.** The internal Sieve MCP
  (read-only verbs, #36) is the fence. The day a role *pulls* context ("search the
  library for past emails to this person") instead of being handed a curated bundle is
  the day it crosses from protocol role to genuine agent — a decision to make against
  that fence, not a drift.

---

## 2. The versions tool: temporal depth, not lateral breadth

Should the MCP expose version history? Yes — and it is a *smaller* containment step than
it appears. The agency risk flagged above is **lateral breadth**: reaching into the
corpus. A versions tool is the other axis — **temporal depth**: the model sees only the
artifact it is already working on, through time. Blast radius unchanged.

Mechanically nearly free: `Versions()` / `RetrieveVersion` exist; the MCP grows
`list_versions(uuid)` and `diff_versions(uuid, a, b)`. Diff-shaped output matters —
token-cheap, and models reason over diffs superbly.

What it unlocks for a role:

- **Trajectory awareness.** "Paragraph three has been rewritten four times across
  replays — that's where you're struggling." State says what is; history says what's hard.
- **Reverts as implicit refutations.** Apply a suggestion, later edit it back out — the
  explicit protocol never hears it, but the diff does. Obligation: *don't re-suggest what
  was reverted.*
- **Consistency across replays.** The role sees its own prior verdicts and doesn't
  flip-flop without cause.

The discipline that survives: **self-observation, not self-direction**. The model reads
its own past; the user still owns the loop.

---

## 3. The AI atom — and what it is not

The recurring use case: open an empty document purely to bounce questions off an LLM.
Under brainstorm 4's model that wants to be first-class, and the tempting slogan was "the
AI atom": the ai-block is a chat window at minimum zoom (one Q, one A — a chat of length
two), the conversation document is the same thing at maximum zoom, the lens does the
zooming, and every AI feature is one atom variously clothed (the evaluator is the atom
wearing a schema; the ambient Ask panel is the atom docked).

The slogan is half right and the correction is the real discovery: **the atom is the
turn; the chat is a *list*.** A conversation is not a big block — it is an *array of
blocks*. It is not a Thing. Which exposes that the type system runs at two grains:

- **Block kinds** — typed atoms. Published atoms live in *Things*, foldered by kind.
- **Document kinds** — typed block-lists. A chat is the first: structurally a document,
  semantically typed, rendered by its own lens.

---

## 4. Document kinds: `List<?>` vs `List<Turn>`

The generics notation makes it exact:

- **Note** = `List<?>` — the wildcard document. Anything may appear; meaning lives in the
  content; the default lens is the NoteEditor. A note is revealed as just the *default,
  untyped* document kind.
- **Chat** = `List<Turn>` — the element type is constrained (user turn | AI turn,
  alternating), and *that constraint is the kind*.

The document kind is not a label for lens-picking; it is a **schema with teeth**:

1. **The editor enforces it.** In a chat the only legal top-level append is your next
   turn — the input box at the bottom of every chat UI is the editor affordance for
   `List<Turn>`.
2. **The codec can verify it.** Deserialization already asks the registry per region; a
   typed list adds "and the elements must satisfy T."
3. **The role assumes it.** Context assembly walks a known shape instead of scraping a
   document. The protocol role and the document kind are two views of the same schema.

The type constructor immediately predicts more sections than Chats — the sign the
abstraction is real: `List<WebClip>` = a reading list; `List<LogEntry>` = a journal /
session log (`spec-session-log.md` was a typed list waiting for the concept);
`List<Prompt>` = a prompt library, if prompts migrate to block kinds as brainstorm 4
predicts. Each gets its lens, element constraint, lifecycle policy, and library section
from declaring `T`.

Grains, fully named: **records** for atoms (the workbench is `{thread, draft,
annotations, evaluation}` — neither list nor wildcard), **grammars** for lists (chat),
and nested combinations (the turn, §6). The full generalisation — "kinds are schemas over
block structure" — is the brainstorm-6 cliff edge; noted, not walked off.

Speculative bonus: if kinds are element constraints, **type inference on documents**
becomes thinkable — a wildcard note containing only web-clips could be offered the
narrowing "make this a reading list?". The librarian role doing type inference at close
time is a very Sieve idea.

---

## 5. Chats: born in the library, per-kind lifecycle

A chat's lifecycle is **pause/resume, not draft/discard**. A buffer ends — triage exists
to force the ending. A conversation dangles: close the tab mid-thought, pick it up in
three weeks; artifact-borne memory makes resume free. Forcing keep-or-discard on every
LLM conversation is friction against the grain of the thing.

So lifecycle policy becomes **per-kind**, and the model gets cleaner:

| Kind | Born | Close-time | Library section |
|---|---|---|---|
| Note buffer | Isolated | Triage: file / discard | Notes (user-foldered) |
| Working block (workbench…) | Isolated | Triage: publish to Things / discard | Things (kind-foldered) |
| Chat | **Shared, in the library** | Nothing — persists, resumable | **Chats (chronological)** |

Filing-as-publication survives intact; chats simply skip the gate because they are born
published. Each section's organising principle differs deliberately: Notes are
user-foldered (your taxonomy), Things are kind-foldered (the type system's taxonomy),
Chats are chronological (time is a conversation's natural index — a recency list with
auto-titles from the librarian role). Deletion remains for the worthless.

Referability falls out: a chat is a library citizen from birth, so a note can point at it
— when transclusion lands, quoting a chat into a note is the distilled-knowledge flow:
the chat is the ore, the note is the metal.

Wrinkle, noted not solved: born-shared means a chat could be open on two machines; chats
are append-mostly and single-author, the optimistic lock exists, the same-doc-two-tabs
constraint guards the worst.

---

## 6. Attachments: the ref, costumed

Chat apps attach things to messages. Sieve already has the mechanism: **the ai-block's
`refs` chain**. An attachment is *not* a new edge type — it is the existing ref rendered
by a different lens: hover-chain highlight in a note, attachment chip on a turn.
Corollary: a note containing "some blocks + an ai-block referencing them" is already a
chat turn wearing note clothing.

Consumption is also solved: Rule 14 already passes refs into AI context as human-readable
summaries (block summaries, image descriptions, and post-#38, file content).

### Materialization: the content has to go somewhere

Attach a code block to a turn and the content is copied **into the chat's own list** as a
real block; the ai-block's refs resolve within-document, exactly like today's chains. The
turn is a container:

```
Chat = List<Turn>
Turn = UserTurn { message: Prose, attachments: List<Block> }
     | AiTurn   { answer: AiBlock }
```

The first *nested* typed structure in the system — and context assembly becomes purely
mechanical because of it: walk turns in order, emit message + Rule-14 summaries of
attachments. The schema *is* the prompt-builder's contract.

### Freeze vs re-read

This resolves value-vs-reference for turns with smart-blocks-2's own answer ("you don't
choose — it's a spreadsheet"): the embedded block is the **cached value** (the code as it
was at send time); a provenance edge (`src: block:code-9f2b@v12`, version-pinned) is the
**memory of the copy**. No watchers, no live sync — and with the versions tool, "this has
changed since you asked about it" is a diff away.

The principle, latent in the codebase all along: **refs in turns freeze; refs in roles
re-read.** A turn is an *utterance* — historical; freezing is what the
thread-quotes-are-stale-snapshots decision always meant. An *evaluation* (workbench
replay) is about current state, so its role re-reads. Cross-document refs that freeze
need none of the hard transclusion machinery — so "attach anything in the library to a
chat message" (an image, a file, a web-clip, a published workbench, a note, *another
chat*) arrives almost free. Attachments are the first UI that spends the referability
that born-in-library bought.

---

## 7. Native YAML: read vs interpreted

Storing chats as markdown-with-delimiter-comments would be pretending. The principle that
has silently driven every storage decision in this series:

> **Markdown is for what's read; YAML is for what's interpreted.**

A note is read → markdown is its native form. A block is interpreted — the fence was
never "markdown-ness", it was a **transport encoding** for letting interpreted things
live inside a reading surface (brainstorm 4 said this for atoms: `.block` = bare YAML,
fence at embed time only). A chat is interpreted structure through and through → native
YAML, `{uuid}.chat`:

```yaml
kind: chat
turns:
  - role: user
    id: t-1a2f
    message: |
        Can you explain what this is doing?
    attachments:
      - kind: code
        src: block:code-9f2b@v12       # provenance, pinned
        lang: go
        content: |
            func main() { ... }
  - role: ai
    id: t-2b3c
    block:
        id: ai-c71e
        response: |
            This is the entry point...
```

The duality: **a note is markdown with YAML islands; a chat is YAML with markdown
islands.** Host and guest invert; one rule generates both — structure in the interpreted
layer, prose in the reading layer. Leaf scalars (`message`, `response`, attachment
source) stay markdown strings because leaves are what humans read. The 4-space
block-scalar discipline already protects inner fences.

Consequences:

1. The container-vs-derived turn question **dies** — YAML sequence items are explicit
   structure for free.
2. The chat lens needs **no DocumentCodec, no fence hooks, no RegionScanner, no markdown
   round-trip**. The codec stack reveals itself as the machinery for the *mixed* format,
   needed only where reading and interpretation share a file.
3. "Markdown is the right output format" — *output*, exactly: export-chat-as-markdown is
   a derived projection (walk turns, emit transcript), same as blocks derive their fence
   form. Storage doesn't pretend; export renders.

The fence's role is now uniform across every shape: atom-in-note → fence; chat-in-note
(someday) → fence. The fence is *the* adapter between the two worlds — used at
boundaries, never as identity. Priced honestly: a raw `.chat` file no longer reads in a
random markdown viewer; the S3/server future talks to the store through APIs and lenses,
not `cat`.

---

## 8. No ProseMirror in the chat lens

PM earns its cost in exactly one situation: live free-form editing of a reading surface.
A chat's editing model is **transactional and turn-granular**: compose in a box, send,
the turn becomes rendered history. Form input, not document editing. The composer is a
`<textarea>`; sent turns render through `renderMarkdown` — the same markdown-it path
ai-block responses use today.

Even the prized "editable history" survives PM-free: curation of a typed list is
**structural** — delete turn, edit message (swap that one back into a textarea), fork
from here. Better than PM would be: free-cursor editing across a `List<Turn>` could cut
across turn boundaries and break the grammar. The schema wants transactional edits.

The rule of thumb the system converged on:

- **PM where text is *worked*** — the note; the workbench's draft region.
- **A form where text is *submitted*** — the chat composer, the ask line, refute inputs.
- **Rendered DOM where text is *read*** — sent turns, thread panels, evaluations,
  embedded cards.

The workbench is all three at once — which is why "editor lens" was the right
abstraction and "an editor is a PM instance" never was. Wins: chat tabs are cheap in
exactly the environment that punishes contentEditable (WebKitGTK); the editor
interaction contract stays scoped to PM lenses; undo needs no stack (turn ops are
discrete; version history is the deep undo). If the composer someday wants @-mention
autocomplete for attaching refs, TipTap can upgrade that one input — a lens
implementation detail, never an architectural need.

### Renderer reuse: one renderer, three hosts

Look-and-feel consistency without PM comes from a small factoring. Half exists:
`renderMarkdown` + `applyHighlighting` are already editor-independent (theme vars, code
gutters). The other half: today each block kind's attrs→DOM logic lives inside its PM
NodeView. Split it — a plain **renderer class** per kind (attrs in, DOM out), with the
NodeView reduced to a thin PM-lifecycle adapter. The note lens wraps renderers in
NodeViews; the chat lens calls them directly; embedded cards use them too. **One
renderer per kind, three hosts** — smart-blocks-2 vindicated again: "renderer" was never
a PM concept; PM was just its first host.

The line that summarises the whole section: **Sieve isn't a PM app; it's a block system
where one lens happens to use PM.**

---

## 8a. Addendum (same day): @-mentions and the coordinate system

The chat composer needs the equivalent of Claude Code's `@file`: type `@`, autocomplete
over the library, attach a **reference to a note** (or a Thing, or another chat). This is
the first attachment kind the composer *requires* — and it forces the first
**cross-document reference**, which forces the **address scheme**. That scheme is the
start of the coordinate system blocks-all-the-way-up needs: linking to docs and blocks
across the whole app.

Constrained by facts already in the codebase — block IDs are only "unique enough within a
document" — a global address must be document-qualified. The coordinate triple:

```
sieve:{doc-uuid}              — a document (note, chat, Thing)
sieve:{doc-uuid}/{block-id}   — a block within it
…@v{n}                        — optionally pinned to a version
```

Backlinks, transclusion, the reference graph, "quote that chat in this note" — all of it
rides these coordinates. The @-mention is their gentlest first user because §6's freeze
semantics already solved the hard part: attaching a note **materializes** its content
into the turn at send time (Rule-14 summary or full body — the §9 size discipline
applies) with `src: sieve:{uuid}@v{n}` pinned as provenance. No watchers, no live
resolution: the coordinate is *provenance metadata* first, and only becomes a live edge
in the transclusion era. Resolution is the #37 index's job — `LoadByUUID` is documented
O(n); the coordinate system is what finally makes that index load-bearing. (This also
firms up §8's composer note: @-mention autocomplete is the concrete reason the chat
composer eventually upgrades from a bare textarea to a richer input.)

---

## 8b. Addendum (2026-08-11): the ai-block is the AI *turn*, not the turn

Written while designing `@`-mention attachments (#74). It revises §3, §6 and §8, and
resolves part of §9's turn-grammar question.

### The correction

§3 landed on *"the atom is the turn; the chat is a list"* and left an ambiguity §6 then
inherited: is a turn **one exchange** (question and answer together, the shape today's
ai-block already has) or **one speaker's move**? §6's grammar says moves —
`UserTurn | AiTurn` — but its `Turn = UserTurn { message, attachments: List<Block> }`
still reads as though the ai-block were the turn.

The distinction that settles it is about the ai-block's nature:

> **An ai-block is a pointer-thing, not an owner-thing.** It has never owned content — it
> points at neighbours and comments on them. A turn *owns* what it says.

So the ai-block cannot be the turn; it is **the AI's move**, exactly as §6's `AiTurn`
already had it. The human's move is the other half, and it is an **array of blocks** —
prose the user typed, plus anything minted alongside it (a pasted code block, a web-clip
from a URL).

This keeps the ai-block's identity stable across both worlds. It is always an answer
pointing at what it is about; only the neighbourhood changes — sibling blocks in a note,
the human half of the turn in a chat.

### Why the turn is a real container

A container is needed exactly when content has no other home:

| Relationship | Content lives | Needs a container? | In the prompt |
|---|---|---|---|
| **Referenced** | elsewhere, already addressed | no — a pure edge | manifest, fetched on demand |
| **Frozen** | copied here | yes — the copy needs a home | inlined |
| **Minted** | born here, no other home | **yes, structurally** | inlined |

§6 justified the container by **freeze**, which is a policy choice and therefore arguable.
**Minting** is the structural case §6 did not consider, and it is not arguable: composing a
message *is* minting, and a first-class chat wants it — paste a URL, get a web-clip; paste
code, get a code block. A block born in a turn has nowhere else to exist.

The obvious objection is the leaf rule: `sieve/block/sieve_block.go` says *"there is no
Children field: a block is a LEAF"*, with containers deferred to Stage E. **That constraint
does not reach here.** It belongs to `ShadowDocument` and the markdown codec, and §7 already
exempted chats from both — *"the chat lens needs no DocumentCodec, no fence hooks, no
RegionScanner, no markdown round-trip."* A chat is native YAML with its own schema, so
nesting a block list inside a turn is just YAML. Blocks stay leaves; the turn is a container
Node, which is precisely brainstorm 6 §7's *"containers and blocks are distinct, unified
behind `Node`."*

The second reason is referenceability. §8a's coordinate addresses whatever has an id, so if
the exchange is not a thing, it cannot be cited — only its members can. Making the turn real
gives the exchange an identity:

```yaml
TURN:
  id: turn-1234
  refs: turn-1233                 # the chain, at turn granularity
  human: [ <blocks — prose, minted code, web-clips> ]
  answer:
    kind: ai-block
    id: ai-9876
    question: { turn: turn-1234 }
    refs: []                      # what the answer is ABOUT
    attachments: [ sieve:9f2b-… ]
    answer: "…"
```

Two smaller consequences of the container: an **unanswered turn is structural** (a turn
with no answer yet) rather than inferred from a block nothing points at; and the chain moves
to **turn granularity**, which is cleaner than chaining ai-blocks to one another, because a
thread is a sequence of exchanges and always was.

### `question` becomes a union, and stays backward compatible

If the human turn is an array of blocks, the text the user typed is a **prose block** in
that array, beside the code block they pasted. Storing that text in a `question` string
while the pasted code is a block would special-case prose, which the codebase refuses to do.
But in a note there is no turn — the ask text is authored in a dialog and, per brainstorm 6
§6a (*"the conversation leaves the document"*), should not be materialised as a prose block
in the document.

Two legal sources for the question, then — which must not be expressed as two nullable
fields, because a type whose validity depends on where it lives cannot be validated. It is
one **tagged union**:

```yaml
question: "what is a defect?"     # legacy scalar — still valid, sugar for {text: …}

question:
  text: "what is a defect?"       # note mode: no turn to point at

question:
  turn: turn-1234                 # chat mode: the human half of the exchange
```

The scalar form is why this costs no migration: every ai-block already on disk is valid
unchanged, with no dual-read window and no rewrite-on-save churn through FileStore history.

It is deliberately **not** called `prompt` — #42 introduces a prompt framework whose
*prompt generator* assembles the full text sent to the model, and that word is spoken for.

Enforcement has an obvious home: deserialization is a processor concern, and §4 already
says *"the codec can verify it."* `AIBlockProcessor.Deserialize` requires `question` and
requires exactly one arm; neither or both is a parse error. One gate covers disk, paste and
the wire.

### `question.turn` does not step on `ref` — they are different layers

Both hold addresses, so they look alike. They are not:

- **`ref` is the SieveBlock-level graph edge.** Every kind has it; `outgoingRefs()`,
  `answersTo()` and `gcRefs()` are methods on `SieveBlock`, and web-clip chains use the same
  mechanism. It participates in the graph, is garbage-collected, and paints chain-hover.
- **`question` is ai-block payload**, one arm of which happens to carry an address. Addresses
  in payload are already ordinary — `attachments` does it, web-clip's `source` URL does it.

With the union in place, `ref` means one thing in every host — *what this answer is about* —
and may legitimately be empty in either. Empty-because-nothing-to-point-at is a real state;
empty-because-the-other-mode-uses-a-different-field was the contract hole.

### No forward pointers

The tempting shape is a `next:` on the human half naming the answer that arrived. Do not
store it. The rule is about **who owns the declaration**:

| | Owner | Verdict |
|---|---|---|
| `refs` on the ai-block | the block declares **its own** edge | **store** — brainstorm 2 §3, *"a block declares its references"* |
| `answer: ai-9876` on the human half | the inverse of someone else's declaration | **compute** — brainstorm 6 §7, *"backlinks are computed, never stored"* |

A forward pointer also needs a second write at a second time (the answer does not exist when
the question is asked), which is the case that most favours computing. "Which answer replies
to this?" is a local scan — an answer always lives in the same container as its question. If
a global version is ever wanted, that is the #37 index's job: derived and rebuildable.

### The block keeps its own edges even when containment implies them

Inside the turn, `question: {turn: turn-1234}` is redundant with containment. Keep it anyway.
A block must be **complete in isolation**: extraction is not hypothetical — §5's *"the chat is
the ore, the note is the metal"* is exactly the flow that lifts an answer out of a chat and
into a note. Containment supplies meaning only while the block is inside; refs supply it
everywhere. It is the same discipline brainstorm 6 §3 applies to renderers — a thing that must
know where it is in order to make sense is host-aware, and host-awareness is the bug.

> **Containment arranges. Refs describe.** The turn says *these things form one exchange*; the
> ai-block says *this is what I answered*. Remove containment and the exchange has no identity;
> remove refs and the block cannot leave home.

The honest cost: a bare `turn-1234` is only unique within its container, so **extraction
re-addresses** — lifting an answer into a note rewrites its reference to
`sieve:{chat-uuid}/turn-1234`. That is not incidental; it is the same fact that made block ids
document-scoped, and the same address-space move that separates minting from pointing.

### Attachments are a field, not a chain hop

§6 called an attachment *"the ref, costumed."* Two roles were being conflated. `ref` is a
**traversal** edge — the chain walker follows it and renders each hop as a turn. Attachments
are a **property of each turn**, and every turn in a chain carries its own, so a chain entry
renders:

```
NODE ID:
QUESTION:
ATTACHMENTS: [ {kind, title, uuid, summary}, … ]
ANSWER:
```

One field cannot be both without kind-checking every hop to decide whether to descend into it
or render it as context. So attachments are their own list of coordinates and `ref` is
untouched. (#74 carries the detail.)

This also removes the size objection to per-turn attachments. Inlining bodies would cost
O(turns × documents) — a five-turn chain each carrying a large document is unaffordable before
it is useful. A manifest costs a few lines per turn and the model fetches only what it needs
through the MCP. Retrieval removes a tradeoff inlining would have forced between per-turn
fidelity and prompt size.

### What it buys: citation, and branching

**Citing an exchange.** §8a's coordinate addresses a block, and now a turn, so a conversation's
individual moves become citable:

> *"Based on the answer @'what's a defect' we need a unit test — what would you suggest here?"*

That resolves to one turn in another document, and the manifest hands the model its question and
answer together. §5 said a chat is *"the ore"* and a note *"the metal"*; this is how the metal
cites the seam. It needs one thing #74 does not build — block-granular addressing on both ends:
a picker that can search *within* documents for turns, and an MCP verb returning a single block
or turn rather than a whole note. Both are additive; the address already anticipates them.

**Branching a chat.** Because the chain edge is an address, a new chat whose first turn refs a
turn in another chat inherits that conversation's entire history without copying a byte:

```yaml
TURN:
  id: turn-0001
  refs: sieve:{other-chat-uuid}/turn-1234@v7
  human: [ "ok, but what if the input is null?" ]
```

Nothing special-cases it — **a branch is a chain edge that happens to cross a document
boundary**, and the walk is the same walk, with the Router resolving globally at that one hop
(brainstorm 6 §7, *"the Router hides which"*). Three notes:

- This is **not** brainstorm 6 §8's *Fork*, which is reserved for *copy, new identity, new
  lifecycle*. This has new identity and new lifecycle but **no copy** — closer to a git branch
  naming a commit. It deserves its own row in §8's verb table rather than overloading a word.
- **Pin the branch point.** This is the first place bare-vs-pinned has a visible user
  consequence: §8 sanctions editing a turn's message as curation, so a bare coordinate lets
  someone retroactively change what a branch inherited. §6's *"refs in turns freeze"* already
  says an utterance is historical.
- **"What branched from here" is computed**, per §7 — so branching never writes to what it
  branched from.

It needs exactly one new capability, and it is one #74 needs anyway: `resolveChain` walks
`jctx.Doc` only, so crossing a document boundary means routing the hop.

### Costs, stated

- **Rendering differs by host, correctly.** In a chat the ai-block renders only its answer,
  because the question is already on screen as the human half above it; in a note it renders
  both, because the question has nowhere else to appear. Driven by which arm of `question` is
  populated, not by the block knowing where it is.
- **The question becomes mutable in a chat.** Today `question` is a frozen string on the
  ai-block, so what was asked cannot drift. Pointing at a live turn means editing the human half
  retroactively changes what the answer replied to. §8 wants that — *"edit message (swap that one
  back into a textarea)"* is listed as legitimate curation — but an answer can now go stale
  against its own question, the same staleness the annotation state machine in §1 already models.
- **`List<Turn>` keeps its teeth, but they are unbitten.** The container makes the element
  constraint expressible; §9's *"keep the grammar loose until a second chat-shaped kind exists"*
  still says not to enforce alternation yet.

---

## 8c. Addendum (2026-08-25): the question is a list of blocks; pointing is a kind of block

Written while designing the Go side of chats. It revises §8b — overturning two of its
conclusions with machinery §8b did not yet have (#74's attachments) — settles §3's turn
question for good, and completes §8a's coordinate grammar. Tracked: #100 (ReferenceBlock),
#101 (the ai-block refactor), #102 (the chat kind).

### The arc: four positions, each overturned by its successor

The design passed through every station before arriving:

1. **§8b's turn container** — `UserTurn { blocks } | AiTurn`. Justified by minting: a
   block born in a turn needs a home. Overturned when #74 landed attachments as a *field
   on the ai-block* (manifest + ephemeral grant, no materialisation) — the container's
   structural justification evaporated.
2. **The ai-block IS the turn.** Post-#74 the ai-block carries question + attachments +
   answer — one full exchange with one id; the chain at block granularity *is* turn
   granularity; an unanswered question is a block with no answer; §8b's `question` union
   evaporates. Everything §8b wanted from the container, cheaper. But the question is a
   scalar — pasted code, a log, anything rich is homeless, and attachments only point at
   what already lives in the library.
3. **`AiTurn` as its own kind** — turn = list of blocks, the AI's move a separate type.
   Buys prose-as-a-block uniformity and an honest shape for the AI move; costs a fork of
   the AI machinery into two drifting siblings, loses the flat spine, and re-opens the
   union.
4. **Convergence: the ai-block with `question: List<Block>`.** The standard question is
   one prose block; pasted material is minted *into the list*; the exchange is complete
   in isolation, so extraction ("the chat is the ore, the note is the metal") is a plain
   copy — no re-addressing, retiring §8b's honest-cost paragraph.

### The dissolutions

What made position 4 stable is a sequence of discriminators collapsing into structure
that already carried the information:

- **The ai-block's `ref` attr dissolves into the question.** "Ask about these three
  blocks" was always one utterance — the gesture and the sentence; the scalar question
  forced the gesture into a side-field. The attachment processor's header had already
  said it of the composer manifest: it *"exists to compensate for a textarea having
  nowhere to put a block."* (`ref` survives system-wide as the generic SieveBlock edge —
  web-clip provenance — the ai-block just stops using it; `outgoingRefs`/`gcRefs`
  harvest reference elements from the list.)
- **`rel` as behaviour dissolves into the pin.** Brainstorm 6 §7's *"bare = live edge,
  pinned = frozen snapshot"* is the whole freeze story, per element: §5's "refs in turns
  freeze; refs in roles re-read" pushed down to its true grain. A quote is a pinned
  address — by-value semantics without a copy, because FileStore snapshots every save.
  `rel` survives **only as an authored presentation hint** (quote/target/attach), and it
  earns that place because display intent is genuinely orthogonal to the address — the
  proving case is a workbench flow wanting a *quoted reference that is a live edge*.
  Fenced hard: behaviour never forks on it, queries never filter on it.
- **The ref-vs-attachment kind split dissolves into the scheme**, and the attachment
  kind is subsumed: one kind, `reference = { uri }` plus a derived face. Its src/uri
  fork was scheme dispatch before the vocabulary existed.
- **The container-vs-block grain dissolves into the path.** One internal scheme:

  ```
  sieve:{container}                  — a container
  sieve:{container}@v{n}             — pinned (the pin sits on the container segment:
                                       versions are per-container)
  sieve:{container}/{leaf}           — a leaf within it
  /{leaf}                            — relative reference against the current container
  ```

  `container:`/`block:` become parse-forever aliases; relative references are standard
  URI resolution rather than new grammar (#81 arrives free).
- **The asset scheme dissolves into the path.** An asset already lives inside a
  container (`Owns()`, the document directory, ExternalRef's derivation walk); the
  held-file arm becomes a relative sieve reference. Assets being immutable makes the
  pin trivial at the asset leaf: same key, same bytes, at any version — the only
  version-dependent fact is membership, and a version without the asset is an ordinary
  dangling resolve. Which yields the closing
  generalisation: **in terms of addressability, a block and an asset are the same thing**
  — leaf Nodes under a container segment. Payload (attrs vs bytes), lifecycle
  (versioned vs immutable), face rendering — all resolution facts, never addressing
  facts. The smart-image was the tell all along: a block wearing an asset. The scheme
  allow-list lands at `{sieve, https}`, with `file:` never admitted (the mint gesture
  copies to an asset — Shared categories cannot carry machine-scoped paths, and bare
  filesystem pointers cross the containment fence).

Discrimination is container-side *lookup*, never address-side inference: the container
checks its block index, then its assets; ids stay opaque.

### Order, the chain, and the prompt

Order is stored and authoritative at both grains — the chat spine in ask order, the
question list in the asker's arrangement — never derived from chain back-pointers.
"Containment arranges, refs describe" survives with the jobs split cleanly: order belongs
to the container, lineage to the block.

The chain folds into the question too: a follow-up's question *begins with* a pinned
reference to its parent exchange — a follow-up is literally a quote plus more words. In a
chat the container order carries the chain and nothing is written; the written pinned
reference in a first question is the **branch** (§8b's cross-document chain edge,
unchanged). Prompt assembly becomes role policy over observables — initially bucketed by
scheme/pin/grain to reproduce the tuned shapes, eval-guarded — with one genuinely new
class: the **pinned reference renders as QUOTED** (resolved snapshot, marked as cited
history so the role cannot mistake it for current state).

### What this settles for the chat (#102)

A chat is `List<AiBlock>` in ask order — native YAML, born Shared in the library, §5's
lifecycle unchanged. The flat spine means `DocView`, `BuildContext`, the THREAD walk and
the job engine work unchanged; every layer learns "chat" through a seam it already has
(Category value, `documentFromStoreable` branch, `ChatsSource`, `ChatCodec`, a PM-free
lens per §8). The turn, as a noun distinct from the ai-block, is gone.

### Costs, stated

- **Nested rendering in the note host.** A question *list* inside the ai-block NodeView
  is the hardest UI item in the plan (#101 Phase B); until it lands, single-prose
  questions render exactly as today.
- **The prompt spine refactor** (`qaHeader`/`buildPrompt` from attr-slots to list-folds)
  must be prompt-neutral on day one — the eval corpus is the guard.
- **Stage E, softened but touched.** This is not a `Children` field: it is a kind whose
  *payload* contains blocks — the diagram block embedding fenced code is the precedent,
  and the 4-space literal discipline already protects it. Question-list fragments are
  deliberately not externally addressable; the citable unit is the exchange, and the
  rare fragment that deserves an address gets promoted.
- **A kind is renamed on disk** (`attachment` → `reference`) via deserialize-time alias
  — the same sugar move as the question scalar, `ref`, and `attachments` attrs; no
  sweeps, no dual-read windows anywhere in the design.

### Where this leaves the series

§8a's footnote keeps winning: first the workbench edge, then the branch, now the entire
reference apparatus — each time a mechanism dissolved, the address grammar picked up the
weight. What is left of the ai-block is one sentence: **a question that is a list of
blocks, an answer, and nothing else** — with pointing a kind of block, freezing a
property of an address, and the chat just a container that holds exchanges in the order
they were asked.

---

## 9. Deliberately unresolved

- **Role formalisation shape** — the Go type for protocol roles (template + schema +
  validator + repair + assembly + obligations): part of the job declaration, or a
  sibling? Decide when the evaluator is built.
- **Turn grammar strictness** — must turns strictly alternate? System/tool turns later?
  Keep the grammar loose until a second chat-shaped kind exists.
- **Attachment size discipline** — materialization copies content into the chat; huge
  attachments want a summary-only mode or asset offload (#38 interplay).
- **Versions tool scope** — self-history only (current lean) vs any-readable-artifact
  history; revisit when a role actually wants cross-artifact time travel.
- **Chat sync semantics** — born-shared + two machines; optimistic lock probably
  suffices for append-mostly, but resume-on-both-sides needs a think before the S3 era.

---

## 10. Where this leaves the series

Brainstorm 2: one primitive, six costumes. Brainstorm 3: the primitive scales upward.
Brainstorm 4: blocks are stored things; editors are lenses; filing is publication. This
one: **the AI is roles in a protocol, not prompts; conversations are typed documents;
and one axis — read vs interpreted — decides storage (markdown vs YAML), editor
technology (PM vs forms vs rendered DOM), and AI memory (state-in-artifact) all at
once.**

The buildable sequence hiding in it, roughly: renderer/NodeView split → chat kind
(`.chat`, chat lens, Chats section) → role formalisation with the workbench evaluator →
versions on the MCP → attachments. Each step useful alone; none blocked on transclusion,
which stays parked.
