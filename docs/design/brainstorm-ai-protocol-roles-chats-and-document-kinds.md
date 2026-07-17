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
