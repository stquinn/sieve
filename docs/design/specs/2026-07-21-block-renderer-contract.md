# The Block Renderer Contract

**Status:** APPROVED (rev 2) — architect approval 2026-07-21. Reconcile in progress on `feature/renderer-extraction-43`.
**Date:** 2026-07-21 (rev 2 same day — semantic API + BlockService boundary, from the architect's review of rev 1)
**Supersedes:** the renderer contract portions of `docs/design/archive/specs/2026-07-20-block-renderer-extraction.md` (epic #43). The uncommitted working-tree refactor approximates an earlier revision of this contract and will be reconciled to this page after approval.

## Problem

A block's body, in an editor lens, is a data structure wearing DOM: ProseMirror's
`contentDOM` is both PM's display surface **and its input device** — DOM mutations
there are read back as user edits. So the body region admits exactly **one writer**.
Meanwhile every other lens (chat, cards, bare page) wants the renderer to produce the
body itself. The contract must let the renderer own all rendering knowledge and code,
while allowing one lens to take over one region's content — without lens concepts
leaking into the renderer package.

Rev 1 solved region ownership but left two leaks the architect's review caught:

1. **The `actions` callback bag.** Consumers had to know attribute names and wire
   values (`updateAttributes({mode:'render'})`) — the persistence schema wearing an
   API costume — and interaction-tier verbs (`expand`/`expandSpec`/`expandIcon`,
   `enterRenderMode`) had leaked into what should have been an effect port.
2. **Protocol in the editor.** Each `AbstractEditor` holds its own WebSocket and
   speaks the sieve wire protocol. That knowledge is the last thing keeping the PM
   surface "special" for reasons that have nothing to do with PM.

## The contract

```js
class BlockRenderer {              // block/renderers/ — lens-blind, protocol-blind
  constructor(block, blockService?, handleBuild?)   // block: SieveBlock (typed envelope)
  render()          // template: shell + per region [container → consult handler →
                    //   default: container.append(buildX())]. Complete block, one call.
                    //   Stamps its own data-* (data-id etc.) — adapters never write renderer DOM.
  update(block)     // THE inbound truth channel; patch own slots via refs; skips
                    //   regions recorded as externally managed
  destroy()
  get body() …      // pure accessors to recorded region elements

  // Core semantic API — business verbs shared by multiple kinds. Consumers
  // (adapters, policy layer, editors, header chrome) speak these and NEVER
  // see an attribute name or wire value:
  setMode(mode)     // MODE enum below; declared kinds only
  setContent(text)  // OUTBOUND truth report/command (see direction rule below)
  retry()
  expand()          // one behaviour, three triggers (chord / header / menu)

  // Kind-specific semantic verbs live on the subclass, same discipline:
  //   SmartImageRenderer.resize(width) · LogRenderer.setColumns(cols) · …

  // hooks (subclass-only, run exactly once, fabricate-and-return, never place):
  buildHeader() buildTitle() buildBody() buildFooter()

  #pushAttrs(patch)     // PRIVATE: the ONLY place semantic verbs become schema
  #pushContent(text)    //   → blockService.{updateAttributes,setContent}(this.id, …)
}
```

**The typed block envelope.** Raw attr maps are the block's *wire costume*; they cross
no consumer signature. The invariant in-memory form is ONE class (mirroring Go's single
`SieveBlock` — never per-kind block subclasses, which would smear schema knowledge
across a second hierarchy):

```js
class SieveBlock {
  get id()      get kind()
  get mode()    // MODE enum — total: modeless kinds report MODE.DEFAULT
  get status()  // the StatusBadge axis: cross-kind by construction
  #payload      // everything else — opaque; the kind's renderer is its SOLE interpreter
}
```

The typed surface is exactly the *framework-level* state — properties this contract
itself gave cross-kind meaning (`id`, `kind`, `mode`, `status`); kind payload stays
opaque, so "each attr name appears in exactly one class" survives. Serialization is a
**container** concern, not the block's: the fence is transport encoding for living in
markdown (brainstorm 4), `.block` is bare YAML, a chat turn is a YAML sequence item
(brainstorm 5) — three costumes, one envelope. **The service authors the envelope**:
typing the wire is the anti-corruption layer's job (a repository returns domain
objects, never ResultSets), so wire maps exist only inside `BlockService` and
consumers receive `SieveBlock`s. Known raw-map offenders this retires: the
interaction policy's `attrs.mode` reads (`stopActive`, `handleArrowStop` →
`block.mode`) and adapter-side `node.attrs.id`/`effectiveAttrs` indexing.

**Envelope-first flow (the lens is a projection).** `load(uuid)` returns
`SieveBlock[]` — Go's codec did the splitting server-side; JS never parses a
document. The lens *materializes* its display form from envelopes (`blockToNodes`
becomes a projection from the envelope) and keeps an id-keyed **truth-mirror** of
them (today's block-sync cache, typed). A NodeView is created FROM a SieveBlock:
PM's node identifies which envelope (id lookup) and supplies PM mechanics
(contentDOM, getPos) — the renderer is constructed from the envelope, never from
node attrs. Render-backs and v1 appliers update mirror + projection together (one
writer: the seam), and `NodeView.update` re-resolves the refreshed envelope for
`renderer.update(block)`. `SieveBlock.from(node)` exists only as the fallback for
PM-resurrected nodes (undo restoring a deleted block) — possible because node attrs
are a faithful wire costume, never the primary direction.

**Frozen tokens** (house style — shared values are `Object.freeze`d; values stay
strings so DOM attributes and debugging read naturally):

```js
export const REGION = Object.freeze({ HEADER:'header', TITLE:'title', BODY:'body', FOOTER:'footer' })
export const MODE   = Object.freeze({ DEFAULT:'default', EDIT:'edit', RENDER:'render' })
```

`MODE.DEFAULT` means *the kind's natural presentation* — `setMode(MODE.DEFAULT)`
is total for every kind (diagram: render-when-valid; code: edit; modeless kinds:
no-op home). No new wire states: renderers map the enum to today's persisted
strings privately.

**Semantic-API doctrine.** Attributes are persistence/wire vocabulary. They are
private to the renderer: `#pushAttrs`/`#pushContent` are the only outbound mapping
points, and each attr name appears in exactly one class — the renderer that owns
rendering it. Inbound truth arrives as the typed envelope (`update(block)`); callers
never hold or forward raw maps — the seam constructs the envelope at the boundary,
and only the renderer interprets its payload. Capability discovery stays
declaration-side (`interactionPolicy`/behaviour data — the policy layer resolves by
kind, without an instance); execution is renderer-side; calling an undeclared verb
throws `ContractViolation`.

**Abstract-consumer rule.** A consumer holding `BlockRenderer` abstractly speaks the
core API only. Subclass verbs have exactly two legitimate callers: the kind's own
chrome (self-invocation — the resize handle, the column-config UI), and a consumer
that *constructed* the concrete type and so holds it concretely. Type-sniffing
(`instanceof` → special verb) is forbidden — that is the actions bag reborn. The
moment a generic consumer needs a verb from the abstract position, that is the
**promotion signal**: the verb joins the core API with a capability declaration,
exactly as `setMode`/`expand` already did. Core membership is defined by
demonstrated external callers, never speculation.

**Direction rule for `setContent`.** It is the outbound channel only. In the editor
lens the PM adapter's content-sync closure calls `renderer.setContent(text)` instead
of touching a socket or an attr name; the renderer maps text to its own schema
(`source` attr vs node text — kind knowledge). It never paints the displayed body:
in an editor lens that body is PM's, rebuilt from the document; truth returns via
`update(attrs)`.

**The `handleBuild` interceptor** (paste-handler idiom: *handle it or I will*):

```js
handleBuild(renderer, region, container, block) → boolean   // region ∈ REGION
//  absent or true  → base builds the region normally (handler may first
//                    DECORATE the container: attributes, classes, extra DOM)
//  false           → region is EXTERNALLY MANAGED: base skips the hook,
//                    records it, and update() skips it permanently
```

One nullable constructor argument gives every lens three verbs — decorate, own,
default — replacing all previous mechanisms (variant subclasses, flags, enums).

**The service pair** — the sieve protocol's anti-corruption layer, split by one
criterion: *addressed to an existing block* vs *addressed to a document by uuid*.
Both are singletons constructed in the Workspace composition root and handed down
(idiomatic-js §5: never `window.*`); `DocumentService` takes `BlockService` by
constructor injection.

```js
class BlockService {           // wire owner + existing-block verbs. RENDERERS see
  updateAttributes(blockId, patch)   // this and only this — a renderer knows its
  setContent(blockId, text)          // block id, never a uuid (the channel resolves
  retry(blockId)                     // the document server-side; wire shapes for
  detectExtractions(payload) → offers      // block ops already omit uuid).
  extract({blockId, targetKind, operation, entries, index})
}

class DocumentService {        // uuid-addressed lifecycle. EDITORS/Workspace see this.
  constructor(blockService)    // composed over the wire owner
  load(uuid) → SieveBlock[]    // typed envelopes; Go's codec did the splitting
  save(uuid)                   // + the raw-content family: getRawContent/setRawContent
  createBlock(…) deleteBlock(…)      // MEMBERSHIP: add to / remove from the list
  flush(uuid)  export(uuid)
  onBlockUpdated(listener) → unsubscribe   // render-backs are document-scoped
}                                          // streams; renderers never listen
                                           // (inbound = update(block) via the lens)
```

The `block-op` wire envelope (`{type:'block-op', uuid, op}`) is **transport framing,
BlockService-internal** — both services' verbs compile to it; `applyBlockOps` as a
public verb dies (wire shape leaking into the API). The wire's own op set confirms
the criterion: `create-block`/`delete-block` are membership (`DocumentService`),
while every `update-block` caller today (diagram mode flips, smart-link/card edits,
log mode) is an existing-block semantic verb in adapter costume —
`BlockService.updateAttributes` under this contract.

Go kinship: `DocumentService` is the JS twin of Go's **EditorService** (live-document
session concerns), not Go's DocumentService (persistence, which stays behind Go).
Today's `AbstractEditor` verb methods are its API waiting to be extracted; the
Workspace's own `/api/editor/load` fetch becomes `documentService.load`. The
**Workspace is NOT this service**: it is the session domain's twin (it speaks
`/api/tabs`, `/api/note/open` — Go-as-controller) and the composition root that
wires the pair. Document-content verbs on the Workspace would fatten the
deliberately-thin session conveyor into a god object and invert the hand-down
hierarchy (editors calling up for IO — the registration contract permits exactly
one upward percolation, and it's the context menu).

The service owns the protocol entirely — connection lifecycle, channel-per-uuid
routing, takeover guards, framing, ack correlation — and is PM-blind and DOM-blind.

**Boundary datatype rule.** No PM type crosses the service boundary in either
direction. In: ids, attr bags, markdown strings, plain indices, JSON-able entries
(the lens resolves anything PM-derived — indices, entry resolution from a source
node — *before* calling). Out: success/failure as Promises resolving generic result
objects (`{matched}`-style), block truth as typed `SieveBlock` envelopes (the
service authors them from wire payloads — see the envelope section), and
render-backs as op payloads carrying envelopes via registered listeners;
envelope→node materialization is the lens's job. Verbs with a single PM-side caller
are fine (`enterWysiwyg` may only ever have one consumer); verbs whose parameters
or results presuppose a PM object are not. The service must never learn that PM
exists.
It is already a *two-transport* boundary on day one: extraction discovery rides HTTP
(`/api/detect-extractions`) while op execution rides the WS — consumers cannot tell,
which is the boundary working. Capabilities therefore have **two declaration
sources**, composed by the context menu through sanctioned channels only:
frontend-declared interaction capabilities (`interactionPolicy`/behaviour data, read
from the registry) and backend-declared document capabilities (processor-declared
transforms/extractions, discovered via the service).

**Format-blind raw-content family.** The raw serialization ops consolidate into
`load` · `getRawContent` · `setRawContent` · `save` — lens mode names
(`enterMarkdown`/`enterWysiwyg`) and format names never appear in a service
signature: a document's raw form is its **codec's** business. This is
blocks-all-the-way-up insurance: when a block is a document (a Thing), it keeps a
uuid as its address but its raw form may be YAML properties — these verbs survive
that pivot unchanged. Semantics: `getRawContent` is a pure read (the export path's
verb too); `setRawContent` streams the in-flight buffer into the shadow's raw
cache — the first divergent set IS the in-flight signal, so "mode" ceases to be
negotiated protocol state and becomes backend-derived (an uncommitted cache is
present); `save` commits — reparse replaces the tree, in-flight ends, reply is the
generic reparsed-block payload (block lenses consume it; raw lenses ignore it).
While in-flight, both breakglass guarantees are backend-internal consequences:
disk flushes write the cache verbatim (byte fidelity — mid-edit text is not
losslessly parseable), and `SnapshotForJob` reparses the cache for coherent job
context. Today's `updateText`/`doc-update`, `/api/editor/{load,save,export}`, and
the WS-vs-HTTP, note-vs-prompt splits all become internal routing of this one
family; wire unchanged in v1, and Go's explicit `Mode` string becomes derivable
(retire under #49, not this reconcile). Forward echo: with export
as a derived serialization (processor-owned `Serialize`) and AI retrieval through
the internal MCP, every consumer reaches documents through block-speaking APIs —
clearing the path for `store.Store` implementations that persist typed block
records (DB/S3) rather than rendered markdown; `ShadowDocument` already models
this (tree authoritative, markdown derived on demand). FileStore's
files-on-disk-you-can-cat property becomes a per-deployment choice, not an
architectural assumption.

Document ops split three ways: their **meaning** is backend-defined (processor-
declared, ShadowDoc-executed — the service's verb set mirrors Go's op vocabulary,
never lens speculation); their **triggering and context** are lens-owned (only the
lens can resolve the PM-derived `index` or stamp caller context onto entries);
their **result presentation** is lens-owned (tracked transactions in the editor
lens). The rejected alternative — op semantics on the lens over a dumb-pipe
`send(msg)` service — would leak wire framing back into lens code and fail the
transport-swap test. Invariant either way: wire comms are authored and parsed in
exactly one class.
Endgame blindness map: renderers are lens- and protocol-blind; the service is
protocol-owning but PM-blind; editors/surfaces are transport-blind (swap WS for MQTT
and nothing above the service notices). The PM surface's only remaining specialness
is PM itself. `AbstractEditor`'s `#socket`/`socketFactory` move into the service
(the prompt-doc-has-no-WS case becomes service-internal routing).

**The PM lens** (all PM knowledge stays in the adapter):

```js
const handleBuild = (r, region, container) =>
  region === REGION.BODY ? (bodyContainer = container, false) : true
renderer = new AiBlockRenderer(blockFor(node), blockService, handleBuild)
return { dom: renderer.render(), contentDOM: bodyContainer, … }
// content sync: debounced closure calls renderer.setContent(text) — never the socket
// blockFor: id lookup in the lens's envelope truth-mirror — the NodeView is created
// FROM a SieveBlock; node.attrs stays PM-internal (SieveBlock.from(node) is only
// the resurrect fallback)
```

Body content chain of custody — **the renderer's code authors, always**:

```
Go truth → typed SieveBlock → FRESH renderer instance (scratch) → buildBody()  ← our code
                → parseSlice (meaning extracted, scratch discarded)
                → tracked transaction → document children
                → PM builds ITS OWN DOM into the live container       ← sole writer
```

Two bodies exist in an editor lens: the **authored** body (ours, transient, data
space) and the **displayed** body (PM's, live, rebuilt from the document). Only the
naming of this distinction prevents every confusion this page replaces.

**State doctrine.** Stateful where there is DOM to guard; stateless where there is
none. A renderer is irreducibly stateful (slot refs + last-rendered truth for
diffing), so its block completes its state at construction; `update(block)` is the
one sanctioned external-truth channel. Live instance: one per NodeView/host mount, lives
as long as its DOM, holds the service. Authoring instance: one per pass — it guards
nothing, fires no effects, and takes **no service** (omitted → inert null service);
live-vs-scratch now reads directly off the constructor call. The `BlockService` is a
singleton guarding connection state, never DOM. DOM-less helpers (sanctioned
markdown engine, StatusBadge, esc) are stateless services.

**Verb law.** Semantic verbs command · `#push*` maps to schema · the service
transports · `build*` fabricate and return · `render` orchestrates and places ·
`update` patches · `get` is side-effect-free · `destroy` releases. Hook guarantee:
`render()` invokes each build hook exactly once, canonical order; `update()` never
invokes hooks.

## Rejected along the way (each by the architect, with cause)

- Framework slot-assembly via provider declarations — inversion; duck-era fossil.
- `titleSource`/`bodySource` statics — data-for-the-framework; knowledge belongs in code.
- `claimBody()` — caller-perspective name; PM leak as a mid-life capability grant.
- `bodySlot:'projected'` flag — PM leak as configuration.
- Region objects — the enum in class costume; parts secretly knowing they're stubs.
  (A frozen *token* object — `REGION`, per house style — is not this: tokens carry no
  behaviour and don't know they're stubs.)
- `mount([TITLE, FOOTER])` enum — selection can't express *modified* regions; caller-
  dependent shape. (Named-variant classes remain the door if a real consumer appears.)
- Lazy two-step (`render()` + `renderBody()`) — nobody could say who calls step two.
- `Projected<Kind>` subclasses — worked, but N classes where one interceptor suffices.
- Reusable authoring instance — needs attrs passed back in; breaks hooks-run-once.
- Stateless renderer — illusory; evicts unavoidable state (refs, last-rendered) to callers.
- The `actions` callback bag — schema-coupled every consumer (`updateAttributes({mode:'render'})`),
  and interaction-tier verbs leaked in (`expand`/`expandSpec`/`expandIcon` bypassing the
  already-generified policy path; `enterRenderMode` as an injected closure).
- Public `updateAttributes` on the renderer — the persistence schema as API; replaced
  by semantic verbs over a private `#pushAttrs`.
- Renderer static for authoring (`Renderer.authorBody(attrs)`) — a second, partial-render
  entry point; authoring lives in the seam via scratch instances.
- Editor-held WebSocket + `socketFactory` test seam — protocol knowledge was the
  editor's accidental speciality; both move into `BlockService`.
- Raw attr maps crossing consumer signatures (`update(attrs)`, policy reading
  `node.attrs.mode`, adapter `effectiveAttrs` indexing) — the wire costume as the
  object model; replaced by the typed `SieveBlock` envelope.
- Per-kind block subclasses (`CodeBlock.lang()`) — schema knowledge smeared into a
  second hierarchy; Go's single-SieveBlock lesson (B-C) applies to JS too.
- `applyBlockOps` as a public verb — the `block-op` wire envelope leaking into the
  API; transport framing is `BlockService`-internal, semantics live on the two
  services' typed verbs.

## Consequences on approval

1. Reconcile the working tree: replace `Projected*` subclasses with the interceptor;
   thread `handleBuild` through the base and adapters; seam authors via scratch
   instances (its `bodyMarkdown`/conversion path adjusts accordingly); introduce the
   `SieveBlock` envelope with envelope-first flow — the lens's block-sync cache
   becomes the typed truth-mirror, NodeViews resolve envelopes by id (retiring
   `effectiveAttrs` raw merging; `SieveBlock.from(node)` as resurrect fallback
   only), the interaction policy's `attrs.mode` reads become `block.mode`, and
   renderers stamp their own `data-*` (adapters stop writing renderer DOM).
2. Replace the `actions` bag with the semantic API + `BlockService`: v1 service
   routes `updateAttributes`/`setContent`/`retry` to appliers the surfaces register
   (today's PM-transaction behaviour behind tomorrow's boundary — no Go changes);
   purge the expand trio (policy/behaviour + `renderer.expand()`, chord/header/menu
   all triggering it); `enterRenderMode` becomes `setMode(MODE.RENDER)` with caret
   preservation as PM-surface business on apply.
3. Seam retains: attrs→document conversion + transaction (PM mechanics), legacy
   provider path for unmigrated kinds (smart-link, prose).
4. Follow-up Forgejo issues (raised at close-out): **#49 (A)** full protocol extraction — WS ownership,
   takeover guards, ack correlation, and the document-op machinery (`extract`,
   `flush`/`#awaitReply`, `applyBlockOps`, the raw-content family — today's
   `enterMarkdown`/`enterWysiwyg`/`updateText`/load/save/export, renamed per the
   format-blind rule — the paste endpoints in `wysiwyg-surface.js`, and the
   `detect-extractions` fetch in `sieve-block-extension.js`) move from
   `AbstractEditor` into `BlockService` (natural companion to X-D, where
   `editor/surfaces/` becomes THE PM package);
   **(B)** backend-written block ops — attr/content patches as ShadowDoc ops with
   acks, closing the local-PM-transaction exception to backend-is-source-of-truth.
5. Gates unchanged: full vitest, tsc, purity sweeps (no dead-era vocabulary),
   hostile-payload tests, live checks incl. log filter-input focus survival.

## For the architect to confirm

- [x] Region identifiers: frozen token object `REGION` (string values) — **decided, rev 2**.
- [x] Constructor order `(block, blockService?, handleBuild?)` — state, collaborator,
      region policy; scratch instances are `(block)` only.
- [x] The typed envelope: ONE `SieveBlock` class, framework-level getters only
      (`id`/`kind`/`mode`/`status`), payload opaque to all but the kind's renderer —
      vs per-kind block subclasses (rejected above, confirm the rejection).
- [x] `MODE.DEFAULT` = "the kind's natural presentation" (total `setMode`, zero new
      wire states) — vs a third persisted state.
- [x] Core API membership: `setMode` · `setContent` · `retry` · `expand`; everything
      else subclass-owned (`resize`, `setColumns`, …).
- [x] Transport sequencing: v1 surface-registered appliers now; #49 (A) protocol
      extraction as the follow-up issue, aligned with X-D (the (B) idea closed as
      mis-scoped — see Consequences pt 4).
- [x] Scratch-instance authoring lives in the seam (adapter side), not a renderer static.
