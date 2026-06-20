# Processor-Owned Segmentation — Design

**Date:** 2026-06-20
**Status:** Proposed (brainstormed; pending plan)
**Supersedes the relevant parts of:** the kind-blind `RegionScanner` + `DocumentCodec.Deserialize` coalescing path (tech-debt **S-B**, codec prose-fallback clarity).

---

## 1. Problem

`DocumentCodec.Deserialize` (`sieve/block/document_codec.go`) is hard to understand, and the confusion is structural, not cosmetic. Today it:

- excludes prose from the `Accepts` loop (`firstAcceptor` skips `BlockModeProse`),
- accumulates a `pending []Region` run of unclaimed regions,
- coalesces that run and invokes `prose.Deserialize` explicitly (`flushProse`).

The user's expected model was the obvious one: *iterate every registered processor, first to accept wins; prose is registered last and accepts everything.* The reason that simple model doesn't currently work is the **`RegionScanner`**:

- It runs **vanilla goldmark** and recognises **only fenced code blocks** as boundaries. The `<!--s:ID-->`…`<!--/s:ID-->` prose markers are invisible to it — just text.
- It is therefore **kind-blind AND delimiter-blind to prose**: it splits the document at *every* top-level fence, including fences that sit **inside** a prose block's content.

Because a prose block's identity markers can straddle a fence the scanner *does* see, the scanner shreds one prose block into multiple regions — its open marker in one region, its close marker in another. Per-region dispatch then can't pair the markers: the block's id is lost and the markers leak as literal text (verified empirically). The coalescing exists **solely** to re-stitch those shards so `scanProseRegion` can see the head and tail together.

### Root cause

**Segmentation is not a processor concern.** We already decided serialization and deserialization are processor concerns (each processor owns its on-disk form). But *where a block's region begins and ends* is hardcoded in a scanner that only knows fences. The processor that writes `<!--s:-->` markers has no say in how its own boundaries are found.

## 2. Principle

**Make segmentation a processor concern too — completing the SerDes symmetry.** A processor owns its on-disk form end to end: how it is written (`Serialize`), how its boundaries are found (this design), and how it is parsed (`Deserialize`).

A processor contributes a **shape hint**: the "angle brackets" that bound its regions — a `(head, tail)` token pair. The segmenter is driven by the union of registered shapes; it is delimiter-aware but still kind-blind. `Accepts` remains the authority on *claiming* a found region. Shapes help *find*; `Accepts` decides *own*.

A shape is **kind-qualified**, not generic. A fenced processor registers its specific opener kind (`diagram`, `ai-block`, `code`, …), NOT a bare `` ``` ``. This is the key to leaving ordinary markdown alone:

| Kind of processor | what it registers | recognised by |
|---|---|---|
| fenced (code, diagram, ai-block, log, smart-*) | its **kind name** (`` ```diagram ``, `` ```ai-block ``, …) | native goldmark fence parse; AST walk treats a fence as a structured candidate **only if its info string is a registered Sieve kind** |
| prose | `(head, tail)` = `(<!--s:, <!--/s:)` | custom goldmark block node (opaque interior) |

**Standard code fences (`` ```java ``, `` ```python ``, bare `` ``` ``) match no registered Sieve kind, so they are never candidates** — goldmark parses them as ordinary code blocks and they remain **prose content** (a code sample in a note stays inside its surrounding prose block rather than being carved out and splitting the prose). `Accepts`/`Deserialize` remain the backstop for the rare case of someone literally typing a reserved kind (` ```diagram `) as a code sample — it is rejected for lacking valid Sieve YAML + id and falls to prose.

A future container (columns, Stage E) registers another marker shape (e.g. `<col …>` / `</col>`) and the segmenter is unchanged.

## 3. Design

### 3.1 Shape registration

A custom-node shape is only needed for a delimiter goldmark does **not** already understand:

- **Fenced kinds** (code/diagram/ai-block/…) need no custom node — goldmark recognises `` ``` `` natively. Their "shape" is simply their **registered kind name**, which the registry already holds. The AST walk treats a fence as a structured candidate **iff its info string is a registered Sieve kind**; `Accepts` then confirms. Unregistered info strings (`` ```java ``, bare `` ``` ``) are ordinary code blocks → prose content, never carved out.
- **Bespoke marker kinds** (prose now; columns later) register a `(head, tail)` shape. The codec collects the union of these from the injected `ProcessorRegistry` and feeds them to the custom goldmark block parser (§3.2).

A region is tagged with a kind for dispatch: a fence's kind is its info string; a marker region's kind comes from its shape (e.g. `prose`).

### 3.2 Custom goldmark block parser (B2)

Recognition is implemented as a **custom goldmark block parser**, fed the registered shapes, plus goldmark's **native** fenced-code parsing:

- For each bespoke marker shape (`<!--s:` …), the custom parser triggers on the head, then **consumes raw lines** until the matching tail — exactly as goldmark's fenced-code / HTML blocks consume raw lines. The interior is **opaque**: goldmark does not parse it into paragraphs/headings, and any inner `` ``` `` is *not* split out. The parser emits a custom AST node carrying `{kind, rawInterior, byteSpan}`.
- The custom marker parser must be registered with **higher priority than goldmark's native HTML-comment block parser**, or goldmark will consume `<!--s:pr-1-->` as a standalone HTML comment block (the current bug). The `s:` / `/s:` sentinel distinguishes our markers from user HTML comments.
- `` ``` `` fences are parsed by goldmark **natively** (mature fence-length / indentation handling — we keep that for free; this is the reason B2 was chosen over a hand-rolled scanner).

The codec parses once, then **walks the top-level AST children** to produce an ordered region list:

- a custom marker node → a region tagged with its shape kind, `Raw` = the whole span, interior verbatim;
- a `*ast.FencedCodeBlock` node → a region tagged with its info string, `Raw` = the whole fence;
- any other node (paragraph, heading, list, table, …) → contributes to a **gap text region** via byte offsets (gapless tiling, as today).

### 3.3 Dispatch — unchanged, and now simple

`Deserialize` becomes: **for each region, the first registered processor whose `Accepts` returns true owns it.** No exclusion, no coalescing.

- ` ```code ` → `CodeProcessor` (`Accepts` keys on kind).
- ` ```mermaid ` (no processor) → falls through to prose.
- `<!--s:…-->` region → `ProseProcessor`.
- gap text region → prose.

`ProseProcessor.Accepts` stays `true` and prose is registered **last**, so it is the terminal acceptor for its own marker regions, gap text, and unsupported fences — without ever shadowing a structured recogniser. The terminal role is now a natural consequence of ordering, not a special-cased coalescing loop.

### 3.4 Why prose is no longer shredded

`first-open-wins + opaque interior` (enforced by the custom parser consuming raw lines):

- A prose block containing a fence: the `<!--s:` head opens first, the parser consumes raw to `<!--/s:`, the inner `` ``` `` is never extracted. **One block, id preserved.**
- A `` ``` `` *between* prose blocks: it is a top-level fence node, claimed by its kind's processor.
- A `` ``` `` a user typed *inside* prose content: stays prose content (correct — structured blocks live between prose, not nested in it).

### 3.5 Deleted

- `firstAcceptor` (the prose-exclusion helper)
- `flushProse` and the `pending []Region` coalescing loop in `DocumentCodec.Deserialize`
- the vanilla-goldmark `RegionScanner` internals are replaced by the shape-driven custom-parser walk

### 3.6 Kept

- `BlockProcessor.Accepts` (claiming) and `Deserialize` (parsing): unchanged contracts.
- `Region{Kind, Body, Raw}` portable unit and gapless tiling.
- Per-kind serialization (`Serialize`), incl. `fencedblock.SerializeYaml`.

## 4. Invariants & safety

- **Nested-fence safety (column/indent).** The codec never parses arbitrary markdown — only our own output. `fencedblock.SerializeYaml` emits every payload (however much `` ``` `` it contains) as an **indented YAML scalar** (≥4 spaces). CommonMark closes a fence only on a ≤3-space-indented delimiter, so goldmark's native parser will not close a structured block early on an inner fence. Verified empirically (a block whose `response` contains a ` ```js ` fence round-trips as one block). This is the **same** invariant the current system already relies on for inner-fence safety — no new risk.
- **Opacity.** A marker region's interior is consumed raw and never re-scanned (matches today's `scanProseRegion` "opaque — never re-scanned").
- **First-open-wins.** Guaranteed by goldmark's line-claiming: once the custom parser opens a region it consumes its lines, so no inner delimiter of any kind is matched.
- **Marker precedence.** The custom marker parser must outrank goldmark's HTML-comment block parser.

## 5. Coupling boundary

Goldmark stays **buried inside the markdown `DocumentCodec`** (parser + AST walk). Nothing outside the codec imports goldmark; the rest of the system sees only `[]SieveBlock`. A future non-markdown store (JSON/binary) is a *different* `DocumentCodec` implementation that does not use goldmark or shapes at all. The coupling is contained and was never exposed — which is why B2's goldmark use is acceptable.

Opportunistic consolidation (confirm during planning): today there are **two** goldmark parsers — the scanner's vanilla one and `markdown_parser.go`'s `sieveExtension` one (`sieveBlockASTTransformer`, used off the codec path by `FindBlockByID`/`ParseAllBlocks`). B2 may let these converge onto one custom-node parser and retire the legacy transformer (which Stage E wants gone regardless). Treat as a follow-up, not a requirement of this change.

## 6. Future: containers for free

Because B2 yields a real AST, a future container shape can declare a **non-opaque interior** the walk recurses into, producing `Children` — enabling Stage E nesting without re-architecting segmentation. **Not built now** (SieveBlock stays a leaf; containers are descoped). The design simply does not preclude it.

## 7. Testing strategy

White-box codec tests live in `sieve/block/processors/` (the real `ProseProcessor` is needed; package `block` cannot register it). Cover:

1. **Prose block containing a fence** round-trips as ONE block with id preserved (the regression this fixes).
2. **Unsupported fence** (` ```mermaid `, no processor) between prose → becomes prose content; structured fences between prose → claimed by kind.
3. **Marker precedence** — `<!--s:…-->` is consumed as one opaque region, not split by goldmark's HTML-comment parser.
4. **Mixed document** round-trip byte-stability (prose + structured + unsupported fence).
5. **Markdown-mode / undelimited** input: a hand-typed ` ```code ` with valid YAML is recognised + claimed; bare prose runs mint ids.
6. Existing codec/round-trip tests continue to pass through the production codec.

## 8. Risks & edge cases

- **Custom goldmark block parser is fiddly** (Trigger/Open/Continue/Close, priority vs HTML-comment block). Mitigated by the retired `[!block]` parser as precedent and tight tests.
- **Hand-typed malformed nesting in breakglass markdown mode** (e.g. an inner fence indented ≤3 spaces) could mis-segment — but that input is transient (frontend re-mints per-node markers on next sync) and is no worse than goldmark's own behaviour.
- **Literal marker text in prose** (a user typing `<!--/s:-->` verbatim) — same pathological exposure as today's `scanProseRegion`; not a regression.

## 9. Out of scope

- Container/`Children` recursion (Stage E, descoped).
- Retiring `markdown_parser.go`'s legacy transformer (follow-up; may fall out of consolidation).
- The frontend serializer (unchanged; this is backend SerDes only).
