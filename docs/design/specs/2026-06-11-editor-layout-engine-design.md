> **STATUS: PARTIAL — INPUT TO STAGE E/F RE-BRAINSTORM (TECH-DEBT U-A).** Stage 1 chrome partially shipped; Stages 2–4 deferred.

# Editor-Pane / Layout-Engine Rebuild — Design

**Status:** Design (approved in brainstorm 2026-06-11)
**Companion docs:** [brainstorm-smart-code-blocks-2.md](../../brainstorm-smart-code-blocks-2.md) (the "design spine"), [how-to-intelligent-fenced-blocks.md](../../how-to-intelligent-fenced-blocks.md), [how-to-sieve-block-framework.md](../../how-to-sieve-block-framework.md)

---

## 1. Problem & intent

The editor pane is the next functional gap. Today it is a single TipTap instance (`frontend/src/static/editor.js`) holding a flat, linear ProseMirror document: prose nodes plus a set of custom **leaf** nodes (the Sieve YAML fenced blocks built by `createSieveNode` in `sieve-block-extension.js`). Three things are missing or weak, and they only "fit together" as a set:

1. **Consistency** — prose nodes and fenced-block NodeViews have no shared chrome; the editor feels like two different surfaces.
2. **A rock-solid interaction substrate** — selection / clipboard / drag-reorder are inconsistent ("random") because blocks are opaque islands ProseMirror cannot traverse.
3. **The future the product rides on** — manual columns (a diagram beside its prose) and a reference/lineage rail (making spooky-action-at-a-distance legible), per brainstorm 2 §11.

This document designs all three as **one coherent system**, with a **staged build order** so each stage ships independently. The design does not carve the system into disconnected chunks; staging only decides ship order.

### Goals
- A consistent editor with a single chrome, single handle, single selection unit, single clipboard contract across every top-level block.
- A predictable, block-level interaction substrate (§11: *consistency beats capability*).
- Manual, authorial **columns** as a first-class container.
- A **lineage rail** (gutter + structural document map) that extends the *existing* block-anchor/word-highlight language.

### Non-goals
- **No canvas / auto-layout.** Layout is authorial; the graph is logical; the two stay orthogonal (brainstorm 2 §225–226).
- **No substrate switch.** ProseMirror/TipTap stays (see §2). No React (per CLAUDE.md, Phase 9).
- **No nested columns in v1** (depth cap = 1; see §6).

---

## 2. Substrate decision (settled hypothesis)

We explicitly re-tested "is TipTap still right? (Monaco / CodeMirror?)" and kept it.

| Engine | Document model | Verdict |
|---|---|---|
| **TipTap / ProseMirror** | a **tree** of schema-constrained nodes | **Keep — the substrate.** WYSIWYG "render as you type," embedded islands, containers/columns, block-level ops are all native tree-document work. |
| CodeMirror 6 | sequence of lines (text + decorations) | **Nested only.** Great for code editing *inside* a code-block NodeView, and a candidate to replace the raw-markdown `<textarea>` mode. Not the document. |
| Monaco | text + language services | **Rejected.** IDE-weight, code-first, hostile to embedded interactive widgets. |

The choice maps onto the identity thesis (brainstorm 2 §10): ProseMirror is the prose-first substrate; CodeMirror/Monaco are code-first. Choosing a text engine as the document would invert the thesis. The pain we feel (ragged cross-block selection) is the cost of structure, and the fix is to shift the interaction unit from character to block — *more* ProseMirror, not less.

**Decision:** ProseMirror/TipTap remains the document & layout engine. CodeMirror is adopted only nested inside code surfaces.

---

## 3. The unit of layout

**Every top-level node is a block** (heading, paragraph, list, fenced block, container). Each gets uniform chrome — a gutter cell + a hover drag-handle — applied as **ProseMirror decorations / overlays**, *not* by rewrapping the schema. Prose still flows and selects naturally inside a paragraph; the chrome is the layout engine's consistent grip.

The handle is **both** the drag-grip and the selection-grip — which is why the uniform chrome is load-bearing for the interaction substrate (§5).

Rejected: islands-only (no consistency) and Notion-style "every line a bordered block" (fights free-writing; heaviest schema change).

---

## 4. The container-node foundation (the real defect)

This is the deep enabler hiding behind "columns," and it fixes a present defect: **block ids cannot contain child block ids.**

**Why:** every Sieve node today is a **leaf**. `createSieveNode` (`sieve-block-extension.js:67`) declares no ProseMirror `content` expression; the NodeView sets `view.dom.contentEditable='true'` and then a `beforeinput`→`preventDefault` (line 127) to stop native input. The block carries its whole payload in the `serialisedForm` attr (`BASE_ATTRS`, line 57). PM therefore treats it as an **opaque island** it cannot model — the direct cause of ragged cross-block selection and "random" clipboard behaviour.

**Fix:** introduce **container-shaped** nodes that expose a real `contentDOM` and a `content` schema. From here, the block world has two shapes:

| Shape | Schema | Examples | Selection / clipboard |
|---|---|---|---|
| **Container** | `content: block+` / `sieveColumn+`, real `contentDOM` | `column-row`, `column`, (candidates: callout, AI-prose) | **Native PM** traverses in/across — copy/paste "just works" |
| **Leaf / atom** | no `content`, carries `serialisedForm` | diagram, code, image, smart-card, web-clip | **Block-level `sieve/<kind>` contract** |

Conversion from leaf → container is **per-kind work** (define content schema, expose `contentDOM` instead of the JS-managed editable DOM, serialize children via §6). Done only where content is genuinely prose-shaped — `column`/`column-row` first; `callout`/`AI-prose` are later candidates. **Diagram / code / image deliberately stay atoms.**

**Payoff:** this one substrate piece retires two of the three pains — consistency *and* rock-solid selection — because prose-shaped islands become transparent native structure.

**Precedent & succession — `blockRef`.** A partial container already exists: `BlockNode` / `blockRef` (`extensions.js:74`), the legacy **block anchor** (`[!block] id="…" … [!block-end]`). It declares `content: 'block+'` and a `contentDOM`, but it is the *broken* attempt — fragile to parse (the markdown-it `updateDOM` while-loop, `extensions.js:108+`), and it **cannot nest** (anchor-in-anchor breaks). It is slated for retirement. The proper container node built here is its **successor**: same goal (a block that holds blocks), done correctly (clean schema, robust YAML-fence serialization, nests). **This column/container work is therefore the precursor that lets the legacy block anchor make way** — retiring `blockRef` onto the new substrate is a first-class downstream outcome, not a side quest. Do **not** extend the `[!…]` parser; build the new container fresh.

---

## 5. Interaction substrate (the "rock solid" core)

Principle (§11, §227): *a predictable, slightly-limited block-level model beats a powerful character-level one that surprises you.* Do **not** fight ProseMirror for seamless character-level cross-block selection.

**Selection**
- Inside one text block → normal **character** selection (today's free-writing feel, untouched).
- Crossing into a **container** block → **native PM traversal** (select into/across it).
- Crossing a **leaf/atom** block → **snap to whole-block**.
- Click drag-handle / gutter cell → selects that whole block; **shift-click** another → block range.
- **Gap cursor** always available above/below/between island blocks — the caret can never get trapped.

So "snap to whole block" is specifically *"snap at atom boundaries; traverse containers."*

**Clipboard** — generalize the pattern that already exists. `sieve-block-extension.js:228` already emits `{ mimeType: 'sieve/' + node.attrs.kind, content: node.attrs.serialisedForm }`. Extend it:
- From single-block to **multi-block selections and the `column-row` container**.
- `serialisedForm` is authoritative; `text/plain` = markdown and `text/html` = `toDOM` are lossy external fallbacks.
- **Paste** sniffs `sieve/<kind>` → reconstruct via the flavour's parser (refs/cache/flavour intact); else parse html/markdown best-effort.

**Drag-reorder** — the handle drags whole block(s); a drop-indicator shows the insertion line between blocks, or *into a column cell* when hovering a cell. One gesture, three outcomes: reorder / enter column / leave column.

The throughline: **one chrome, one handle, one selection unit, one clipboard contract** — every prose and island block obeys the same rules. That uniformity *is* the "consistent UX feel."

---

## 6. Columns — the 2D layer

A `column-row` is **one container node** in the linear document tree that lays its children horizontally. Its children keep their refs, flavours, cache, and cement behaviour; the reconciler and serialiser don't otherwise notice (brainstorm 2 §226). References may cross a column boundary — layout is visual, the graph is logical, and they need not agree.

**Structure (editor schema):** `column-row` → `column+` → `block+`. The `column-row` is itself a top-level block (so it has its own chrome handle and a `BASE_ATTRS` `id`). Its children are real ProseMirror block nodes (prose + sieve blocks).

**Creation — three gestures over the single container:**
- **(B) Insert / slash** an empty 2/3-column layout, fill cells. *Shared plumbing — built first.*
- **(A) Drag** a block's handle onto another block's left/right edge → fuse into a row. *Reuses B's drop-into-cell + edge-detection. Second.*
- **(C) Select adjacent** blocks → "group into columns." *Nearly free once block-selection exists. Alongside selection.*

**Resize:** a draggable **grab-handle** on the divider updates a `widths: [...]` ratio attr live; widths serialize with the container.

**Depth cap = 1 for v1** (no `column-row` inside a `column`), enforced as **gesture policy** (block the create/drop), *not* a schema restriction. ProseMirror allows the recursion for free; we cap it to preserve legibility (deep nesting is the slide toward a canvas, §225) and to avoid fragile nested serialization. Relaxing the cap later is a one-line knob.

---

## 7. Column serialization — `` ```column-row `` Sieve block (Shape 1)

Columns serialize as a normal Sieve fenced block (kind `column-row`), **not** a `:::`-fenced div and **not** raw HTML. The body is a declarative widget tree.

```column-row
id: cr1
widths: [0.55, 0.45]
columns:
  - children:
      - |
        Every request carries a **bearer token**. The gateway
        checks the cache, then the auth service on a miss.
  - children:
      - diagram:
          id: d1
          source: |
            Client --> Gateway --> Auth
```

**Rules:**
- The `children` array is a **discriminated union**:
  - a **string scalar** = prose, treated as **verbatim standard markdown**, injected through the normal markdown parser. **There is no "prose kind" and no Sieve-markdown dialect** — only Sieve Blocks get special handling (the same JS/Go split as `project_native_codeblock_serialization`).
  - a **single-key map** = a Sieve Block in **Shape 1**: the kind is the map key, properties nested beneath it (`- diagram: { id, source }`). This is a 1:1 translation of the standalone fence (info-string kind → map key; fence body → nested value).
- Parse rule for a child: `typeof item === 'string'` → prose; else `Object.keys(item)[0]` → kind.
- Inner-fence safety uses the existing YAML `|` literal-scalar + `forceLiteralStyle`/indent mechanism (`fencedblock.Serialize`; cf. `project_diagram_block`), so verbatim markdown — including a nested ``` fence — round-trips byte-for-byte.
- In-memory `kind` is a flat `BASE_ATTR`, so serialization does a trivial lift/lower at the boundary (`{kind:'diagram', …}` ↔ `{diagram:{…}}`).

**Why this over `:::` fenced-divs:** consistency. A `column-row` degrades exactly like every other Sieve block (a non-Sieve reader sees a `` ```column-row `` code block), it's one fence convention, it's a single self-contained `serialisedForm` that the existing `InjectBlocks` and `sieve/<kind>` clipboard already handle, and nesting is via unambiguous YAML indentation rather than fragile `::::` colon-escalation. The only thing `:::` did better — free flatten-for-dumb-readers — is moot because Sieve mediates every export anyway (see §9).

**Why not the `[!…]` / `blockRef` thin-wrapper (the readable-children alternative):** it would reuse the legacy block-anchor marker syntax (`[!block] … [!block-end]`), which *does* keep children readable — but it is parsed by the fragile `updateDOM` loop, **cannot nest**, and is being **retired** (§4). Building columns on it would extend a doomed mechanism. The YAML fence rides the **robust** path (js-yaml + `serialisedForm` + `InjectBlocks`) and avoids that parser entirely; the scalar-prose rule (above) buys back the readability without the fragility. Robustness + acceptable SNR beats the marker-wrapper's readability + fragility.

> **~~Open spike (Stage 2)~~ — RESOLVED 2026-06-14:** the inner-fence mechanism is proven for one level (diagram = fenced code in YAML). Columns embed *arbitrary* blocks (including other fenced blocks). ~~Confirm~~ Confirmed multi-level YAML `|` nesting composes 2–3 deep — `forceLiteralStyle`'s tree recursion keeps deep multiline scalars in `|-` literal style with structural indent a multiple of 4 (fence-safe at any depth). Verified by `sieve/columnrow_serializer_test.go:TestColumnRow_NestedScalarComposesUnderNesting` (depths 4 and 5) with a raw-output assertion + byte-stable round-trip.

---

## 8. Lineage — gutter rail + structural document map (objective 3)

References cause spooky-action-at-a-distance. The lineage system makes it legible and is **one vocabulary at three zoom levels**:

- **micro** — highlighted word/anchor *inside* a block (already exists; `smart-link-renderer.js`).
- **meso** — bracket-chain in the **gutter rail** tying a source to its consumers.
- **macro** — the **structural document map** down the side.

**Crucial constraint:** the gutter rail and map **extend the existing block-anchor/word-highlight visual language — they do not introduce a parallel system** (see memory `project_block_anchor_lineage`).

**Gutter rail — Hybrid visibility:**
- **Always-on:** a faint "participates in lineage" tick, and **dirty-glow** on stale blocks (safety-critical — a consumer whose cached value differs from its source's current output).
- **On hover/select:** full bracket-chains + neighbour highlight; **edited node + immediate neighbours bright, deeper transitive staleness dim** (so it never becomes a "Christmas tree", §107).

**Structural document map (not a minimap):** one cell per block, coloured by flavour, column-rows shown as side-by-side cells, **off-screen dirty-glow** (the "five screens away went stale" signal), faint lineage edges, a viewport box, click-to-jump. It is the macro end of the same lineage vocabulary and depends on flavour + staleness + reconciler.

**Two-phase delivery (the gutter does NOT wait on the reconciler):** the *edge data already exists* — the `ref` attribute is a comma-separated list of upstream block IDs (e.g. `ai-block-renderer.js:31`), already traversed Go-side by `ai_block_processor.go` (`strings.Split(ref, ",")`, `expandAIBlockRefs`). So:
- **3a — Lineage rail v0 (no reconciler):** read each block's `ref` chain, resolve the IDs to positions, draw the bracket-chains in the Stage-1 gutter. A real, static "graph of linked blocks." *Honest gap:* today `ref` lives mostly on AI blocks (`default:'doc'`), so the graph is **sparse** until other kinds carry refs — but the rendering is complete and the data source updates as the ref model grows. Ships right after Stage 1.
- **3b — Lineage live (needs reconciler):** dirty-glow propagation, the map's off-screen staleness, cascade tiers. This is the part that genuinely waits on the reconciler / reference-graph project (§11).

The rendering is decoupled from how edges are stored, so 3a survives any later rework of the `ref` model.

---

## 9. Cement / lens behaviour for layout

Anchors and columns have **opposite lifecycles across the hardening boundary**, which is a further reason they are different mechanisms:

| | Lens (reversible — view/export) | Commit (permanent) |
|---|---|---|
| **Anchors / reference graph** | hidden, live graph intact; reopening re-arms | dropped; values cemented in place |
| **Column layout** | rendered or flattened **per destination** (Confluence keeps it; email flattens); storage untouched | only a *deliberate* linearise-commit removes the container |

So: **anchor visibility is a function of the lens; column survival is a function of the destination.** For the `column-row` flavour, the **cement representation** (brainstorm 2 §120 field 6) defaults to *freeze/survive* (keep the structure), with an optional *linearise* rung (columns → linear) for 2D-incapable destinations.

---

## 10. Staging (build order — each ships independently)

The deep enabler (containers) is isolated; the visible win (chrome/substrate) lands first; objective 3 closes the loop.

- **Stage 1 — Chrome + reorder + leaf-world substrate.** Decoration-based gutter/handle on every top-level node; drag-reorder; gap cursor; snap-at-island selection; generalized `sieve/<kind>` multi-block clipboard. *No schema change.* Immediate, visible "consistent + solid" win, and §11's "do the substrate spike first."
- **Stage 2 — Container substrate (the defect fix).** Container node shape + `contentDOM`; the `` ```column-row `` serialization (Shape 1, scalar prose) + the multi-level YAML `|` safety spike; refined "traverse-containers / snap-atoms" selection. Unlocks copy/paste for prose-shaped blocks.
- **Stage 3 — Columns.** `column-row` NodeView, resize grab-handle, the three creation gestures (B→A→C), depth-cap policy, cement linearise rung.
- **Stage 4a — Lineage rail v0 (ref-chain graph, no reconciler).** Populate the Stage-1 gutter with bracket-chains drawn from the existing `ref` chains (§8). Static "graph of linked blocks"; sparse until more kinds carry `ref`, but real and shippable. **Can land right after Stage 1** — it only needs the gutter (Stage 1) and the existing `ref` data, not containers or the reconciler.
- **Stage 4b — Lineage live + document map.** Hybrid dirty-glow propagation, the map's off-screen staleness, cascade tiers, structural document map. Couples to the reconciler / reference graph (brainstorm 2 §3–4) — the only stage gated on that separate work.

**Cross-cutting outcome:** once Stage 2's container substrate exists, the legacy block anchor (`blockRef`, §4) can be migrated onto it and retired. Schedule that as a follow-on after Stage 3 (when the container is proven by columns); it is enabled by, but not part of, this layout rebuild.

---

## 11. Risks & open questions

- **Multi-level YAML `|` nesting** (§7) — needs a serialization spike in Stage 2 before columns can embed arbitrary blocks reliably.
- **Per-kind container conversion** (§4) — moving a block from leaf to container (`contentDOM`, removing the `beforeinput` guard) must not regress the existing atom blocks; convert conservatively, prose-shaped kinds only.
- **Decoration performance** — chrome on *every* top-level node via decorations must stay cheap on large documents; reuse the decoration set, avoid per-keystroke rebuilds.
- **Clipboard fidelity across the webview / future web frontend** — custom MIME (`sieve/<kind>`) works in the Wails webview today; verify behaviour for the planned web frontend (`project_architecture_direction`).
- **Lineage ↔ reconciler coupling** — Stage 4 dirty-glow depends on the blocks-list reconciler / reference graph (brainstorm 2 §3–4), which is separate, larger work; Stage 4 should not start before that lands.
- **The drag gesture is overloaded** — reorder (§5), column-drop (§6 gesture A), and a *future* wire-into-input-slot (reference-graph authoring, §13) all ride one drag. The disambiguation model must be reserved now (see §13) so layout drags and wiring drags coexist without ambiguity ("am I moving this or wiring it?").
- **Columns vs wiring visual confusion** — columns (visual side-by-side, *layout*) and lineage ports/lines (*logical* wiring) are both "adjacent blocks with connections." Keep the visual languages strictly distinct: columns = container border + divider; lineage = gutter bracket-chains + transient ports. This is the layout/graph orthogonality made visual, and a real legibility risk if the two blur.

---

## 12. Testing notes

- **Selection substrate** gets explicit cases at the rot-points: caret entry/exit around atoms (gap cursor), snap-to-block at atom boundaries, native traversal across containers, shift-click block ranges.
- **Clipboard** round-trip tests: copy/paste single block, multi-block, and a whole `column-row` within Sieve (rich reconstruct) and into an external target (markdown degrade).
- **Serialization** round-trip tests for `` ```column-row ``: scalar prose verbatim fidelity (bold/links/anchors), Shape-1 block children, widths, and the multi-level inner-fence spike.
- **Degradation**: a `column-row` rendered by a non-Sieve markdown reader shows as a code block (consistent with other blocks); the linearise cement path produces clean linear markdown.

---

## 13. Forward-compatibility with reference-graph authoring

New notes in brainstorm 2 §14 design *how a user draws a reference* (creates DAG edges). That belongs to the reconciler / reference-graph project, **not** this layout rebuild — but two of its requirements constrain the layout engine now, so we **reserve room rather than build**:

- **Reserve a drag "wiring mode."** §14's drag-into-field binding and "logic gate" ports piggyback on the block-drag gesture: on drag, compatible **input dropzones** light up and a drop binds an edge (the block then snaps back to its physical position). Our drag-reorder / column-drop (§5–6) must therefore be built with an explicit **mode/disambiguation seam** — e.g. wiring mode is entered only when the dragged block's output type matches an open, **type-gated** input slot, and is otherwise a pure layout drag. Decide the trigger deliberately; never let reorder and wiring collide.
- **Share the gutter geometry.** §14 shows persistent connections as gutter lineage lines (parent right-output → down the margin → child left-input) — the same rail as §8's bracket-chains. Transient **left-input / right-output ports** appear only during wiring mode and recede; the **persistent** lineage lives in the left gutter. One rail; transient ports for authoring only.

**Already-present footholds (keeps this additive, not greenfield):** the context-menu **"Extract as"** triggers + `detect-extractions`, and **friendly names** via `renderer.getFriendlyName` (`sieve-block-extension.js:223`). The **dropdown-first, drag-later** verdict in §14 matches this spec's staging: dropdown binding is independent and low-risk; drag-to-wire sits on top of the Stage 1/3 reorder substrate.

**Fan-in vs fan-out division (the user's §14 caveat):** **sprout** (extract-as → child pre-wired `parent: id`) handles 1→1 and fan-out naturally; **bind** (dropdown / drag-into-slot, type-gated) handles fan-in (many sources → one consumer). The system needs both — they are the two halves of the DAG, not redundant paths.

---

## 14. Appendix A — Visual reference (the agreed UX illustrations)

The UX for each major decision was worked out as interactive mockups during the brainstorm. They are preserved as standalone, self-contained HTML in **[`assets/2026-06-11-editor-layout/`](./assets/2026-06-11-editor-layout/index.html)** — open `index.html` in a browser. Inline ASCII below carries the structural intent for plain-markdown readers; the HTML carries colour and hover behaviour. **Where the ASCII and prose describe a visual, build the visual — do not downgrade it** (e.g. the document map is a *structural* map, **not** a shrunk-text minimap).

### A.1 — Unit of layout (§3) · [block-unit.html](./assets/2026-06-11-editor-layout/block-unit.html)
Uniform chrome on *every* top-level node, via decorations. The handle is both the drag-grip and the block-select grip; the gutter cell is where the lineage tick lives.
```
 handle gutter   content
   ⠿     │  Auth flow                  ← heading   (top-level block)
   ⠿     │  The gateway validates…     ← paragraph (prose flows natively inside)
         │  ┌────────────────────────┐
   ⠿     │  │ diagram · mermaid      │ ← fenced block (leaf / atom)
         │  │ Client → Gateway → …   │
         │  └────────────────────────┘
   ⠿     │  Next we cache the …        ← paragraph
   ^       ^
   |       └ gutter cell — one per top-level node; carries the faint lineage tick
   └ drag handle — appears on hover; also the whole-block selection grip
```

### A.2 — Columns (§6) · [columns.html](./assets/2026-06-11-editor-layout/columns.html)
One `column-row` container; a diagram placed beside its prose; a draggable divider sets `widths[]`.
```
 ⠿ ┌─ column-row ───────────────────────────────────┐
   │  Every request carries a       ║  ┌──────────┐  │
   │  bearer token. The gateway     ║  │ diagram  │  │
   │  checks the cache, then the    ║  │ Client → │  │
   │  auth service on a miss.       ║  │ Gateway  │  │
   │           (column 1 · .55)     ║  └──────────┘  │
   │                                ║   (column 2 ·.45)
   └────────────────────────────────╫────────────────┘
                                     ↕ resize grab-handle → updates widths[]
```

### A.3 — Gutter / lineage rail (§8, hybrid) · [gutter-lineage.html](./assets/2026-06-11-editor-layout/gutter-lineage.html)
Always-on dirty-glow (safety); full bracket-chains on hover/select. Fan-out: one source → two consumers, one stale.
```
 rail        block
  │┐   ┌─ payload · json  (SOURCE) ───────────┐
  │├──▶│ { users:1240, active:870 }           │
  ││   └───────────────────────────────────────┘
  ││   ┌─ table   (consumer · fresh) ─────────┐
  │└──▶│ users 1240 / active 870              │
  │    └───────────────────────────────────────┘
  │    ┌─ diagram (consumer) ╌╌ STALE ╌╌╌╌╌╌╌┐ ◀ amber glow
  └───▶│ pie … (cached value, awaiting re-run)│   (ALWAYS on — safety-critical)
       └───────────────────────────────────────┘
  faint always-on "participates" tick → full chain + neighbour highlight on hover/select
```

### A.4 — Structural document map (§8) · [doc-map.html](./assets/2026-06-11-editor-layout/doc-map.html)
**This is the at-risk one. It is a *structural* map, not a shrunk-text minimap.** One cell per block, coloured by flavour; column-rows render as side-by-side cells; **dirty blocks glow even when off-screen** (the "five screens away went stale" signal); a viewport box; click a cell to jump.
```
 document (scrolled)                 structural map (right rail)
 ┌───────────────────────────┐       ┌────┐
 │ prose                     │       │▓▓▓▓│ prose      ┐
 │ table (payload-ref)       │       │████│ table      │ viewport
 │ diagram                   │       │▒▒▒▒│ diagram     ┘ (on screen)
 └───────────────────────────┘       │▓▓ ▒│ prose │ diagram   ← column-row (2 cells)
                                      │████│ ai
                                      │▓▓▓▓│ prose
                                      │◉◉◉◉│ diagram    ◀ STALE, glowing (OFF-SCREEN)
                                      │████│ table
                                      │████│ code
                                      │▓▓▓▓│ prose
                                      │◉◉◉◉│ ai         ◀ STALE, glowing (OFF-SCREEN)
                                      └────┘
 legend:  ▓ prose   █ table/ai/code   ▒ diagram  (flavour-coloured)   ◉ dirty-glow
 • one cell per block (NOT pixel-shrunk text)   • column-rows = adjacent cells
 • click-to-jump   • it is the macro zoom of the lineage system (micro = word anchor,
   meso = gutter bracket-chain, macro = this map)
```

### A.5 — Serialization visuals (§7)
- [snr-compare.html](./assets/2026-06-11-editor-layout/snr-compare.html) — why the on-disk file must stay readable (`:::`-thin-wrapper vs YAML-embed SNR).
- [scalar-prose.html](./assets/2026-06-11-editor-layout/scalar-prose.html) — the chosen model: `children:` is a mixed array; a string is verbatim markdown (no prose kind), a map is a Sieve Block.
- [block-shape.html](./assets/2026-06-11-editor-layout/block-shape.html) — Shape 1 (kind leads, props nested), the 1:1 translation of the standalone fence.
