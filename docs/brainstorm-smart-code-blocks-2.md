# Brainstorming 2: The Design Spine — Smart Blocks as a Reference Graph

Companion to [brainstorm-smart-code-blocks.md](./brainstorm-smart-code-blocks.md).

Where the first document is "blue sky" ideation (pipelines, HTTP clients, AI critics, server mocks), this one is the **synthesis** that came out of working those ideas back into a single, coherent model. The headline: the six features in brainstorm 1 are not six systems. They are **one primitive wearing six costumes**.

This is still a thinking document, not a plan. It deliberately ignores most implementation difficulty in favour of getting the *concepts* right. Sequencing, effort, and the genuinely hard UI plumbing are noted but not solved here.

---

## 0. The one-sentence model

> A Sieve document is a graph of **consumer-producer nodes** that pass **text along references**, distinguished only by **flavour**, scheduled by the **blocks-list reconciler**, gated by per-flavour **cascade tiers**, **cached to markdown** so it reads statically, and **cemented** into durable prose/data when filed.

Every idea in brainstorm 1 — the reactive pipeline, the HTTP client, the self-updating AI critique, the dev/prod fan-out, the diagram block — is a *flavour* or a *wiring* of that one model. The rest of this document unpacks the sentence.

---

## 1. The unifying primitive: consumer-producer nodes

There is no architectural category called "renderer," "code block," "AI block," or "HTTP block." There is **one node shape**, and the only thing that varies is its **flavour**.

- Every block has **input ports** (references to upstream blocks) and an **output** (its value).
- Every block is therefore **both a consumer and a producer** at once.
- The only *pure producers* are **leaves**: a raw payload block, an `env` block, a hand-typed snippet with no references.
- The only *pure consumers* are **terminals**: a render nobody reads from.
- Everything in the middle is a consumer-producer, and the document is the mesh of them.

"Renderer" was always too small a word. The real concept is **consumer**, and *render / execute / critique / transform / diff / mock* are just flavours of consumer. A renderer that draws a pie chart and an HTTP client that POSTs to prod are the same shape — the graph does not care what they do with their inputs.

### The diagram block was the tell

The existing Diagram block has two display modes (source ⇄ picture) and "felt strange" because it shares so much with a code block. Under this model the strangeness has a cause: **there was only ever a code block.** The diagram is a *mermaid source block* (a leaf producer) plus a *renderer* (flavour = mermaid) holding a reference to it. The dual-mode toggle was two nodes pretending to be one.

This generalises to every rich block:

| "Rich block" | Really is |
|---|---|
| Diagram | code block + mermaid renderer |
| SVG canvas | code block + svg renderer |
| Table | data block + table renderer |
| Chart | data block + chart renderer |
| Go-playground output | code block + stdout renderer |

You don't build N rich block types. You build **code/data blocks + a registry of renderer flavours**. The diagram was just the first place the pattern got strong enough to feel weird. (Keep the convenient fused *experience* as **sugar** — one affordance that creates the source+renderer pair and presents them as a single widget — but the *type* underneath is the general primitive.)

---

## 2. Reference + cache: the spreadsheet model

The hard fork: is the plumbing **pass-by-value** (on Run, copy block 1's payload into block 2; afterwards they are strangers) or **pass-by-reference** (block 2 *points at* block 1's output)?

- **Value** has a real virtue for a *document*: a snapshot is a **record** — "the analysis as it was when I ran it," self-contained, decoupled in time.
- **Reference** is what makes **one source → N consumers** (fan-out) natural, and what makes liveness/dirty-propagation possible. But it loses the snapshot and introduces spooky-action-at-a-distance.

**You don't choose. It's a spreadsheet.** A cell `B1 = A1` stores *both* the formula (the reference — where the value comes from) **and** the last computed value (what's displayed). Open the file and you see numbers immediately; no recalc.

- **Reference is the relationship; value is the cache.**
- Store the edge (`source: <uuid>`) so the live editor can re-resolve and propagate dirty — **and** store the last-resolved value as the block's output.
- That cached value **is** the "persist if interesting" output.
- The **web/offline frontend renders the cache** — no live resolution, no execution, no dangling pointers at read time.
- **Dirty detection falls out**: compare a consumer's cached value against its source's *current* output. Differ → stale → glow.
- **"It's all markdown" stays intact**: the serialised doc holds real content (the cache) plus a ref attribute as metadata.

So *what does a reference carry?* **A live pointer while editing; a cached value once serialised.** Both.

### Which half is the knowledge varies by flavour

- **Diagram**: the *source* is the durable knowledge (text, diffable, markdown-native); the rendered SVG is cheap-recompute-on-open, basically ephemeral.
- **HTTP / AI**: the *consumer's output* is the knowledge (expensive, non-reproducible, must cache); the request/prompt is the reproducible source.

So "which half do you freeze" flips by flavour. This drives the per-flavour persistence decision.

---

## 3. The reconciler: dumb blocks, smart orchestrator

Blocks are **not** active listeners or subscribers. The reactive layer is the thing that already sees every block update flow in and out — the **blocks-list / shadow-doc space**. Don't build a second nervous system out of per-block observers (they leak and dangle on every edit).

- **Blocks are dumb.** A block is `render(inputs) → output`, plus it *declares* its references (its edges). It knows nothing about who consumes it.
- **The reconciler is the only reactive thing.** It owns the edge graph, computes the dirty set in topological order, applies the cascade policy, hands each block its resolved inputs, and owns **cycle detection** and **referential integrity** (dangling refs when a source is deleted/reordered — a dangling consumer can still render its last cached value: "orphaned but readable").

This is the build-system model (make/bazel): targets are dumb, the engine owns the graph. It is the right fit precisely because Sieve blocks are constantly created, deleted, and reordered. The "back-edges" needed for dirty propagation live in the reconciler's graph, **not** inside the blocks.

### Topology note

The existing "ref chains" already form a **DAG, not a linked list** — one source feeds a critique *and* a table *and* a diagram (fan-out); a table feeds a diagram (fan-in). The instinct to "turn ref chains into linked lists" is really **make the edges observable** (decentralise the chain ownership away from the AI block; let every block participate). Keep it a DAG — a literal linked list cannot express the fan-out the whole vision depends on. The canonical fan-in case: an HTTP client = `f(payload-ref, env-ref)` (see §6).

---

## 4. Staleness propagation and cascade tiers

The deep question (raised in brainstorm 1): *what is a significant enough change to warrant the expense of re-evaluating an entire block?*

**Answer: propagate *staleness*, not *execution*.** An upstream change marks downstream blocks **dirty** (the glowing border) but does not *run* them. This solves cost *and* side-effect safety with one model (Excel-vs-build-system). Dirty-marking also gives provenance/reproducibility for free.

Whether to *auto-run* is a property of the **receiving block**, because that's where the cost/side-effect lives. Three tiers:

1. **Default** — dirty propagates, nothing auto-runs. Safe, cheap, legible.
2. **Per-block "keep live"** — *this* block auto-refreshes when upstream goes dirty. The self-fulfilling "review this doc" block. A per-node opt-in, not a global mode.
3. **Session "enable cascade"** — master switch that lets cheap/pure blocks auto-run while you actively work.

The **prod HTTP client is the canonical "mark dirty, never auto-run, human pulls the trigger" node.** If the architecture makes that gating awkward, the architecture is wrong.

### Visual lineage is now load-bearing, not decoration

References cause spooky-action-at-a-distance: edit one block, a render five screens away silently changes. The existing **gutter bracket-chains** (and the backlog item to use the gutter for visual linking) are what make references legible enough to be safe. With transitive dirty propagation, distinguish the **edited node + immediate dirty neighbours** (strong glow) from **deeper transitive staleness** (dim) — or the gutter becomes a Christmas tree.

---

## 5. The flavour contract (six fields)

If every block is the same shape, you are not building features — you are building **one consumer interface and a registry of flavours**. A flavour declares:

1. **inputs** — how many refs, behaviour when missing/stale.
2. **transform** — `(resolved inputs, own config) → output`. (*own config* = the dev/prod env, the prompt, the highlight language…)
3. **cascade tier** — pure/cheap (auto) vs expensive/side-effecting (mark-dirty-only).
4. **persistence** — does output cache to YAML or evaporate (block proposes; the reconciler can insist if there's a live downstream consumer).
5. **view** — how it draws itself in the editor.
6. **cement representation** — how it collapses into the document when filed (see §7).

Every section of brainstorm 1 is different values of these six fields. New block type = register a flavour.

### The guardrail

The graph is uniform at the **wiring** layer, but *what makes sense to wire* lives in the flavour (a mermaid renderer wants diagram-ish text; a table wants tabular data). Structurally you *can* point a payload at a pie-chart renderer; semantically it's the flavour's job to parse, validate, or degrade gracefully — not the reconciler's. This is why **text (stdout-style) on the wire** is the right call: it keeps the graph dumb and pushes all interpretation into the flavours, exactly matching the Go-playground model.

---

## 6. Worked example: HTTP clients (fan-in, gating, free diff)

The HTTP idea is not a separate feature — it's the reference model where the consumers happen to be **executors** instead of renderers. Same wiring; the consumer just has side effects.

- **Fan-in:** a client is `f(payload, environment)`. Dev-client and prod-client reference the **same payload** but a **different `env`** block. The `env` block stops being a magic global and becomes a first-class referenceable source. The *only* difference between dev and prod is which env they also point at — a single swapped reference.
- **Decomposition:** the monolithic HTTP block splits into a reusable **payload** + a thin **client** (`{payload ref} + {env ref} + {method}`). Same payload, many transports; same transport, many payloads.
- **Gating:** edit the payload → both clients glow dirty (great signal). The dev client *may* auto-fire (sandbox); the prod client must **never** auto-fire. This is the textbook justification for per-consumer cascade tiers.
- **Free feature:** each client caches its own response, so a third consumer can reference both and **diff environments** ("what does staging return that prod doesn't?"). Fan-in again, for free.

---

## 7. Cement / Embed: the paste-values layer

The existing **"Embed in Document"** action *is* the crystallisation we theorised: "I've got my value out of this; now cement the intelligence in place." The right mental model is Excel's **Paste Special → Values**: keep the value, drop the formula/liveness.

The earlier **"Hide AI"** feature is the *same transform applied as a non-destructive lens* — the "show values" toggle — letting you eyeball or export a clean document (Confluence, email) without killing the live blocks. So there is **one transform, two modes**:

- **Lens** — temporary, reversible, for viewing/export. (Evolved "Hide AI," now applied to *every* flavour.)
- **Commit** — permanent; drops the reference, cements the value.

Hide-AI and Embed were never separate ideas — the same operation at different commitment levels.

### Cement is flavour-specific (field 6), with three behaviours

- **Freeze** — snapshot the value as-is (code output; a captured response-as-data).
- **Translate** — reshape *tool-form into doc-form*. The rich one: an **AI thread → rewritten prose**; an **HTTP client → OpenAPI/Swagger definition**. The block changes *shape*, not just liveness. This is what kills the "thread feel" — conversation becomes narrative.
- **Drop / degrade** — "doesn't make the trip." Rarely a clean vanish: a visual renderer should degrade to its **last rendered frame as a static image** so the exported doc still shows *something*; only genuinely interaction-only blocks (a live console) leave a placeholder or nothing. Ladder: **prose/data → static snapshot → placeholder → nothing**; the flavour picks its rung.

### Caution: Translate is generative

Thread→prose costs an AI call at cement time and is non-deterministic. **Do not** make it an instant destructive swap: **generate → editable draft → accept**, and keep the original recoverable (this is a keep/discard tool anyway). Translate-cement is a *suggestion*, not a silent replace.

This closes the knowledge loop: the cemented form (prose, data, or a **timestamped** static snapshot) *is* the durable knowledge; the live form is the scratchpad; **Embed is the precise moment one becomes the other**; "export to Confluence" is just cement-as-lens over the whole document.

---

## 8. Mission fit: scratchpad vs knowledge base

The two missions pull on the axis of **time**: a knowledge base wants *stable, durable, trustworthy*; a live breadboard wants *current, reactive, re-runnable*. The fear is that executability pollutes the knowledge base with mutable content masquerading as durable fact.

The reference+cache model *is* the reconciliation, and it maps onto the "sieve" metaphor:

- **The reference half is the scratchpad** (intake — thinking).
- **The cache half is the knowledge base** (product — kept knowledge).
- **The keep/discard-on-close moment is the phase transition** between them.

Two non-negotiables make executable output safe as knowledge:

1. **Stamp everything.** Undated execution output is knowledge-base poison; *dated* output ("prod returned X as of March") is a legitimate historical record. The cache must carry value + source + timestamp.
2. **"Keep live" dies on filing.** A filed note that mutates under you isn't a record. Liveness is a scratchpad-mode property; filing snapshots; reopening re-arms it. (This is the "open never executes" rule from the other side.)

---

## 9. Security: capability is the boundary

Most "smart blocks" are **one-trick ponies**, and that one-trick-ness *is* their sandbox. The capability boundary is the security boundary. Three tiers:

1. **Pure transforms** (table, diagram, format) — no system/network access. Zero novel risk.
2. **Bounded egress** (the HTTP block) — one capability, but talks to the network and can carry substituted secrets. A real-but-small exfil path — *and the target URL is visible in the markdown.* Small + legible.
3. **Arbitrary code** (Python/bash/node) — unbounded; the only tier where the danger can be obfuscated. This is the `curl | bash` footgun — real, but **a foot the user owns**, no worse than running code in an IDE.

The sandbox question therefore applies **only to tier 3**, behind a pluggable **runner seam**:

- **Local native runner** — full power, footgun, desktop-only. Good for "spin up a real server / touch my filesystem."
- **WASM runner** — capability-gated (deny-by-default; the host grants each import explicitly). Per-language runtimes (Pyodide, QuickJS, TinyGo, ruby.wasm) are heavy but exist.

WASM is the one path where **executable + shareable + web coexist**, because the sandbox *is* the runtime and it runs in the browser. Same block, same Run button, same stdout pane — the deployment picks which jail the code runs in. Tier-3 blocks should be **visually distinct** so "this one runs arbitrary code" is never a surprise.

---

## 10. Two litmus tests for what's in

Two independent filters, and they agree — which is the signal the line is right:

1. **Identity:** does this feature make *code serve the thinking*, or *thinking serve the code*? (Sieve is prose-first; Jupyter is code-first. The inversion is the thesis.)
2. **Mission:** **what does it leave in the drawer after I close the lid?** Does it collapse to a stamped, durable, self-contained snapshot on filing?

| Idea | Identity | Leaves a knowledge residue? | Verdict |
|---|---|---|---|
| HTTP **client** Sieve | ✅ | ✅ response-as-data / OpenAPI | **In** (build first) |
| AI listener / self-updating critique | ✅ | ✅ prose | **In** (the differentiator) |
| Code block + renderers (diagram/table/chart) | ✅ | ✅ source + snapshot | **In** |
| AI Critic + Swagger import | — | ✅ | **Byproduct**, not a goal |
| **Server** Sieve (running processes) | ❌ thinking serves code | ❌ a running process isn't a fact | **Out / quarantine** |

> *Caveat, per the conversation:* don't over-index on these filters to the point of killing **cool**. Cool is energising for the builder and the user, and energy is what gets the app written. The filters decide which *drawer* a thing lands in (or that it lands in none — fine for a pure-energy spike), not whether it's allowed to exist.

The strongest single thread for *this* tool (an architect's design-doc workspace): **living documents that keep their own analysis current** — AI listener blocks that re-critique as the document changes, then cement to prose on filing.

---

## 11. The real frontier is the substrate, not the flavours

Conceptually the model is sound and mostly TipTap-native (rich *per-block* UI via NodeViews is already proven by the diagram block). The strain is elsewhere, and it is the actual prerequisite the whole vision rides on:

- **Do not chase a canvas.** A canvas (n8n/tldraw style) is right when *the graph is the artifact*. For Sieve the *document* is the artifact and the graph is metadata. The linear, top-down narrative with gutter lineage is **more legible** and is the knowledge-base fit. The itch for "flexible arrangement" is cured a notch short of a canvas: **block drag-reorder**, collapsible blocks, and optionally **columns / side-by-side** blocks (a diagram beside its explanatory prose). Spectrum, least-fight → most-fight: *linear+gutter → columns → full canvas.*
- **Layout is authorial; the graph is logical — orthogonal, neither derived from the other.** Columns are a **formatting option the user chooses** (most valuable for visual renderers: a diagram, chart, or image beside text), **never** an automatic projection of the dependency graph. Auto-layout — a layout engine arranging blocks from their references and routing edges — is the trap that costs legibility; *manual* columns don't, because the human placed them deliberately. Mechanically a column-row is just **one container node** in the linear document tree that lays its children horizontally — the blocks inside keep their refs, flavours, cache, and cement behaviour, and the reconciler/serialiser don't notice. A reference may cross a column boundary (left-column prose explaining a right-column diagram); that's fine, because the ref is logical and the columns are visual and they need not agree. On cement/export the column survives or linearises per **destination** (Confluence keeps it; plain email flattens it).
- **Copy/paste: the ask is consistency, not capability.** "Random" is the enemy. A predictable, slightly-limited **block-level** model (clear boundaries, gap cursor, whole-block select/copy, clipboard that round-trips via `toDOM`/`parseDOM`) feels better than a powerful character-level one that surprises you. Don't fight ProseMirror for seamless character-level cross-block selection — it will fight back forever. The smart-block direction *helps* here: richer, more island-like blocks shift the interaction unit from *character* to *block*.
- **Drag-and-drop is the "real editor feel."** A solved pattern (drag handles); it's what makes the boxes feel *placed* rather than "all over the place," and it's what makes the cool stuff read as intentional rather than janky.

**Sequencing implication:** the substrate (selection / clipboard / block-reorder) is foundational plumbing that no amount of conceptual elegance avoids, and it compounds — every new island block makes today's "random selection" worse. It is worth a dedicated spike *before* piling on flavours, because janky-cool stops being cool fast.

---

## 12. Status of the open questions

| Question (from the thread) | Resolution |
|---|---|
| What does a reference carry? | **Text on the wire** (stdout-style); flavour parses. Live pointer in editor, cached value on disk. |
| Value vs reference plumbing? | **Both** — reference + cache (spreadsheet model). |
| Who orchestrates reactivity? | The **blocks-list reconciler**; blocks stay dumb. |
| Linked list or DAG? | **DAG** with observable edges (fan-in is required: HTTP client = payload ⊕ env). |
| How to avoid runaway recompute? | Propagate **staleness, not execution**; auto-run is a per-block tier. |
| Executable + shareable collision? | Execution is **local-only**; web renders the cache; **WASM** is the one bridge. |
| Where do outputs live? | **Cached to markdown** if interesting (stamped); else ephemeral. |
| How does dynamic melt into a document? | **Cement / Embed** = paste-values, with a per-flavour cement representation (freeze / translate / drop-degrade). |
| How much 2D before it costs legibility? | **Resolved:** columns are safe because they are a *manual, authorial* formatting choice, not an automatic graph projection. Auto-layout is the trap; hand-placed columns aren't. |
| Still genuinely open | The interaction substrate (selection/clipboard/drag-reorder) — the foundational plumbing the whole vision rides on. |

---

## 13. The spine, compressed

1. **Dumb blocks + a reconciler** over the blocks-list that owns the graph, dirty-set, cascade policy, cycle detection, and referential integrity.
2. **Reference + cache** (spreadsheet): live pointer in the editor, cached value on disk, text on the wire.
3. **Six-field flavour contract**; every block type is a flavour, including the cement representation.
4. **Staleness propagates; execution is gated** by per-block cascade tiers (prod-client = never auto-run).
5. **Capability taxonomy**; only the arbitrary-code tier sees a sandbox, behind a local/WASM **runner seam**.
6. **Cement / Embed** = paste-values; the moment scratchpad becomes knowledge; stamped on the way.
7. **The substrate is the real work**: predictable selection/clipboard + block drag-reorder, on a deliberately *linear* canvas with gutter lineage.

Build the **atom** — a Go-Playground-style block (editor + Run + stdout pane, stateless, runner behind it) — and most of the rest is *what happens when output panes become input ports*.
