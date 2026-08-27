# Brainstorming 4: The Email Workbench & the Block Store

Companion to [brainstorm-smart-code-blocks.md](./brainstorm-smart-code-blocks.md),
[brainstorm-smart-code-blocks-2.md](./brainstorm-smart-code-blocks-2.md) and
[brainstorm-blocks-all-the-way-up.md](./brainstorm-blocks-all-the-way-up.md).

Brainstorm 1 was blue-sky. Brainstorm 2 found the primitive ("one primitive, six
costumes"). Brainstorm 3 pushed it upward to the tab and workspace. This one arrives from
the opposite direction — a concrete, recurring, personal use case — and lands on the same
spine: the first block that *is* its own document, stored as a first-class thing.

*2026-07-17. A thinking document, not a spec.*

This started as "email threads paste badly" and ended somewhere much bigger: blocks as
first-class stored things with their own library section, editors as *lenses* selected by
metadata, and filing redefined as *publication*. The email workbench is the feature; the
block store is the discovery.

---

## 1. The originating use case

A recurring real workflow: refining an email reply in Sieve.

1. Copy a whole email thread out of the mail client, paste it into a scratch buffer with
   the draft reply on top.
2. Ask the AI for an evaluation of the draft.
3. Edit the draft based on the feedback.
4. Replay the ask when ready — the AI should always judge the **latest** draft.
5. Copy the finished reply back into the mail client. The buffer is probably discarded.

Today this fights the tool at every step:

- The pasted thread is full of `<angle@brackets>`, so it renders as an accidental code block.
- "Replay against the latest state" doesn't exist — each Ask is a fresh ai-block, and
  ai-block thread quotes are deliberately *stale snapshots*.
- Pushing back on the AI's critique spawns a trail of follow-up ai-blocks — conversation
  state living in the wrong place.
- The finished draft leaves via plain-text copy, and email clients don't speak markdown.

This is the scratchpad ethos in its purest form: **Sieve as the place where something is
crafted for use elsewhere.** The artifact ships from the mail client; the vessel is
ephemeral. That observation ended up driving the whole design.

Brainstorm 1 already contained the seed ("AI Chain re-evaluation … triggers a Replay —
therefore always up to date"). This use case is that idea with a concrete, personal,
recurring need behind it.

---

## 2. The refinement loop: annotations, not essays

The evaluation shouldn't be (only) an essay below the draft. It should be **inline, like a
grammar checker or an IDE**:

- The Ask uses a JSON contract: the AI returns a list of annotations —
  `{quote, verdict: good|weak, note, suggestion?}` — plus a long-form evaluation.
- Annotations anchor by **exact quote (+ occurrence index), never offsets**. LLMs quote
  reliably and count badly. Go validates every quote against the draft; non-matching
  annotations are dropped.
- The editor paints annotations as decorations — green/red tints over the draft, hover
  popover with the note. Decorations are editor-only overlays: **the file never contains
  highlight markup**, and they move with the text as you edit.
- Editing inside an annotated span marks that annotation stale (grey) — visibly "this
  feedback predates your change", reinforcing the replay loop.

### Apply and Refute — the two verbs of negotiation

Every *weak* annotation offers two actions:

- **Apply** — the popover shows the AI's suggested rewrite; applying swaps the span as a
  normal tracked, undoable edit. The AI proposes; the user disposes. `user_intent` stays
  user-owned in spirit: nothing changes the draft except a user gesture.
- **Refute** — a one-line pushback stored **on the annotation itself**. On replay the
  prompt carries each open annotation with its refutation, instructed to concede (drop) or
  re-argue (respond to the point). The annotation becomes a tiny per-span negotiation
  thread that lives and dies inside the block.

Refute is the fix for the ai-block-trail smell: the argument state moves into the artifact
being argued about, and replay becomes genuinely stateful instead of a cold read.

### The evaluation surface

The long-form evaluation doesn't get permanent real estate. **Mod+Enter flips the
workbench between draft view and evaluation view** — the same mode-toggle contract the
diagram block uses (`modEnterTogglesMode` + `onModEnter`), and the third instance of the
flip primitive from blocks-all-the-way-up. A slim strip ("4 issues · evaluated 2 min ago")
stays visible in draft view.

### The replay flow

Backend stays the source of truth: flush save → Go re-reads the document, extracts thread +
**latest** draft, runs the JSON-contract prompt through `RunCLI` with the standard
`JobTracker` + SSE lifecycle → validates the JSON → persists annotations + evaluation →
SSE completion. One active job per block; retry reuses the block ID; malformed JSON gets
one corrective re-prompt then ERROR. Quote-anchoring degrades gracefully if the user edited
mid-job: mismatched quotes simply fail to anchor and show stale.

---

## 3. The shape question: block? editor? — both

The longest argument of the session, worth preserving because the answer reframed the
architecture.

**Rejected: composed blocks.** Thread block + prose draft + replayable ai-block. Maximally
uniform, but the data (annotations, suggestions, refutations, evaluation) is far too heavy
to hang off normal prose; the experience wants one fused vessel.

**Rejected: draft as plain markdown inside a delimited container.** Storage-honest, but
the honesty buys nothing here — this artifact is *ephemeral*, ships via copy, and probably
isn't kept. Grep-ability of a discarded scratch vessel is worthless. Draft goes in the
YAML payload. (It also forced the hardest technical problem in sight: the first container
block with an editable content region.)

**Rejected: pure editor type.** An EmailWorkbenchEditor tab with no block underneath is
technically easy (the component model makes new editor types cheap: factory + contract,
zero shell changes) but leaves nothing embeddable, fileable, or referenceable behind.

**The synthesis: the block is the atom; the editor is a lens.**

- The workbench **is a block** — one fenced payload (`email-workbench`, `ew-XXXX` IDs)
  carrying thread, draft, ask, annotations, evaluation. `EmailWorkbenchProcessor` (Go)
  owns Serialize/Deserialize — Go owns all YAML, per the block-model rule (processor-owned
  serialization; note an earlier draft of this idea wrongly claimed the ai-block was
  JS-serialized — that predates the block-model pivot).
- When the block **is the document**, the tab opens a dedicated **EmailWorkbenchEditor**
  instead of the NoteEditor: thread panel + draft TipTap surface + evaluation flip. The
  draft surface is a plain TipTap instance — the editable-container problem vanishes.
- When the block is **embedded in an ordinary note**, it renders as a compact **read-only
  card** (ask, verdict summary, draft preview). One writer, N cheap readers — which also
  sidesteps the same-doc-in-two-tabs constraint for now.

Editor selection is driven by **metadata, not content-sniffing**: the storable's `.meta`
says it's an atomic block of kind `email-workbench`, and the component-model factory picks
the lens. This generalises an existing wart — prompt tabs are today special-cased by a
`"prompt:"` ID prefix in `RefreshTabStatus`; "which editor over which storable" was always
a real mechanism waiting to exist.

---

## 4. The block store: Things

The second discovery. If the block is the atom, the block deserves **its own storage** —
a new category, like prompts and config got — rather than living disguised inside `.md`
documents.

### Storage shape

The store was built for this without knowing it. Every document is already a directory
(`.meta` + `{uuid}.md` + assets + `.history/`). A stored block is the same shape with
`.meta` saying `type: "block", kind: "email-workbench"`, and the content file holding the
bare YAML payload (`{uuid}.block`). The fence is not the block's identity — it is the
block's **transport encoding for living inside markdown**, applied by the processor only
at embed time. `documentFromStoreable` is the seam: a block case beside Note and Buffer.

Free consequences:

- **Version history on blocks** — FileStore snapshots every save, so a workbench keeps
  draft history across replays. "Show me the draft before the last three Applies" is
  `RetrieveVersion`, zero new code.
- **Search** — Things have `.meta`, so the metadata index (#37) picks them up like
  anything else.

### Lifecycle: born isolated, filing = publication

Where does a block live? The deciding test is **referenceability**:

- Anything a durable note can reference must exist wherever the note exists → **Shared**.
- Anything in-flight wants per-host isolation so two machines never fight over the same
  scratch draft → **Isolated** (exactly why buffers are isolated today).

So blocks follow the lifecycle the system already has:

- **Born: Isolated.** Working blocks live in host-maintained state — reusing the
  `WorkingCopy` category (a working block *is* a working copy; `documentFromStoreable`
  branches on `.meta` type before category). Nothing can reference them yet.
- **Filed: Shared.** Close-time triage keeps its outcomes — discard, or keep — and *keep*
  moves the block into a shared blocks category. `store.Move` already migrates history
  across categories; this is the buffer→library mechanic pointed at a third destination.

**Filing is publication into the graph.** Unfiled = private scratch on this machine;
filed = a durable, referenceable, transcludable atom. The close-time AI recommendation
is now answering a crisper question than "keep?" — it's "does this enter the node table?"
The S3-future sync boundary stays exactly where it already is: shared syncs, host doesn't.

### Things in the library

Published blocks get their own section of the library — **"Things"** — with a
system-owned folder per kind. Not documents: *"something less and more powerful at the
same time."* The precise reading: a note is a **file** (free-form prose, user-arranged
folders, meaning lives in the text); a Thing is an **object** — typed, structured,
versioned, carrying behaviour and an editor lens. Less: no free-form body, no arbitrary
hierarchy. More: the system understands it.

The kind folders are physical, not just presentational: `blocks/{kind}/{name}/` on disk,
with the folder derived from `.meta` kind the way notes derive theirs from
`ai_folder_suggestion` — same `CreateOrLoadFolder` + `Reparent` machinery, different
derivation rule. No rename/move affordances inside Things: **the taxonomy is the type
system, not a filing cabinet.** A new block kind mints its folder on first publication.

### Creation: the new-tab chooser

The new-tab button grows a down-arrow. Plain click = Note, as today; the dropdown offers
the tab-creatable block kinds. **Registry-driven**: block kinds declare tab-creatability
(label, icon, editor factory) and the menu enumerates the registry — no per-kind UI edits.
Paste-detection is the second door: a paste that looks like an email thread (header lines,
quote density) offers "Open as email workbench" → new working block born from the paste,
originating buffer untouched.

---

## 5. Email-workbench specifics

The first inhabitant of the block store. Details agreed:

- **Thread panel** — heuristic JS parser splits the raw pasted thread on reply banners
  (`From:/Sent:`, `On … wrote:`, `>` depth) into message cards: sender/date header,
  quote-depth tinting, newest first, older collapsed. Presentation-only; the AI always
  receives the raw thread; unparseable chunks fall back to preformatted text.
- **Draft** — TipTap surface in the editor lens; annotation decorations as §2.
- **Copy draft** — dual-flavour clipboard: `text/html` (email-safe rendering — inline
  styles, `<p>/<b>/<a>`, no classes) plus `text/plain` fallback, so formatting survives
  the paste into Outlook/Gmail without markdown asterisks leaking. (Verify WebKitGTK
  `ClipboardItem` support; hidden-selection copy is the fallback.) Copying stamps
  `copiedAt` in the payload.
- **Extract draft** — promote the draft out as ordinary prose, for "make it real in the
  document" cases.
- **Close-time fate** — the workbench is a working copy, so triage applies natively. Its
  Rule-14 human-readable summary includes the ask, final draft, verdict, and whether the
  draft was ever copied — letting the AI reason "refinement vessel, shipped, recommend
  discard" or "never sent, still weak, recommend keep". The AI only recommends;
  `user_intent` remains user-owned.

A pleasing symmetry: the block is born from a paste, refined in dialogue, ships via copy,
and then argues for its own disposal.

---

## 6. Where this connects

| Prior thread | Connection |
|---|---|
| brainstorm-smart-code-blocks (§AI Chain re-evaluation) | Replay-against-latest, here made manual and user-paced |
| brainstorm-smart-code-blocks-2 | The blocks category **is the node table** of the reference graph; embedded cards are the cached-value half of the spreadsheet model |
| brainstorm-blocks-all-the-way-up | "Tab root is a block" — first realisation; Mod+Enter flip as the flip primitive |
| Workspace/editor component model spec (2026-07-08) | Editor lenses = the factory + contract mechanism, exercised for the first time beyond Note/Prompt |
| Prompt tabs (`"prompt:"` prefix hack) | Predicted to dissolve: a prompt is a block kind with an editor lens and the same publish lifecycle |
| Older rewrite-sections idea | Apply/Refute annotations are its first concrete form; section-refinement is the obvious second customer |

---

## 7. Deliberately unresolved

- **Annotation engine packaging** — ships inside the workbench, or carved out as a shared
  module from day one? Section-refinement will want it later; premature extraction is its
  own risk. Leaning: build it *cleanly separable* (own JS module, block-agnostic contract)
  but don't generalise until the second customer exists.
- **Transclusion** — reference-embedding (a note pointing at a stored Thing, rendered
  live) is the big unlock and the expensive tail: watchers, stale propagation, and a real
  fight with the same-artifact-in-two-views constraint. v1 embeds are read-only cards;
  copies are copies.
- **Prompt migration** — the model predicts it; nothing forces it. Leave prompts alone
  until the block store has proven itself.
- **Naming** — "Things" (honest, unpretentious) vs "Artifacts" (says *made-and-kept*).
  Current holder: Things.
- **Draft-while-job-running UX** — quote-anchoring degrades gracefully, but should replay
  be disabled while dirty, or should staleness just be visible? Currently: just visible.

---

## 8. Shape of the work

Three layers, buildable in order, each independently valuable — the epic/per-phase-issue
shape when this graduates to a spec and Forgejo plan:

1. **Block store & lifecycle** — blocks category (Shared, kind-foldered), block-kind
   working copies in `WorkingCopy`, filing-as-publication through existing Move machinery,
   triage awareness.
2. **Editor lenses** — editor selection by `.meta` type/kind via the component-model
   factory; registry-driven new-tab chooser; read-only embedded block card.
3. **Email workbench** — the processor, the JSON evaluation contract, the annotated
   draft surface (Apply/Refute), thread parsing, evaluation flip, dual-flavour copy,
   replay loop.

The email workbench is the feature that pays for the platform; the platform is the part
that outlives the feature.

---

## 9. Addendum (2026-08-27, post-#101): the anatomy got cheaper

Epic #101 (ai-block question becomes `List<Block>`; pointing is a kind of block)
changed this chapter's costs:

- **§1's originating defect is half-dissolved.** Replay-against-latest is structural
  now: bare references resolve current-at-replay and re-ask re-folds the question. The
  remaining half — the conversation living in the wrong place — is the chat/workbench
  remit.
- **§2's annotation state has a storage shape**: payload elements — identified children
  (`ident.New` uuids) inside the block's value, enumerable via the `BlockParent`
  capability, out of the document spine. Structure without hanging weight off prose. An
  annotation with a refutation is recognisably a tiny exchange, which the exchange
  record now covers. §5's parsed thread messages are the same shape.
- **§3's embedded read-only card exists generically**: full-anatomy `readOnly` record
  rendering through the renderer registry — every kind, one mechanism. §7's parked
  transclusion shrank with it: v1 is resolve-address → render-readOnly, no watchers.
- **§4's referenceability test is concrete**: an address reaches it, a role classifies
  it, the reference harvest walks it — the assembled graph brainstorm 2 promised is
  computable from shipped storage.
