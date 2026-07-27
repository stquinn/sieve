# Brainstorming 6: The Source Editor and the Host

Companion to [brainstorm-smart-code-blocks.md](./brainstorm-smart-code-blocks.md),
[brainstorm-smart-code-blocks-2.md](./brainstorm-smart-code-blocks-2.md),
[brainstorm-blocks-all-the-way-up.md](./brainstorm-blocks-all-the-way-up.md),
[brainstorm-email-workbench-and-block-store.md](./brainstorm-email-workbench-and-block-store.md) and
[brainstorm-ai-protocol-roles-chats-and-document-kinds.md](./brainstorm-ai-protocol-roles-chats-and-document-kinds.md).

Brainstorm 2 found the primitive. Brainstorm 3 pushed it up to the tab. Brainstorm 4 made
blocks stored things and editors lenses. Brainstorm 5 found that one axis — read vs
interpreted — decides storage, editor technology, and AI memory together.

This one starts from a small, concrete question ("should code blocks use CodeMirror?") and
falls through the floor into the noun the model has been missing: the **host**. By the end
it overturns two standing verdicts — one in brainstorm 2, one in brainstorm 5 — and
discovers that the machinery for all of it is smaller than any previous chapter assumed.

*2026-07-27. A thinking document, not a spec.*

---

## 0. The one-sentence model

> A block lives in **one place**. Everything else is a **lens onto it, in a host, at some
> viewport** — and once that is true, the editor technology, the home of the conversation,
> and the shape of a workbench all stop being separate questions.

Brainstorm 4 said "the block is the atom; the editor is a lens." That sentence had a hole
in it nobody noticed: a lens has to be *held* by something. The thing holding it is the
host, and it has been built six times without ever being named.

---

## 1. The question, and the fourth category

The entry question was narrow: the code block's highlighting is mediocre, its indentation
is fixed at two spaces, it has no bracket matching, folding, or multiple cursors — and the
machinery underneath it (a `MutationObserver` on `contentDOM`, a `lastSource` guard against
phantom updates, a decoration plugin) is fragile. Is CodeMirror 6 the answer?

Brainstorm 5 §8 already contains the rule that decides it, and states it one category short:

> **PM where text is *worked*** · **a form where text is *submitted*** · **rendered DOM
> where text is *read***

That rule was derived while reasoning about chats, where the missing case never arises.
Code is text that is **worked**, so the rule assigns it to ProseMirror — which is how the
code block got built. But code is also, by brainstorm 5 §7's own axis, **interpreted**, not
read. The rule collides with itself exactly once, and code is where.

Completed:

| Text is… | Editor |
|---|---|
| prose, worked | ProseMirror |
| **source, worked** | **CodeMirror** |
| submitted | a form |
| read | rendered DOM |

And then §7's principle lands on editor technology with real force. Brainstorm 5 said
storing a chat as markdown-with-delimiter-comments "would be pretending." The lowlight
decoration plugin is the same pretence one layer up: regex highlighting painted as
ProseMirror decorations over a `content: 'text*'` node, because the substrate has no concept
of a grammar. Lezer is what "interpreted" looks like in editor technology.

> `markdown : YAML :: ProseMirror : CodeMirror` — the same axis, applied to the editor
> instead of the file.

This is not a new dependency argument. It is completing a doctrine the series already
discovered.

### What the swap deletes

The honest surprise: adopting CodeMirror is a net **deletion**.

- The `MutationObserver`, the `lastSource` phantom-edit guard, and `ignoreMutation` all
  collapse into one `updateListener`. The entire class of bug where a decoration-only
  re-render emits a spurious `source` update — the one that let a stale heuristic clobber
  the AI's detected language — stops existing, because highlighting is no longer a
  ProseMirror decoration.
- The decoration plugin goes. Note what it does today: on **every** `docChanged` it walks
  the whole document and re-highlights **every** code block from scratch. Five code blocks
  in a document means typing one character re-parses all five. Lezer is incremental.
- `indentWidth: 2`, hardcoded per kind, becomes language-driven indentation.

The PM node flips from `content: 'text*'` to an **editable atom** with no `contentDOM` —
which is also the first concrete instance of the leaf side of brainstorm 3 §5.2's widening
("'block' has to span leaf ↔ container… wider than today's contentEditable-false atoms").
The only true atoms today are `smart-card` and `smart-image`, and both are read-only display
cards. An **editable** atom does not yet exist in the system.

---

## 2. What the codebase had already said

Two findings from reading the tree, both of which turned out to be load-bearing.

**The consumer face was always allowed to grow; the producer face was not.**
`expandable: true` is declared on diagram and smart-image, and `ui/media-lightbox.js`'s
`expandBlock` is a **real, shipping, non-ProseMirror host**. A second viewport already
exists. But `DiagramRenderer.expandContent()` returns `null` in edit mode, and the
interaction policy says it plainly in a comment — *"nothing to expand right now (diagram
edit mode)."* The rendered face can be any size. The **source** face has exactly one size,
inline, because ProseMirror is the only thing in the system that can edit.

That is the gap, documented by the code in its own comments, sitting precisely where
CodeMirror moves.

**The host has been built six times.** `media-lightbox.js`, `command-popup.js`,
`ask-panel.js`, `search-overlay.js`, `insert-dialogs.js`, and the tab/workspace pair. Each
hand-rolls its own viewport, focus entry and exit, escape semantics, and key precedence.
None share a contract. (Related drift: `focus-context.js`, which brainstorm 3 §1 cites as
"the first brick already laid," no longer exists; `--surface-*` was only ever a named gap,
never built. Brainstorm 3's §1 note is stale.)

Six ad-hoc implementations is evidence the abstraction is real. It is **not** permission to
design it up front — see §9.

---

## 3. Host: the missing noun, and the two axes inside it

The model had two nouns and needed three:

- **block** — the data. Named, built.
- **lens / renderer** — attrs in, DOM out. Named, built (the 2026-07-21 renderer/NodeView
  contract).
- **host** — *where* a lens is instantiated. Unnamed, rediscovered per feature, six times.

The temptation is to call this "responsive design" and reach for a `viewport` parameter.
That is half right, and the half it gets wrong matters.

**Size** — how much room do I have. This genuinely is responsive design: one DOM root, CSS
container queries, gutter width and header collapse and whether both faces of a diagram show
at once. The renderer needs **no input at all**. It does not know how big it is and does not
need to.

**Containment** — what am I *inside*. Not derivable from size, and not expressible in CSS. A
lightbox has no ProseMirror around it whether it is 400px or 2000px wide: there is no outer
caret, so boundary-escape keys are meaningless and `Esc` closes instead; there is no outer
history, so the source editor's undo *is* the undo. A code block inline in prose at that same
400px behaves completely differently. Small-non-PM and large-non-PM are identical;
small-PM and small-non-PM are not.

> Size scales for free. Containment never scales — it is a fact about the neighbourhood,
> not the dimensions.

And containment turns out to be **tiny**. The host tells the lens two things:

1. **Is there an outer caret?** (so boundary-escape keys mean something)
2. **Is there an outer history?** (so blur should emit an aggregate undo step)

That is the entire contract discovered so far. Everything else that felt like it needed a
host protocol is CSS.

---

## 4. Three consequences of host-blindness

### 4a. The flip is viewport-specific, not kind-specific

Brainstorm 3 §1 said the flip is "sugar over two wired nodes, show one at a time." It never
asked *why* one at a time. The answer is: **because there isn't room for both.**

Give a diagram a full viewport and you show source and render side by side. No toggle, no
mode. `Mod+Enter` degrades from "switch modes" to "move focus to the other face" — and at a
large enough viewport it has nothing left to do.

Which means `modEnterTogglesMode` is not a property of the kind. It is a property of the kind
**at the inline viewport**. The editor interaction contract currently describes a
viewport-specific behaviour as though it were intrinsic.

> This is a live defect in a normative document, and it exists with or without CodeMirror.

### 4b. Four grains of undo, each owned by one layer

Making the source editor host-blind forces the undo question, and the answer turns out to be
a ladder rather than a conflict. Each grain lives at a boundary the others cannot see:

| Grain | Owner | Boundary |
|---|---|---|
| Keystroke groups | the source editor | inside the block |
| One block-editing session | ProseMirror | the host boundary (blur) |
| Milestones (§8) | the user | the subject relationship |
| Every save | FileStore | the store |

Brainstorm 5 §8 already called version history *"the deep undo"* and observed that chats need
no undo stack. This generalises it: **undo is layered because hosting is layered.** In a
lightbox or a tab there is no surrounding history, so the source editor's own history simply
*is* the undo; inside ProseMirror the host contributes one aggregate step at blur.

The practical consequence for the inline case: today the code text lives in the PM document
as text nodes, so PM's history covers it. After the swap it does not, and the host must
supply the aggregate step deliberately.

### 4c. N instantiation, not relocation

If a lens does not know where it is, it can be instantiated **twice**. That is the
precondition for everything in §5 onward.

It also puts one requirement on the source editor from day one: it must be **a view onto a
source of truth**, not the owner of its text — so it needs a clean apply-external-change path,
not just an outbound report. CodeMirror handles this natively (external edits arrive as
transactions), but only if the class is designed that way. Nearly free now; the retrofit means
inverting who owns the document.

---

## 5. The workbench is a document with a subject

The use case that opened the trapdoor: you are writing a document, you have a code block, you
want AI help on it. You open it in a workbench — a separate surface with a conversation, and
maybe a console — and **the block stays the same block**. Work done there refines the document
underneath, because there is only one block.

Brainstorm 5 §6 appears to forbid this. It commits to *"refs in turns **freeze**; refs in roles
**re-read**"*, and rules out watchers and live sync.

There is no collision. **This is not a chat.** A chat turn is an *utterance* — historical, so it
freezes. A workbench is an *evaluation* of current state, so its role re-reads. Brainstorm 4 §1's
originating complaint was literally *"replay against the latest state doesn't exist."* Brainstorm 5's
rule already sanctions this; it simply was not ruling on this case.

Which generalises the type system one notch past brainstorm 5 §4:

- **Chat** = `List<Turn>` — no subject. Attachments freeze.
- **Workbench** = a document **plus a subject coordinate** — the subject re-reads; turn refs
  still freeze.

The email workbench is this with the subject being a draft. The code case is this with the
subject being a code block. So the freeze/re-read heuristic becomes one structural question:

> **Does this document have a subject?**

And the workbench itself is barely a type. It is an ordinary document — holding ai-blocks,
turns, console output, rendered however its lens likes — distinguished from a Note by **one
field**. Brainstorm 3 §2's "a tab type is just a seed," where the seed is a coordinate.

### The subject can point at itself — and often does

Sometimes the workbench **owns** its subject. Brainstorm 4's email workbench is exactly this:
the draft it evaluates lives inside it, because a pasted thread has no source document. And a
code workbench opened from nothing — just start brainstorming code, with an AI and a console —
is the same: the workbench is the block's only home.

So self-versus-remote is **not a kind of workbench. It is a state**, and a workbench can be born
in either one:

| | Subject | Machinery required |
|---|---|---|
| **Chat** | none | — |
| **Workbench, self-owned** | its own block | nothing beyond the type |
| **Workbench, remote** | another document's block | global coordinates · subscription · detach |

The consequence is worth stating plainly, because it moves work *earlier* rather than later:
**a self-owned workbench needs none of §7.** No live edge, no second subscriber, no attach or
detach, no global address — the role re-reads a block it already owns. Both brainstorm 4's email
workbench and a scratch code workbench can be built on the block store alone.

Which relocates the hard part. It was never "build workbenches." It is **letting the subject
coordinate point outside the document** — one address widening, exactly as §7 describes. The
self-owned workbench proves the type; the remote one spends the coordinate.

### Attach and Open-in are the same door from opposite sides

Once the subject can move, the verbs of §8 fall into a symmetry. A block has exactly one home,
so any transfer must name it:

- **Open in workbench** — the document owns the block; the workbench comes to point at it.
- **Attach** — the workbench owned the block; the document takes it, and the workbench is left
  pointing at its new home.

Both end in the *same* configuration — document owns, workbench remote — entered from opposite
sides. Which means the only genuinely interesting question about a block is whether it has a
document home yet, or whether the workbench is still the only place it lives.

That rhymes with brainstorm 4 §4's *born Isolated → filing is publication* without being the same
axis: that one is library-level (isolated host state → shared library), this one is
document-level (workbench-local → owned by a document). Both are "scratch becomes referenceable,"
at different scales. Worth keeping distinct even though the shape repeats.

### And this is the code scratchpad tab, without the inversion

Brainstorm 3 §2's table already predicted the tab type — *"Code scratchpad · root producer = code
· default consumer = terminal · run · stdout."* A born-self code workbench **is** that tab: a code
block it owns, a conversation, a console.

But brainstorm 3 §5.1 priced that tab at a *"genuine inversion, not a refactor"* — making
ProseMirror one root flavour among several. The workbench does not need it. It is an ordinary
document with a lens, and §3's host-blind renderer can draw a code block full-bleed with no
ProseMirror anywhere in the frame.

So the specific prize arrives cheaply. To be honest about what that does *not* buy: brainstorm 3
§3's general claims — free embedding and extraction for every kind, responsive rendering
everywhere, unified chrome — still require the inversion. This is one instance obtained without
the generalisation, which is a good trade only as long as nobody mistakes it for the
generalisation.

---

## 6. Two standing verdicts this overturns

### 6a. The conversation leaves the document

Today, asking the AI puts an ai-block **in** the document. The conversation is the residue and
the document carries it. Brainstorm 4 §1 named this as a defect — *"a trail of follow-up
ai-blocks — conversation state living in the wrong place"* — and brainstorm 4 §2 fixed it
*within* a block, by moving argument state onto annotations.

The workbench fixes it at document scale, in the opposite direction: **the work stays in the
document and the conversation leaves.** Joined by a coordinate, not by containment. When you
return to the document the code is refined and the argument is somewhere else — along with the
console runs, the dead ends, and everything else that was never knowledge.

That is a cleaner answer than the annotation one, and it retroactively explains why
ai-blocks-in-the-document have always felt like litter.

### 6b. Quarantine has a home — so execution is back on

Brainstorm 2 §10 ruled Server Sieve and running processes **"Out / quarantine"** on the grounds
that *"a running process isn't a fact,"* and §8 held that *"'keep live' dies on filing."* The
whole executable-blocks vision from brainstorm 1 was gated on a mission filter it could not
pass — because there was nowhere for ephemeral execution to live except the document.

The workbench is the drawer. Console runs, stdout, failed attempts and the conversation all live
in a separate storable with its own lifecycle; the document receives only the refined code. So
the verdict stops being a rejection and becomes a **routing rule**: execution is in — it just
does not live in the document.

Brainstorm 2 §10 predicted this without having anywhere to point:

> *"The filters decide which **drawer** a thing lands in… not whether it's allowed to exist."*

There was no drawer. Now there is. It also explains why brainstorm 2 §13's "build the atom —
editor + Run + stdout pane" never felt buildable: it was sited wrong. **Editor + Run + stdout
is the workbench**, and was never an inline block.

(The capability tiers and runner seam of brainstorm 2 §9 apply unchanged, and the containment
profiles from #36 already exist.)

---

## 7. The edge is a coordinate — and everything is a container

The strong temptation at this point is to build a graph: an edge table, a node registry, stored
back-edges, a persistent reactive engine. **None of that is needed, and brainstorm 2 §3 already
said so** — a block *"declares its references (its edges)"*, and the graph is **assembled** from
those declarations. It is an ephemeral, load-time index, not stored state.

So the whole relationship is: **the workbench document holds a coordinate.** One direction. No
back-edges. Resolved on load.

Brainstorm 5 §8a already defines the address, and — worth noting — did so in an **addendum**,
added the same day, almost as a footnote. It is now the load-bearing piece of three separate
ideas:

```
sieve:{doc-uuid}              — a document
sieve:{doc-uuid}/{block-id}   — a block within it
…@v{n}                        — optionally pinned to a version
```

The pin is the semantics. **Bare = live edge. Pinned = frozen snapshot.** §8a described only the
pinned half, treating `@v{n}` as *"provenance metadata first."* Both halves were always there.

Stated at its real size, the architectural delta is:

> Today's ai-block refs are one-directional and document-local. Coordinates are one-directional
> and **global**. That is the entire change — the address gets wider, the mechanism does not
> change.

Three things fall out, and all three are *absences* of work:

- **Backlinks are computed, never stored.** "What is open on this block?" is a load-time scan or
  the #37 index — which is exactly what brainstorm 5 §8a predicted would finally make that index
  load-bearing.
- **Dangling is a normal state, not an error.** Delete the owning document and the workbench fails
  to resolve and shows what it last knew: brainstorm 2 §3's *"orphaned but readable."* No cascade,
  no integrity pass, no cleanup job.
- **The block lives in one place, so there is nothing to merge.** Ever.

And the transport worry shrinks accordingly. There is **one writer** — the owning document's
`ShadowDocument`, unchanged, still the source of truth — and N views subscribing to it. The
workbench does not hold a copy; it writes through to the owner. The one-channel-per-uuid rule in
the WS handler has to become a subscription, which is genuine work, but it is **routing, not
distributed state**: no conflict resolution, no second authority.

### It is a Router, not a reconciler

Brainstorm 2 §3 named the thing that owns the edges **the reconciler**, and gave it a build-system
job description: dirty sets, topological order, cascade policy, cycle detection. That is a
*reactive* component, and it is the right design for the executable-pipeline vision brainstorms 1
and 2 were reasoning about.

**Nothing in this chapter needs it.** What the workbench actually needs is far smaller: something
that turns an address into a Node. Ask for the workbench's subject and the framework resolves the
coordinate and hands you the block. No dirty set, no topology, no cascade tier, no cycle detection
— because nothing here recomputes. It joins dots.

That is a **Router**, and the name matters because it separates two components brainstorm 2
conflated:

| | Job | Needed by |
|---|---|---|
| **Router** | address → Node | everything in this chapter |
| **Reconciler** | propagate staleness through a dependency graph | the reactive pipeline vision only |

The practical payoff is a de-risking. It is tempting to read §5–§8 as "the reactive engine arriving
early wearing chat clothes." It is not. The workbench story needs address resolution and nothing
else; the reactive machinery stays parked exactly where brainstorm 2 left it.

Sieve already has the shape of this one layer down: chi routes HTTP paths to handlers. A Router
routes coordinates to Nodes — same move, different address space. And it layers cleanly onto what
exists:

- **Local address** (within the open document) — a lookup in the `ShadowDocument` tree.
- **Global address** (another document) — the #37 metadata index, which is exactly the load-bearing
  role brainstorm 5 §8a predicted for it (`LoadByUUID` is documented O(n)).

The Router hides which. Which is the precise, unglamorous reason §5's "one address widening" is the
whole delta: the interface does not change, it grows a second backing store.

### The Router federates over container services

Resolution is not one lookup — it is a dispatch. The Router holds `DocumentService` today, and in
time a service per container runtime, resolving each by id:

| Container kind | Resolved through |
|---|---|
| Note / Buffer | `DocumentService` |
| Thing | `ThingsService` |
| Chat | `ChatService` |
| Workbench subject | `WorkbenchService` |

Ask for the workbench's subject and the framework hands the coordinate to the Router, which picks
the service and returns the Node. Callers never learn which runtime answered.

**This already exists, one generalisation down.** `DocumentService.documentFromStoreable` switches
on `Category` to build a Note or a Buffer — a router over two container kinds, keyed by category
instead of by address. Brainstorm 4 §4 already spotted the seam: *"documentFromStoreable is the
seam: a block case beside Note and Buffer."* Growing it into a registry keyed by address is a
smaller move than inventing one.

And it retires a wart the series has been predicting. `RefreshTabStatus` special-cases prompt tabs
with `strings.HasPrefix(out[i].ID, "prompt:")` — brainstorm 4 §6 predicted this hack would dissolve
once "which editor over which storable" became a real mechanism. Under a Router it does: `prompt:`
stops being a string test and becomes an address scheme with a service behind it, indistinguishable
from every other kind.

### Thought experiment: only a BlockService

Push it all the way and the containers stop holding anything at all: a Document becomes an ordered
list of block **ids**, every container references a shared block index, and there is exactly one
storage service. The full culmination — everything is a block.

**At runtime this is already true.** `ShadowDocument` holds the block tree addressed by id; a
document in memory *is* a list of addressed blocks. So the experiment is not a question about the
model at all. It is a question about the **record**.

### What the MCP changed about that question

Markdown-on-disk was carrying several jobs at once, and the internal Sieve MCP (#36) has taken some
of them cleanly:

| Job | Still needs markdown on disk? |
|---|---|
| Agent / tool access to the corpus | **No** — the MCP is better: structured, permissioned, queryable |
| User full-text search | Partly — MCP search is metadata-only today, so ripgrep still wins until #37 |
| Reading without the app | Yes — an MCP needs a client too |
| **Durability past the app** | **Yes, and nothing else can supply it** |
| Diffability | Mostly not — FileStore history already covers it |

The convenience argument (*"`cat` returns nothing"*) is now largely answered. The argument that
survives is the durable one — **the record must outlive its reader.** A file is a file; an MCP is a
running server that exists only while Sieve does, and brainstorm 2 §8 is explicit that the filed
half of the system is a decades-long knowledge base.

So the constraint is not *"storage must be markdown."* It is:

> There must be a **lossless, app-independent projection**, produced automatically rather than on
> demand by a running app.

Which is weaker than it was, and admits options a flat "no" would have hidden:

| | Record | Durability | Cost |
|---|---|---|---|
| **a. Document is the record** | markdown on disk | free | containers can't share blocks |
| **b. Index is the record + eager mirror** | block index, markdown written every save | preserved | write amplification, drift risk |
| **c. Index is the record, export only** | block index | lost | cheapest, most capable |

Option (b) is brainstorm 5 §7's *"export renders"* run eagerly instead of lazily, and it is
genuinely on the table now in a way it was not before the MCP.

Three engineering costs apply to (b) and (c) alike, and the current design gets all three free:
blocks outlive their containers and need real garbage collection; "the document as it was" becomes
a distributed snapshot across a manifest version plus N block versions, so FileStore's history stops
being free; and loading a document becomes N reads instead of one.

**Current lean: (a) for Notes, and the question is already per-kind anyway.** Chats went to YAML
(brainstorm 5 §7) and Things to `.block` YAML (brainstorm 4 §4) — the *interpreted* kinds have
already left markdown. The only kind still under the constraint is the Note, which is the one whose
entire purpose is being read. Holding onto it is still right; the grip is looser than it was, and
the loosening is worth revisiting when #37 makes MCP search body-aware.

Meanwhile the payoff can be had without touching the record: **the block index is derived, the
document is the record.** A global id → location index is what #37 already is, extended one field —
Router resolution goes global, notes stay readable, no GC because the index rebuilds, history stays
per-document. Consistent with §7's other rule: backlinks are computed, never stored.

### The generalisation: containers of addressed blocks

Follow the coordinate one step further and the four "document kinds" this series has accumulated
stop being four mechanisms.

> **Everything addressable is a Node. A block is the leaf; a container is a Node that holds
> other Nodes.** Containers differ from one another only in **arity** and **element
> constraint** — nothing else.

| Container | Arity | Element constraint |
|---|---|---|
| **Note** | many | none — `List<?>`, the wildcard |
| **Chat** | many | `Turn` (itself a container — brainstorm 5 §6) |
| **Thing** | one | any block kind |
| **Workbench subject** | one | any block kind |

Brainstorm 5 §4 named this and stepped back from it: *"the full generalisation — 'kinds are
schemas over block structure' — is the brainstorm-6 cliff edge; noted, not walked off."* This is
the step off. A document was never privileged; it was always the wildcard container, and its
privilege was an artefact of being built first.

**And containment is an address relationship, not a physical one.** A container holds addresses.
Self-owned means the address resolves within me; remote means it resolves elsewhere. There is no
"holds versus points at" distinction to design — §5's self/remote states are the same field
resolving to different address spaces. That is *why* a block lives in one place: the place is
whichever address space minted it.

### Which dissolves a strain in brainstorm 3 — and the code already decided how

Brainstorm 3 §5.2 flagged a genuine problem with blocks-all-the-way-up:

> *"'Block' has to span leaf ↔ container. The prose root is multi-child; a spreadsheet root is a
> single rich leaf. The abstraction must comfortably cover both, which is wider than today's
> contentEditable-false atoms."*

The tempting resolution is to say containers simply *are* blocks — a document is a block with
children — which would make brainstorm 3's title literally true. **The codebase already considered
that and chose a third path.** `sieve/block/sieve_block.go`:

> *"There is no Children field: a block is a LEAF. Containers (columns) are a distinct structural
> type — they HOLD blocks but are not blocks (no payload, no content) — and arrive in **Stage E**
> behind a small **Node interface (ID()/Kind())** both implement."*

And the wire already carries `ParentID`, rejected at runtime with *"nesting into parent %q is Stage
E (no Children yet)."* The seam is cut and reserved.

Three options, then, and the committed one is the best of them:

| | |
|---|---|
| Containers **are** blocks | one type, but a container is forced to pretend it has a payload |
| Containers and blocks are **unrelated** | honest, but nothing can traverse or address them uniformly |
| **Containers and blocks are distinct, unified behind `Node`** | polymorphism without identity |

So blocks-all-the-way-up **is** achieved — at the level that actually matters. Everything is a
`Node`: everything has an id, a kind, an address, and can be walked, targeted and rendered
uniformly. What is *not* claimed is that a container has content. It never did.

Strictly, the ladder is **Nodes all the way up**, and the block is its leaf.

### The coordinate scheme was already the Node interface

Look again at brainstorm 5 §8a with that in hand:

```
sieve:{doc-uuid}              — a document   (a container Node)
sieve:{doc-uuid}/{block-id}   — a block      (a leaf Node)
```

Those are not two address forms. They are **one address form over `Node`**, written before the
interface existed to explain it. Which is why §7's generalisation costs nothing to adopt: the
address scheme has been quietly uniform since it was drafted as a footnote.

It also decomposes brainstorm 3 §5.1's *"genuine inversion, not a refactor"* into two independent
halves, and only one of them is hard:

1. **The model half** — containers behind `Node`. Planned as Stage E, scoped, modest.
2. **The shell half** — hosting a non-ProseMirror lens at a tab root. This is §3's work, and it is
   the half brainstorm 3 was actually describing when it said "ProseMirror owns the world."

Brainstorm 3 read those as one problem. They are not, and separating them is what makes the
scratchpad tab in §5 reachable without the inversion.

It also strengthens brainstorm 2 §1's decomposition rather than competing with it. The fused
diagram widget — *"two nodes pretending to be one"* — is a **container of two blocks**, source and
render, and the flip is the container's lens choosing which child to show. Compose that with §4a
and it falls out that at a large enough viewport the container simply shows both. Same mechanism,
no special case.

The honest caveat: this is a **lens on the model, not a licence to build a container engine**.
Nothing in §10 changes because of it. Brainstorm 3 §7's warning applies with full force — the
generalisation earns its keep by explaining what already exists and predicting what comes next,
and it stops earning it the moment someone tries to implement it directly.

---

## 8. Verbs, and the floor

### Fork is the wrong word

The natural reading of "fork" is *copy from here and start a new lifecycle*. The entire point of
this operation is that there is **no copy** — same block, same coordinate, same home. Calling it
fork sets exactly the wrong expectation: the user would assume the document is safe, when in fact
the document is being refined under them, which is the feature.

The honest verb is the one the host model already implies — **Open in…** (*Open in Workbench*,
*Open in Chat*). Same object, another host, no transformation. It makes the no-copy semantics
obvious from the word alone, and it keeps "fork" available for the operation that genuinely
deserves it.

| Verb | Meaning |
|---|---|
| **Open in \<host\>** | a second live view; same coordinates, no copy |
| **Attach** | create the edge — a document takes a live block |
| **Detach (keep \| revert)** | break the edge; choose which value survives |
| **Fork** | *reserved*: copy, new identity, new lifecycle |

### Detach is a decision, not an operation

Brainstorm 2 §7 defines "Embed in Document" as Excel's **Paste Special → Values** — drop the
formula, keep the **current** value. But the natural detach in a live-edge world keeps the
**pre-open** value: reject the work, restore what was there. Those are opposite outcomes and both
are legitimate:

- **Detach-keep** — accept the work, cement the current value. Brainstorm 2 §7's Embed.
- **Detach-revert** — reject the work, restore the floor.

The series only ever described the first, because until the edge was live there was nothing to
reject. So breaking a live edge needs an outcome, the way close-time triage needs keep-or-discard.
Pleasingly on-mission: Sieve's whole grammar is *decisions happen at boundaries*.

Read through §5's self/remote lens, the verbs get an economical definition: **detach-keep collapses
the coordinate to self.** The workbench stops pointing outward and owns the block; the document keeps
the refined value. Which also explains brainstorm 4 §5's "Extract draft" retroactively — extract is
detach on a workbench that was self-owned all along, pushing the subject *out* instead of pulling it
*in*. One mechanism, run in both directions.

(Keep this distinct from brainstorm 4 §4's *born Isolated → filing is publication*. That is a
lifecycle axis; this is an edge axis. Easy to conflate later.)

### Milestones: what makes the live edge safe

A live edge means the document mutates while you are elsewhere. That is alarming, and the reason
is that there is no agreed rollback point at document scale.

**"I like this state — this is the new floor."** A milestone is a user-declared pinned coordinate,
so detach-revert falls back to the last floor rather than all the way to the opening state — a bad
final ten minutes does not cost the good hour. This is not bookkeeping for detach; it is the
precondition that makes live refinement tolerable enough to ship.

Three properties:

1. **Milestones are pinned coordinates held by the workbench document.** No edge object, no graph
   state, no new storage concept — the version suffix from §7 *is* the mechanism. Detach-revert
   writes the pinned version's content back through the channel that already exists.
2. **They belong to the workbench, not the block.** `Attrs` is a map, so hanging them on the block
   is cheap and tempting — and wrong. The block does not know it is attached; brainstorm 2 §3 is
   emphatic that back-edges live in the assembled graph, *"not inside the blocks."*
3. **They are user-owned.** "I like this state" is a judgement, not a measurement — the same family
   as `user_intent`. In a workbench where the AI is co-editing, auto-checkpointing on "the tests
   pass" would be the obvious convenience and would quietly relocate the meaning of *I approved
   this*. **AI recommends floors; it never sets them.**

Milestones can afford to be sparse and fallible precisely because FileStore's version history sits
underneath, complete and boring. Two layers, different owners, no competition (§4b).

---

## 9. Where it strains

1. **Do not build the host protocol.** Six ad-hoc hosts is evidence, not a specification.
   Brainstorm 3 §7 already named this temptation: *"frameworks get extracted from working products,
   never designed up front."* Build the source editor into **two** hosts, let the contract be what
   those two need in common, and stop. Two is the minimum to find a seam; four is speculation. The
   chat and tab hosts arrive with the block store and will correct whatever is written now.
2. **A second editor framework, permanently.** Brainstorm 5 §8's triumph was using *less* machinery
   (textarea + rendered DOM). This is the opposite move. The defence is brainstorm 3 §5.1, which
   explicitly predicts ProseMirror becoming "one root flavour among several" — heterogeneous editors
   are the stated destination, not a regression. But it is a real cost and should be named as one.
3. **Not every kind has three viewports.** A smart-link at tab scale is still a link. Kinds must
   *declare* which viewports they implement and how they degrade — brainstorm 2 §5's field 5 ("view")
   grows from one value to a small map — or "responsive" becomes an obligation every renderer fakes.
4. **Key precedence is the hard field, not layout.** With ProseMirror outside, a source editor inside,
   a lightbox around it and a command popup over that, "who gets this keystroke" is genuinely
   difficult. It is the one gap the command popup already surfaced, and CodeMirror makes it worse
   because it arrives with a large opinionated keymap. The interaction policy resolves precedence
   *within* ProseMirror today and has no concept of a host stack. That is the contract's real growth,
   and it may outlive the editor work.
5. **CodeMirror is a real dependency decision.** Vanilla JS, no framework, esbuild-bundled exactly like
   the TipTap vendor bundle — it fits the existing seam — but it is roughly fifteen packages and needs
   an explicit call.

---

## 10. The buildable sequence

Two phases, one epic. The second is the more valuable one, and it is a byproduct of the first
rather than a prerequisite.

1. **Source editor, inline.** CodeMirror inside the ProseMirror NodeView, held by the renderer
   through composition. Retires the `MutationObserver`, the phantom-edit guard and the decoration
   plugin; the node becomes an editable atom. `code` first, `diagram` immediately after — both are
   `rawText: true` today and splitting them would split the pattern. Ships the visible win alone.
2. **Editable expand.** The same renderer in `media-lightbox` at full viewport — a second host, no
   ProseMirror in sight. Extracts the containment contract (§3) from two *real* hosts rather than four
   imagined ones, and forces the key-precedence question while the blast radius is one overlay.

Constraints to honour from day one, all cheap now and expensive later:

- The source editor imports **nothing** from ProseMirror.
- It is a **view onto** a source of truth, with an apply-external-change path (§4c).
- No `viewport` parameter — size is CSS (§3).

**One spike before the design leans on any of it:** does a CodeMirror view survive being reparented
in the DOM? It owns a contentEditable and a mutation observer, neither of which obviously cares about
ancestry, but focus and scroll will need restoring. Phase 2's shape depends on the answer.

Sequenced further out, and *not* part of this epic: workbench as a document kind (needs the block
store — brainstorm 4 §8 layer 1), the coordinate scheme becoming global (needs the #37 index), and
live subscription in the WS layer.

---

## 11. Deliberately unresolved

- **Detach default.** Is detach-keep or detach-revert the safe default, and is the choice made at
  detach time or declared when the workbench opens?
- **Detach is directional and currently under-specified.** "Keep" from the document's side means it
  retains the refined value; from the workbench's side it means the coordinate collapses to self. Those
  are usually the same event, but they need not be — a workbench could release a subject it never
  wants to own. Decide when the remote case is real.
- **Extension parity across viewports.** Are folding, multi-cursor and search simply *on* everywhere,
  with CSS handling the cramped cases? If yes, host-blindness is exact. If no, something has to
  reconfigure on resize and the clean story frays slightly.
- **Where the containment facts come from.** The host constructs the lens, so it can pass them — but
  a lens moved between hosts (expand and back) needs them updated, not fixed at construction.
- **Key precedence model.** A host stack with explicit precedence, or per-host opt-out? Deferred until
  phase 2 produces a real conflict rather than an imagined one.
- **Multiple workbenches on one block.** Structurally free (coordinates are one-directional); whether
  it is *comprehensible* is a different question.
- **What the console's output is, as a thing.** Stdout in a workbench is quarantined by §6b, but if a
  run is ever worth keeping it needs a representation — and that is brainstorm 2's cement question
  arriving from a new direction.

---

## 12. Blue sky, registered

The workbench material in §5–§8 is where the conversation ran ahead of what is buildable — but the
line does not fall where it first appears, and §5's self/remote split is what moves it.

**Not blue sky:** the self-owned workbench, in either of its two births — brainstorm 4's email
workbench (already designed) and a scratch code workbench opened from nothing. Both need only the
block store (layer 1 of brainstorm 4 §8). No coordinates, no subscription, no detach. What this
chapter adds is a name for the shape, the observation that the subject field was always what
distinguished a workbench from a Note, and the finding that the code scratchpad tab arrives this way
without brainstorm 3 §5.1's inversion.

**Blue sky:** the remote subject — everything that follows from a coordinate pointing at another
document. It depends on the block store (not built), a global coordinate scheme (not built), the #37
index (not built), and live subscription in the WS layer (a real backend change). That is the
direction the feature set is heading, not the next thing to do.

What matters is that **nothing in the two-phase epic forecloses it**, and one constraint in §10 —
the source editor as a view onto a source of truth — exists solely to keep that door open. That is a
cheap price for a large option.

---

## 13. Where this leaves the series

Brainstorm 2: one primitive, six costumes. Brainstorm 3: the primitive scales upward. Brainstorm 4:
blocks are stored things and editors are lenses. Brainstorm 5: the AI is roles in a protocol, and one
axis decides storage, editor technology and memory together.

This one: **a lens needs a host; hosts differ by containment, not size; and a block that lives in one
place can be looked at from anywhere without being copied.** Which turns out to be enough to complete
brainstorm 5's editor doctrine, give brainstorm 2's quarantined execution a home, move the
conversation out of the document, and make the whole reference apparatus one field wider than the
refs that already exist.

It also quietly delivers brainstorm 3's code scratchpad tab by a side door. Brainstorm 3 priced that
tab at an inversion of the editor's root; the workbench gets it as an ordinary document with a lens.
Worth watching whether that keeps happening — if enough of brainstorm 3 §3's payoff arrives through
document kinds and host-blind lenses, the inversion may turn out to be a thing the model can approach
asymptotically rather than a wall it has to go through.

The recurring shape of this chapter is that almost every answer was **smaller than expected** — no
edge table, no viewport parameter, no graph, no watchers, one field on a document, one optional suffix
on an address that was already designed. The one thing that got *bigger* is the interaction contract,
which now has a host stack it does not know about.

Brainstorm 5 §4's cliff edge — *"kinds are schemas over block structure"* — is no longer ahead of
the series. §7 walks off it: containers of addressed blocks, differing only in arity and element
constraint. What that leaves in front is the consequence rather than the generalisation:

**If a block has an address and a container is a schema over addresses, then a lens works on an
address, not on a storable.** Brainstorm 4 §3 already moved lens selection from content-sniffing to
metadata; this moves it one further, to the address itself. Which is the point at which "open this"
stops needing to know what *this* is — and the point at which the same block genuinely can be
opened anywhere, by anything, because the only thing an editor ever received was a coordinate.

And a second edge beside it, unchanged: **if a host is a thing, what is the workspace a host of?**
