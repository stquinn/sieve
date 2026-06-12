# Brainstorming 3: Blocks All The Way Up — the flip primitive across scales

Companion to [brainstorm-smart-code-blocks.md](./brainstorm-smart-code-blocks.md) and
[brainstorm-smart-code-blocks-2.md](./brainstorm-smart-code-blocks-2.md).

Brainstorm 1 was blue-sky. Brainstorm 2 was the synthesis "one primitive, six costumes."
This one takes that primitive and pushes it **upward** — past the block, past the document,
to the tab and the workspace — and asks: what if the *root object of a tab is itself a block*?

Still a thinking document, not a plan. It exists to capture a through-line that kept surfacing
while building the Ask-AI focus work, so the idea survives the code.

---

## 0. The one-sentence model

> A scratchpad is a place to put ideas and *see* them. Sieve does that with one recursive move:
> a **producer** (where you put the idea) wired to a **consumer** (which enriches the idea or its
> picture), with a **flip** between the two faces — and that move repeats at every scale, from a
> highlighted word to the whole tab. **Blocks all the way up.**

The markdown editor isn't the app with blocks bolted on. It's the **first and most elaborate
block flavour**, and the app is the substrate underneath it.

---

## 1. The flip primitive (the mechanism)

Every "smart" surface in Sieve has two faces and a flip between them:

| Surface | Producer face (author the idea) | Consumer face (see it enriched) | Flip |
|---|---|---|---|
| Diagram block | mermaid source | rendered SVG | Ctrl+Enter |
| Code block | source textarea | run / stdout (future) | Run |
| **The document** | prose you type | **AI enrichment (Ask panel)** | Ctrl+Shift+A |
| Spreadsheet (future) | the grid/data | chart | toggle |

The Ask panel was the tell. It *felt* like chrome, but structurally it's a **consumer bound to
the root node** (flavour = AI), rendered in the margin instead of inline. The document is the
producer; the Ask panel is its render/action face. `Ctrl+Shift+A` is the same flip as the
diagram's `Ctrl+Enter` — just one scale up.

### What a flip actually requires

Three contracts, identical at every scale:

1. **Keep-alive over teardown** — flipping should hide a surface, not destroy it, so its
   in-flight state survives for free (display toggle / in-place NodeView `update`, not `removeChild`).
2. **Focus/state preservation** — when a flip *does* tear a surface down (or you tab away to a
   transient one), remember where you were and restore it. *Ephemeral, never serialised.*
3. **Producer→consumer wiring** — the consumer references the producer; the reconciler owns the
   edge (brainstorm-2 §3).

### The decomposition tell (why the flip is sugar)

Brainstorm-2 §1 already said it: the diagram's dual-mode "felt strange" because it's secretly
*two nodes* — a source producer + a renderer consumer — fused into one widget. **Decomposed,
there is no flip:** the producer never dies, the consumer is just another view you look at. So
"flip" is sugar over "two wired nodes, show one at a time." That reframing is what makes the
upward generalisation cheap: if a flip is just *which wired node you're looking at*, there's no
reason the pair has to live inside a single block — or even inside the document.

> **This is already shipping in miniature.** The Ask-AI focus work split the interaction into
> *navigation* (Ctrl+Shift+A jump-out restores your exact caret — contract #2) versus *action*
> (SEND mutates the doc, so focus follows the action). `focus-context.js` captures "where was I"
> uniformly across the editor, a block's inner textarea, and the markdown pane — the **macro
> instance of the same focus-preservation contract** the micro source↔render flip needs. One
> mechanism, two scales. That convergence is the evidence the abstraction is real, not cute.

---

## 2. Tab types as producer/consumer pairs (the new move)

A "tab type" looks like a big feature decision. Under this lens it's almost nothing:

| Tab type | Root producer flavour | Default consumer (the margin) |
|---|---|---|
| Markdown note (today) | prose | AI / Ask panel |
| Code scratchpad | code | terminal · run · stdout |
| Spreadsheet | tabular data | chart renderer |
| Canvas of payloads | data leaves | HTTP clients / diffs |

A tab type is just a **seed**: *which producer sits at the root, and which consumer is bolted to
the margin by default.* The toolbar, the side pane, the run bar — all of it is **the root
producer's consumer, rendered as app chrome instead of inline.** There is no "code mode" or
"spreadsheet mode" as a distinct application; there's a different block at the root and a
different default consumer in the margin slot.

That collapses an entire category of "we need to build tab type X" into "register a flavour +
pick its default consumer."

---

## 3. Blocks as the root object (the keystone)

Today the hierarchy is special at the top: a tab holds a **document** (a ProseMirror instance),
and the document holds blocks. The document is privileged.

The move: **the root of a tab is just a block.** A markdown tab is a *prose-flavoured* block at
root that happens to allow rich children. A code tab is a *code-flavoured* block at root. The
document stops being a category and becomes "the prose flavour, which is the one container flavour
elaborate enough to host other blocks."

Three things fall out, and they're the payoff:

- **Embedding and extraction become free and lossless.** "Pull this code block into its own tab"
  = *reparent it to root*. "Embed this spreadsheet in my design doc" = *reparent it under the
  prose block*. Same object, no conversion, no export/import. The difference between "a code block
  in my notes" and "a code scratchpad tab" is **only which one is at the root and how much screen
  it gets.**
- **Rendering is responsive, not bespoke.** The same block draws **inline** (compact, in prose),
  **embedded** (medium, a panel beside text), or **full-bleed** (a tab). Same data, three
  viewports. That's responsive design 101 — and it only exists *because* the root is a block too.
- **The chrome unifies.** The Ask panel, a terminal pane, a chart sidebar are all "the root
  block's consumer in the margin slot." One layout slot, many flavours, one set of flip/focus
  contracts.

The honest framing: this is brainstorm-2's "one primitive, six costumes" taken to its conclusion —
**even the root is a costume.**

---

## 4. The ladder of scales

The same producer/consumer/flip pattern, all the way up. This *is* the "across scales" claim:

| Scale | Producer | Consumer / enrichment | Flip is… |
|---|---|---|---|
| Mark | a highlighted word (`==`) | AI target attention | (degenerate — no flip) |
| Inline | a block-ref anchor | the AI thread it seeds | open/close the thread |
| Block | code / data | render · run · critique | Ctrl+Enter / Run |
| Pair | source ⊕ renderer | the fused widget | view source vs picture |
| **Tab** | **root block** | **margin consumer (AI/terminal/chart)** | **Ctrl+Shift+A & friends** |
| Workspace | the tab set | cross-tab references (future) | switch tab |

The pattern holds cleanly from *block* to *tab*. It gets thinner at the very bottom (a mark has no
real flip) and at the very top (a workspace isn't text-on-the-wire) — which is the useful signal
about where the abstraction earns its keep versus where it's just tidy.

---

## 5. Where it strains (so we don't kid ourselves)

1. **ProseMirror owns the world today.** Selection, clipboard, undo, and the document model are
   all PM-global. Making the *root* a non-prose block (a grid, a terminal) means PM becomes **one
   root flavour among several**, hosted by a thinner shell that coordinates heterogeneous roots.
   That's a genuine inversion, not a refactor. Brainstorm-2 §11 ("the substrate is the real work")
   bites hardest exactly here.
2. **"Block" has to span leaf ↔ container.** The prose root is *multi-child*; a spreadsheet root is
   a single rich leaf. The abstraction must comfortably cover both, which is wider than today's
   contentEditable-false atoms.
3. **Layout stays authorial, never derived.** Blocks-as-root is a *logical/structural* claim. How
   much screen each block gets (inline vs panel vs tab) is an *authorial* choice. Keep them
   orthogonal — auto-arranging blocks from their structure is the canvas trap (§11).
4. **Mission discipline still gates it (§8/§10).** A terminal or running-process root flirts with
   "thinking serves the code." Blocks-as-root must still pass *"leaves a knowledge residue on
   filing."* A code scratchpad that cements to a stamped snapshot is **in**; a live-server tab is
   **quarantine**.

---

## 6. The spine, compressed

1. **One primitive:** a block = a producer wired to a consumer, with a flip between its faces.
2. **The flip is sugar** over "two wired nodes, show one at a time" — so the pair need not share a
   box, or even the document.
3. **Three reusable contracts** make a flip work at any scale: keep-alive, focus/state
   preservation (ephemeral, never YAML), producer→consumer wiring.
4. **A tab type is a seed:** which producer is at the root, which consumer is in the margin.
5. **The root is a block too** → embedding/extraction is free, rendering is responsive, chrome
   unifies. The markdown editor is the first block flavour, not the app.
6. **The substrate is the prerequisite** (selection / clipboard / reorder / keep-alive flip).
   Don't invert the root until it's solid; meanwhile the *lens* pays off without the inversion —
   build the contracts as reusable seams and let each new smart thing slot in.

> First brick already laid: `focus-context.js` is contract #3's macro instance (editor↔Ask), built
> so the micro instance (block source↔render) calls the same code. Build the flip-memory once; let
> every scale call it — but never let "same contract" seduce you into "same object."

---

## 7. Getting ahead of ourselves (on purpose)

Take one more step and the lens keeps pulling upward. If ProseMirror is just the *prose flavour's
editor*, then **markdown stops being the app** — it's one flavour's wire format, and the document
was only ever the first projection. From there: if a tab is a viewport onto a block, a tab can be a
viewport onto *another tab's* block — `TAB2 = ER_MODEL(TAB1)`, the spreadsheet model promoted from
cell→cell to **tab→tab**, a workspace of linked projections. (The mechanism that makes that work —
a ref resolving against a live doc when open, an on-disk cache when closed — is the same
render-the-cache substrate the web/mobile frontend needs anyway, so it's not even a detour.) And
one step past *that*, the block stops being "the primitive Sieve is built from" and starts looking
like "a primitive you could build a whole **suite** of applications from."

That last step is where we caught ourselves — and it's worth a wink, not a fence. This is a
brainstorm; running ahead of reality is the whole job, and pretending otherwise would just make the
file boring. Writing it down isn't a commitment to build a platform (frameworks get *extracted* from
working products, never designed up front) — it's a note that the abstraction has *that much
gravity*, and a reminder that the asset is **knowing** it could go there, not **going** there.
Whether we ever spend it is a much later question, gated on real second use-cases rather than
imagined ones.

So: flag planted, not a stop sign. We might be getting ahead of ourselves — which is exactly what
this file is for.
