# Brainstorming 7: The Island and the Workspace

Companion to [brainstorm-smart-code-blocks.md](./brainstorm-smart-code-blocks.md),
[brainstorm-smart-code-blocks-2.md](./brainstorm-smart-code-blocks-2.md),
[brainstorm-blocks-all-the-way-up.md](./brainstorm-blocks-all-the-way-up.md),
[brainstorm-email-workbench-and-block-store.md](./brainstorm-email-workbench-and-block-store.md),
[brainstorm-ai-protocol-roles-chats-and-document-kinds.md](./brainstorm-ai-protocol-roles-chats-and-document-kinds.md) and
[brainstorm-source-editor-and-the-host.md](./brainstorm-source-editor-and-the-host.md).

Brainstorm 2 found the primitive. Brainstorm 3 pushed it up to the tab. Brainstorm 4 made
blocks stored things and editors lenses. Brainstorm 5 found the axis that decides storage,
editor technology and AI memory together. Brainstorm 6 found the host, and ended on an
edge it did not walk off: *"if a host is a thing, what is the workspace a host of?"*

This one walks off it — from an unexpected direction. It began as a survey of alternative
UI toolkits (a malaise, honestly held, with modern web development) and ended by pricing an
asset the series has been deliberately accumulating for months: the boundary between the
lens and the workspace. By the end, the editor is an **island**, the workspace is
**replaceable**, and both facts turn out to be the same fact.

*2026-08-23. A thinking document, not a spec.*

---

## 0. The one-sentence model

> The workspace is a **host of hosts**, joined to every lens by wire-shaped interfaces —
> and once the lens is *only* a lens, the boundary cuts both ways: the editor becomes
> replaceable by other lenses (blocks all the way up), and the workspace becomes
> replaceable by other shells (toolkits, form factors, deployments). **The layering is
> the reuse.**

Lasagne, not spaghetti. Spaghetti binds both directions at once — a lens that leaks logic
pins the workspace exactly as much as a workspace that reaches into the lens pins the
editor. Layers are what make each layer reusable, and the reuse accrues to *both sides of
every boundary simultaneously*.

---

## 1. Appraisal, not discovery

Nothing in this chapter is a new direction. The containment of ProseMirror has been a
conscious, prosecuted program with receipts in the tree:

- `tiptap-vendor.js` is annotated as **the ONLY PM read point**; `editor/surfaces/` is
  designated *the* PM package.
- #49 pulled renderers out of PM's reach (`block/renderers/`, PM-free, the 2026-07-21
  renderer/NodeView contract brainstorm 6 leans on).
- #71 exists to extract PM from the interaction policy itself (`TextLens` + nullable
  `BlockHost`) — the *normative behaviour* becoming lens-agnostic.
- #95 makes editors views over a transport they do not own (the Workspace-owned follower
  model: BlockService is the transport, the index is never a block attr).
- The single-owner-surfaces direction gives every surface one owner and moves the runtime
  shell to wire-driven rendering.

"Remove PM to the editor" has been a standing refrain in the issues for months. What had
not happened yet was a **pricing event**: something external pressing against the boundary
hard enough to reveal what it is worth. The toolkit survey was that event. The boundary
held against every scenario thrown at it — a Flutter shell, a browserised server, form
factors, a second app — and this chapter is the appraisal: not "we found a boundary" but
**"the boundary we have been building is now complete enough to enumerate what it
yields."**

(Method note, from brainstorm 3 §7: the asset was *knowing* it could go there, not *going*
there. The brainstorms ran ahead; the issues ground the direction into code; this chapter
is the point where the two met.)

---

## 2. The workspace is a host of hosts — with one new fact

Brainstorm 6 catalogued the in-DOM hosts (lightbox, popup, ask panel, tab) and found the
containment contract tiny: *is there an outer caret? is there an outer history?* All of
those hosts share one thing so completely it was invisible: **a runtime.** They can call
each other, dispatch DOM events, share `focus-context`, read each other's globals.

The workspace boundary is where that assumption must die. The thing that hosts the tab
strip, the sidebar, the chrome — the host of hosts — may not share a process with the
lenses it hosts, let alone a language. The moment that is admitted, the interfaces at the
boundary stop being function calls and become **wire-shaped**: typed messages, declared
vocabularies, no reach-through. Which is not a new discipline — it is the discipline the
protocol registry already enforces at the server boundary, applied one boundary up.

> An in-DOM host tells a lens two containment facts. The workspace tells a lens the same
> two facts — *plus a channel*. That is the entire difference.

---

## 3. The layering invariant

The load-bearing sentence, stated as law:

> **Island → workspace → backend.** The lens talks to the workspace through defined
> interfaces. The workspace talks to the backend. The lens never knows a backend exists.

This is not a deployment choice — it is invariant across every deployment, and #96 (né #95) is its
keystone: the follower model is what *creates* the workspace interface the island stands
on. In today's app the workspace is JS (`WorkspaceService` + `BlockService` owning the
wires). In any future shell the workspace is that shell's code, and the island's
`BlockService` keeps its exact API while its channel implementation becomes whatever
transport the boundary offers. Same architecture, N substrates.

What the invariant buys — the bidirectional removability:

- **The editor is removable.** A chat lens, a grid root, a code workbench — each is "a
  different thing behind the workspace's lens interface." Brainstorm 3 §5.1 priced
  blocks-all-the-way-up at a *"genuine inversion, not a refactor"* — making PM one root
  flavour among several — and had no mechanism for it. This is the mechanism: **you do
  not invert PM's world; you demote it.** Draw the interface, put PM behind it as the
  first lens, and the "thinner shell coordinating heterogeneous roots" is simply the
  workspace that was always supposed to exist. The inversion happens *at the boundary*,
  not inside the editor — which is why it is achievable at all.
- **The workspace is removable.** Flutter, a browser tab, whatever hosts next — the
  island cannot tell, because everything it touches is an interface. Brainstorm 5's
  *"Sieve isn't a PM app; it's a block system where one lens happens to use PM"* was an
  insight; the boundary is where that sentence stops being commentary and becomes
  **enforceable structure**.

The corollary for sequencing is blunt: **#96 (né #95) stops being an encapsulation nicety and
becomes the critical path of everything in this chapter.** Every hour spent completing the
follower model is an hour of any future shell migration done early, without a line of
that shell existing.

---

## 4. The island

### ProseMirror is DOM-bound, by its owners' own verdict

The toolkit survey kept arriving at one wall: PM's extension model (`parseDOM` /
`renderHTML`) is not *rendered via* the DOM — it is *made of* the DOM. Asked for a Flutter
port, the TipTap maintainers said no, explained that this is structural, and pointed at
webviews as the practical path (ueberdosis/tiptap discussion #4332). The community's
furthest attempt (`tiptap_flutter`) runs TipTap headless in an *invisible* webview as a
computation engine with the UI rebuilt natively — i.e. **even the project trying hardest
to escape the webview ships one.**

> Every viable road keeps the webview. The only design freedom is what you build around
> it.

So the editor's final form under any alternative shell is a **web island**: the small PM
editor, its extensions, its renderers and its template, served by Go at a URL, hosted in a
webview widget wherever the workspace lives. Not a compromise — the load-bearing component
every architecture in this space converges on, held by the one product (per brainstorm 5
§8's rule) that genuinely *works* text.

### Islands are plural

An island is addressed by URL and served by Go, so an island **variant** is a template +
CSS decision, not an app decision. A phone island with touch-sized affordances and a
trimmed toolbar; a desktop island as today; an embed-card island someday. Same wire
contract underneath, different clothing per form factor. This is brainstorm 6 §3's
size-vs-containment split paying out at the app scale: size stayed CSS; only containment
needed a contract.

### What the island keeps — the whole point

The dread that shadowed the toolkit survey was losing the renderer investment to a
rewrite. The island dissolves it, and the accounting is worth writing down:

| | Fate |
|---|---|
| `block/renderers/` — base, style registry, per-kind renderers, gutters, highlighting | **Survives wholesale** — it *is* the island's content |
| NodeViews, extensions, interaction policy + contract doc, editor classes | **Survives wholesale** |
| Protocol services (BlockService, tenants, correlation) | **Survives with one substitution** — the channel implementation under `BlockChannel` |
| The JS workspace (shell, tabs, HTMX views) | **Replaced** — and was already scheduled for wire-driven rebuild by single-owner-surfaces; only the answer to "rendered by whom" changes |

The line between "irreplaceable" and "scheduled for renovation" is exactly where the
island boundary falls. No other migration topology surveyed has that property. And the
direct-WS `BlockService` does not die either — it remains the island's **permanent dev
harness**: because editors are transport-blind, the island runs standalone in a plain
browser against the Go server, no shell in the loop, forever.

---

## 5. Two channels at the boundary

The system already invented this split once: the **document wire** versus the **workspace
wire** — content versus infrastructure, drawn at the server boundary. The island boundary
reproduces the same taxonomy:

**Channel 1 — doc edits.** Document-wire frames, carried *verbatim* through a dumb frame
pipe (island ↔ workspace ↔ Go). High-frequency, stateful, ack-correlated, already
registry-governed. Nothing to design; it is the existing protocol with one more hop. The
workspace owns the actual sockets — the single-owner rule (one listener per uuid) survives
by *relocating* to the shell, not by being re-derived. Ack routing to the requesting
island is the workspace's bookkeeping, in exactly one place.

**Channel 2 — the host protocol.** Everything shell↔island that is not document content,
and the vocabulary is short and stable: focus handoff (both directions), forwarded shell
chords, **SelectionContext advertisement**, context-menu requests (island sends position +
context; the shell renders a *native* menu), open-URL, scroll/reveal, theme and settings
push, lifecycle (flush, save-on-close, doc switch).

Two entries deserve their own paragraphs:

### The island advertises what it has

The shell never introspects the island's DOM. The island **publishes** a typed summary of
its observable state — selection, focus block, caret context, which chords it claims —
push-on-change over channel 2. Every shell affordance that acts *on* a selection (ask,
explain, extract, menu) reads the advertisement alone. This is the Ask/Explain seam's
discipline (surfaces fire declared events; the handler is the sole seam) promoted to the
boundary: **the island's observable state is a published contract, not an inspectable
implementation.** The encapsulation earning its crust.

### Key precedence — brainstorm 6's hard field, one boundary up

Brainstorm 6 §9.4 named key precedence "the hard field," and it crosses a process boundary
here. The ownership rule falls out of the contract's existing structure:

- **Chords that operate on the document or selection** (Tab, the Enter family, Mod+Enter)
  are the interaction contract's territory — handled inside the island, never crossing
  the boundary at all.
- **Chords that operate on the app** (ask panel, tab switch, palette) belong to the shell
  — but a focused webview swallows keys, so the island's policy gains a third disposition
  beside handle-locally and native-default: **forward-to-host**, emitting the chord up
  channel 2 as a typed event. One keymap, one arbiter, one normative doc; the
  editor-interaction-contract grows a host-chords table, and #71's `TextLens` extraction
  is exactly the preparation.

The wrong answer — the shell intercepting keys platform-side before the webview — splits
key knowledge across two codebases and is fragile per-OS. The policy stays the single
arbiter; its jurisdiction extends.

### The registry governs channel 2

The host protocol gets the same treatment as the wires: a third channel in
`sieve/protocol` — even though Go never speaks it — because the registry was never really
"the server's vocabulary"; it is **the contracts book**, with a generator that emits to
every client (JS today, others as they exist) and a currency test that catches drift. The
alternative — the host protocol as ad-hoc postMessage strings — is the `window.*` event
soup reborn at a process boundary, where it is strictly harder to debug.

---

## 6. The rails already built

The reason the island costs so little is that every hard rule of the last four months
turns out to be one of its load-bearing walls. Verified against the tree, not asserted:

| Rule | Where it lives | What it gives the island |
|---|---|---|
| Backend is the document source of truth | tracked render-backs, place-by-id | mutations arrive over the wire regardless of who caught the gesture |
| One path for DnD / clipboard | `clipboard/` (Go-native, not Wails), `nativedrop/` | the host catches the gesture, Go does the I/O, the island receives a render-back — swap the host, nothing else moves |
| Transport-blind editors | #49: no fetch/WS outside the protocol services | the channel under `BlockService` is swappable; nothing above notices |
| Single wire owner | channel-per-uuid, claim-on-write guards | relocates intact to the workspace |
| Authenticated wire | #19 allow-list, #83 upgrade tokens | any client, island or shell, meets the same front door; in a sidecar shell the token rides the parent-child pipe and web content never holds it |
| Wire contract registry | `sieve/protocol` + generated artifacts + currency test | the island boundary inherits a governance mechanism instead of inventing one |

None of these were built for the island. That they compose into one is the strongest
evidence the underlying model is right — the same convergence test brainstorm 3 §1
applied to `focus-context`.

---

## 7. The pricing event, recorded honestly

For the record, since it reframed the product's self-description:

**Sieve is a local-first server.** The identity is a stateless API + clients; the desktop
build is packaging. "Local" is the essence — the AI is the user's own CLI, subscription
and ecosystem, met on their machine; a hosted multi-tenant service (users, API keys,
billed engines) is explicitly not the goal. **Desktop is not a mistake** and is not being
second-guessed: CLI launch, native feel, DnD, clipboard, future multi-window are product
value. What the survey indicted was the *wrapper* — carrying a private, worst-edition
browser as the app's platform, with its own quirk ledger (`ISO_Left_Tab`, transform blur,
contentEditable costs, menu crashes, no WS over the custom scheme). The island demotes
the browser from *platform* to *one widget's implementation detail*, which is the
demotion that matters.

The survey itself, compressed:

| Option | Verdict |
|---|---|
| flutter_quill (native Delta editor) | credible for simple rich text; a generation behind PM structurally; the maturity tail (paste, IME, interaction) is where its issue tracker lives |
| Flutter Web (CanvasKit) | the browser as GPU host for Flutter's renderer — coherent, but stacks young canvas-text on top of any editor bet; wrong for worked text |
| tiptap_flutter (invisible-engine) | fast-moving, mobile-only by its own docs; keyboard support near-nil today; the keystroke loop through a bridge is the delicate part done the hard way; watchlist for a mobile rung |
| Obsidian (prior art) | shipping proof of the visible-island topology — native-ish shell, editor in a webview, crown jewel preserved |
| AppFlowy (prior art) | the cautionary mirror — years building a native editor from scratch; the project that runs the experiment so this one doesn't have to |

And the sidecar shape, if a shell migration ever happens: the shell spawns the headless Go
binary as a child, reads port + token off the child's stdout pipe (a cleaner credential
delivery than any page injection — no other process can observe it), owns the sockets, and
hosts the island. The Go side loses almost nothing; extraction was always priced at about
a day, and the AI containment never knew the wrapper existed.

---

## 8. Corollaries, not causes

The boundary is valuable **irrespective of any shell decision** — that is the appraisal's
headline. What follows are options it opens, none of which it obliges:

- **The chat lens is the first candidate for a native surface** — because brainstorm 5
  already removed PM from it on purpose (composer form + rendered turns, §8's rule). A
  chat app in any toolkit faces *none* of the editor risk; it needs the wire, markdown
  rendering, and embed cards. It is simultaneously app #2 in embryo (brainstorm 3 §7's
  gate — a *real* second use-case, not an imagined one), the container-kinds proof, and
  the cheapest probe of any new shell.
- **Many apps, one backend.** Brainstorm 3 §7's "suite of applications" flag, revisited:
  the Go binary as a personal block engine; apps as surfaces over it; the flip primitive
  crossing apps (lift an exchange from a chat, file it as a note — the ore and the
  metal). Held as an architectural *constraint* (never put app logic where engine logic
  belongs), not a roadmap. The email workbench remains the pressure valve that will tell
  us when the engine boundary is real.
- **Form-factor islands** — §4's plural islands, spent whenever a second form factor
  becomes real.
- **The probes, if and when wanted:** a chat lens in a candidate shell (proves shell +
  wire + renderers); an island embed spike (proves handshake, focus, key routing — a
  week); the Linux webview engine question (WebKitGTK-again vs bundling CEF — a research
  task, and the one hard fact that should precede any shell commitment, since Linux is
  the daily platform).

What this chapter deliberately does **not** decide: any shell migration. The right output
of the survey was never "do Flutter" — it was "finish the boundary, and every door it
opens stays open, including the ones nobody has named yet."

---

## 9. Where it strains

1. **Do not build the host protocol up front.** Brainstorm 6 §9.1's discipline applies
   unchanged: extract the contract from *two real hosts* — today's JS workspace and the
   first alternative shell (or even the island-in-a-plain-browser harness) — and stop.
   Channel 2's vocabulary above is a prediction, not a spec.
2. **The Linux engine choice is real.** A WebKitGTK-backed island re-imports the quirk
   ledger, scoped to the editor; CEF buys Blink quality at ~100MB and an embedding
   maintenance load. Neither is disqualifying; both are facts to buy with a spike, not
   opinions.
3. **Native surfaces cannot call the JS renderers.** A shell-side chat card is a Dart (or
   whatever) renderer or a webview-hosted one — the shallow end of rendering, but real
   work, and the place where the SDUI renderer-descriptor endgame (server-published
   descriptors + interactionPolicy) eventually earns its keep.
4. **The platform trap.** "One backend, many apps" is how four-month-old products with
   one great idea become ecosystems with zero great apps. The scratchpad-first identity
   is not finished being built. The constraint stands guard; the roadmap does not move.
5. **Ack routing across the hop** is bookkeeping the workspace inherits (acks to the
   requesting island). Small, but the class of bug — replies swallowed by the wrong
   claimant — has bitten before (the co-claimant workspace-socket case). Test it like it
   has.

---

## 10. The spine, compressed

1. **The workspace is a host of hosts**, and the workspace boundary is the first host
   boundary that cannot assume a shared runtime — so its interfaces are wire-shaped.
2. **Island → workspace → backend**, invariant across deployments. The lens is only the
   lens. #96 (né #95) is the keystone that creates the workspace interface.
3. **The boundary cuts both ways**: editor replaceable (blocks all the way up, by
   demotion rather than inversion) and workspace replaceable (toolkits, form factors).
   Lasagne is the mechanism of reuse.
4. **The editor's final form is a web island** — PM is DOM-bound by its owners' verdict;
   every road keeps the webview; the island keeps the renderers, the contract, and the
   services wholesale, and runs standalone in a browser as its own dev harness.
5. **Two channels at the boundary**, mirroring the document/workspace wire split: a dumb
   frame pipe for doc edits, and a registry-governed host protocol for infrastructure —
   with the island *advertising* its state (SelectionContext) and the interaction policy
   as the single key arbiter, its jurisdiction extended by a forward-to-host disposition.
6. **The rails were already built** — backend-authoritative mutations, one-path
   DnD/clipboard in Go, transport-blind editors, single wire owner, the authenticated
   wire. None built for this; all load-bearing walls of it.
7. **Shell decisions remain corollaries.** The chat lens is the cheap probe; the Linux
   engine question is the hard fact; nothing is committed.

---

## 11. Where this leaves the series

Brainstorm 6 ended by observing that a lens works on an address, and asking what the
workspace is a host of. The answer turned out to require leaving the DOM: the workspace
hosts *islands* — lenses behind wire-shaped interfaces — and the moment that is true, the
workspace itself becomes just another replaceable layer. The series' recurring shape held
one more time: the answer was smaller than expected. No new engine, no new model — one
boundary, already mostly built, finally named and priced.

What it closes: the encapsulation story. The lens is only the lens; there are clear lines
between editor and workspace; and the editor is now removable *in both directions* —
which was the vision all along, stated in the issues as "remove PM to the editor" long
before this chapter could say what removing it would buy.

What it leaves open, in front of the series: the second real host (whichever it is), which
will correct channel 2's vocabulary; the chat lens, waiting at the intersection of three
threads; and brainstorm 6's other edge, still standing — a lens works on an address. An
island that receives *only* a coordinate and a channel is that edge made deployable:
"open this" no longer needs to know what *this* is, where it lives, **or what is hosting
the conversation about it.**
