# Block Affordance Recognition — design

**Status:** proposed (2026-06-24). Successor to the C-W convergence (commit `47525b4`).
**Goal:** move the "what can I do with this content" decision out of the frontend and
into the backend processor, so the recognition contract returns *affordances* (which
operations apply) rather than a bare boolean — and the operation round-trips
end-to-end so the backend acts deterministically.

---

## The problem

Today the extract/transform decision is **split across layers**, and partly
frontend-only:

1. `DetectExtractions(sourceKind, entries)` iterates processors and returns candidate
   **kinds** — just `IsBlock` booleans. ("Which kinds *could* be built from this?")
2. The frontend then decides **extract vs convert** itself: `replaceSource` (computed
   from native-vs-Sieve source) and `additiveKinds` live in `context-menu.js` /
   `sieve-block-extension.js` (`detectAndAppendExtractions`).
3. The backend `handleExtract` payload is `{targetKind, entries, index}` — it does **not
   carry** the operation. The backend creates a new block blindly; the **frontend**
   removes/replaces the source node (`editor.js`, `replaceSource`).

So "what operation is this" is reconstructed in the frontend from heuristics
(`sourceNode.type.name`, `additiveKinds`), and the backend never knows. Two sources
of truth that can drift; the backend re-derives the target by kind lookup but never
learns the operation.

### Why the source/target knowledge is already present

The decision is a function of the **(source, target) pair**, and the entries already
encode the source:

- **Sieve-block source** → carries a `sieve/<kind>` view
  (`sieve-block-extension.js:897`). A composite whose content is a *fragment* →
  **EXTRACT** (additive; source survives).
- **Native-node source** → only raw MIME, no sieve view (native code →
  `{text/plain, src}`; link → `{text/uri-list, href}`). Its content **is** the block →
  **TRANSFORM** (replace in place).

`IsBlock` *already* discriminates on exactly this (`IsSieveType` / `SieveAttrs` key off
the `sieve/<kind>` view). So the replace-vs-additive decision the frontend recomputes
is already latent in the entries the backend receives.

The one lossy spot: the `additiveKinds` shape nuance (inline link → block card stays
additive because the shapes differ) — `text/uri-list` is shared by an inline link and a
block image, so MIME alone can't tell inline from block.

`ContentEntry.Context` is the home for that. **Current state:** `Context` is a free-form
per-entry `map[string]interface{}`, and today it has exactly ONE use — `WebClipBlockProcessor.Transform`
reads `Context["mode"]` (`fetch`/`summarise`, chosen from the web-clip extraction
sub-menu). So it already exists as the "extra parameters for this view" channel.

**The extension:** rather than make the backend *infer* shape from MIME, the frontend
*states the source identity* — it already knows it (it's the menu header:
`extractSourceLabel` / `sourceKind` / the PM `sourceNode.type.name`). Stamp it into
`Context`, e.g. `sourceType: native-code | image | link | smart-link | selection | …`
(and `shape` if useful). Because the map is open, a processor can carry whatever it
needs without changing the contract, and the backend decides with full fidelity — no
inference, no frontend heuristic.

---

## The design

### 1. Recognition returns affordances, not a bool

Replace (or wrap) `IsBlock(entries) bool` with a method that returns the operations
this processor offers for these entries — computed from the entries alone (which fully
describe the source):

```go
type Operation string

const (
    OpPaste     Operation = "paste"     // clipboard content -> new block
    OpExtract   Operation = "extract"   // additive: new block alongside (source survives)
    OpTransform Operation = "transform" // replace in place (native upgrade; Embed/promote)
)

// Offers reports which operations THIS processor can perform on the given entries.
// Pure, side-effect free (like IsBlock). The entries fully describe the source
// (MIME views + Context.shape), so the processor — not the frontend — decides
// additive (Extract) vs in-place (Transform).
Offers(entries []ContentEntry) []Operation
```

The registry composes these into the menu offer (per candidate kind, the operations it
offers). Naming note: do **not** call the descriptor `BlockContext` — it collides with
`AIContext` / `JobContext`. `TransformOffer` / `Affordance` read cleaner.

### 2. The operation IS the additive/replace decision

No separate `replaceSource` flag. The enum captures it:

| Operation | source | result |
|---|---|---|
| `PASTE` | clipboard | new block |
| `EXTRACT` | Sieve-block (composite) | new block alongside; source survives |
| `TRANSFORM` | native node, **or any block being Embedded** | replace in place |

### 3. The round-trip carries `{operation, targetKind}`

The frontend becomes a dumb renderer: it shows the offer and plays back
`{operation, targetKind, entries}`. The backend does `GetProcessor(targetKind)` and
applies the **named** operation — no iteration, no re-derivation, no frontend heuristic
to drift. The `replaceSource`/`additiveKinds` logic leaves the frontend entirely.

### 4. The `Context` contract — optional named keys

`ContentEntry.Context` becomes a small contract of **optional, named** keys. A processor
reads only the keys it cares about; nothing is mandatory. The frontend stamps whatever
it knows at menu/extract/paste-creation time. Inventory of what is *already in scope*
(so most of this is "carry what we already compute", not new derivation):

**Source-side (Extract / Transform)** — the menu has the source node in hand:

| Key | Already available as | Used for |
|---|---|---|
| `sourceType` (image/link/code/diagram/…) | **`extractSourceLabel`** — computed today (`sieve-block-extension.js:928`), used only for the menu header then discarded | the discriminator "what was clicked" — the **quick win**, it's free |
| `shape` (inline/block) | `sourceNode.isInline` / `.type.name` | the `additiveKinds` nuance (inline link → block card stays additive) |
| `sourceId` + source attrs | already inside the `sieve/<kind>` entry content (`sieveBlockAttrs(node)` carries `id`) | lineage/ref — a block extracted from a composite can point back |
| `language` | `codeNode.attrs.language` (already how code vs diagram is decided at `:968`) | targets that care about language |
| `mode`, `model` | web-clip submenu (`mode` already consumed by `WebClipBlockProcessor.Transform`; `model` is a web-clip attr) | the existing web-clip case, generalised |
| selection text/range | the PM selection when text (not a node) is the source | a `selection` source type |

**Target-side (Paste)** — a paste has **no source node**, so its relevant context is the
*target*: `targetKind`, `targetShape`, insert index / adjacent block. Same open map; the
keys that matter differ by operation, which is fine since a processor reads only what it
needs.

Define these as named constants so the contract is explicit. `sourceType` is the first
to wire — the frontend computes `extractSourceLabel` and throws it away today.

---

## What this subsumes: prose, promote, and KindProse

Prose is the **universal sink in both directions** — one superpower, two recognition
hooks:

| | hook | prose's answer | what flows in |
|---|---|---|---|
| **Parse** (disk → blocks) | `Accepts(region)` | true for anything (mop-up) | unclaimed text → prose |
| **Transform** (block → doc) | `Offers`/`IsBlock` | should be `[TRANSFORM]` for any source | any block's `MarkdownRepresentation()` → prose |

So **"Embed in Doc" / "Promote to prose" is just prose offering `TRANSFORM` for any
source** — `replaceSource: true` unconditionally, content built from the source block's
`MarkdownRepresentation()` (which `PromoteBlock` already calls). The bespoke
`EditorService.PromoteBlock` dissolves into the generic transform path; its only
remaining job is the *replace-in-place* mechanic (preserve id + document position),
which is `OpTransform`'s definition.

This is what finally retires the **transitional `KindProse` constant**
(`processor_registry.go`): once promote is prose's `Transform`, `editor_service` no
longer names prose. The prose processor keeps its own identity (`Kind()` →
`"prose"`); nothing generic branches on the string.

Prerequisite to broaden: prose's `IsBlock`/`Offers` must claim **any** source for
`TRANSFORM` (today it only claims a `sieve/prose` view — see the "future broadening"
note at `prose_processor.go:95`).

### Where the `MarkdownRepresentation` lookup lives — DECIDED: prose owns it

To embed a Sieve-block source, prose needs that source's `MarkdownRepresentation()`,
which means resolving its processor by kind → the registry. **Decision: `prose.Transform`
does the lookup itself**, via `block.GetProcessor(sourceKind).MarkdownRepresentation(srcBlock)`.

- No signature change — `GetProcessor` is a package-level function prose can already
  call; it returns the `BlockProcessor` *interface*, so no import of code/diagram and no
  cycle. Same global registry indirection `FirstPasteMatch` already uses.
- The knowledge *"embed any block = take its `MarkdownRepresentation`"* lives in **prose**
  (the universal sink), exactly mirroring how prose owns "claim any region" on the parse
  side. Prose's universality is prose's own responsibility — never the framework's.

The rejected alternative — having the orchestration pre-compute `MarkdownRepresentation`
and inject it as an entry view to keep `Transform` "pure" — **breaks encapsulation**: the
framework would have to know what prose's `Transform` does, and every *other* processor's
`Transform` would receive a prose-specific input it doesn't care about. The apparent
purity just relocates prose's coupling into the framework, where it is worse.

Scope note: a *native* source already arrives as `text/plain` with its serialized text in
the entry, so prose's existing generic arm (`prose_processor.go:119`) handles it with no
lookup. Only a **Sieve-block source** (a composite carrying just attrs) needs the
`GetProcessor → MarkdownRepresentation` resolve.

---

## Build order (TDD, when picked up)

1. Extend the editor extract path to stamp the source identity into
   `ContentEntry.Context` (`sourceType`, and `shape` if needed) — the frontend already
   knows it (menu header). Assert the additive-vs-replace nuance is decidable from an
   entry alone. (`Context` already exists and carries web-clip's `mode` today.)
2. Introduce `Operation` + `Offers` on the processor contract; implement per processor
   (structured kinds: `EXTRACT` from a Sieve source, `TRANSFORM` from a native source;
   prose: `TRANSFORM` for any source). Keep `IsBlock` as a thin shim during migration.
3. Registry composes the offer; `/api/detect-extractions` returns
   `[{kind, operations}]`; delete the frontend `replaceSource`/`additiveKinds`
   heuristics — render from the offer.
4. `handleExtract` payload gains `operation`; `EditorService` applies it
   (`TRANSFORM` = replace-in-place). `PromoteBlock` → generic transform-to-prose.
5. Broaden prose `IsBlock`/`Offers` to claim any source; retire `PromoteBlock` and the
   transitional `KindProse`.

## Out of scope / watch

- The create-render-back asymmetry in `HandleBlockOp` (`op.Kind != KindProse`) is a
  *different* axis (does Go owe the editor an `insert-block`?). It is the
  `block-op-create-convergence` thread, not this one — but it likely also wants intent
  on the op rather than a kind check. Note, don't fold in blindly.
- The pre-existing concurrent-`flushShadow` race (two flush paths writing the shared
  document buffer) surfaced during C-W; unrelated to this design but still open.
