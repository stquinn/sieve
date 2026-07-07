> **STATUS: DONE** — shipped; DocumentCodec/RegionScanner live in sieve/block/. Archived 2026-07-07.

# Deserialization is a BlockProcessor concern — the DocumentCodec service

**Status:** Design approved 2026-06-19 (branch `feature/refactor_editor_layout`).
**Predecessor:** the serialization half is built (`BlockProcessor.Serialize`; the save
spine walks blocks and asks each flavour — memory `project_serialization_is_a_processor_concern`).
**Brainstorm:** `docs/brainstorm-deserialization-is-a-processor-concern.md` (the principle).
This spec pins the *implementation* shape agreed in brainstorming, including two
decisions the brainstorm did not cover: a **`DocumentCodec` business service** owning
both directions, and a **`RegionScanner`** unit isolating goldmark.

## Goal

Make deserialization the mirror of serialization: a flavour owns BOTH sides of its
SerDes. Replace the parser's hardcoded `sieveBlockNode` knowledge + prose-marker
scanning with registry dispatch — each processor recognises and builds its own kind.
No kind-switch in the spine; prose is the terminal mop-up.

## Scope

**In:** deserialization via `Accepts`/`Deserialize` on `BlockProcessor`; the
`DocumentCodec` service owning `Serialize` + `Deserialize`; a `RegionScanner`;
`EditorService` wired to the codec; retirement of the dead handle-less parse/serialize
convenience funcs; rename of the mis-named `handle_anchor.go`.

**Out (explicitly deferred):**
- **Paste convergence.** `IsBlock`/`Transform` stay untouched. `Accepts`/`Deserialize`
  are designed so paste can fold in later, but that is a separate pass.
- **Stage E / container model.** `PromoteBlock`, `FindBlockByID`, `ParseAllBlocks`,
  `BlockAnchorProvider`'s markdown parse, the inline `[!kind]` parser — all need the
  container/Node model and/or are inline-not-block. Not touched here.
- **De-globalizing the registry.** Registration stays package-global (`init()` prose,
  `service_provider.go` wiring, `resetRegistry`). The codec depends on a narrow
  registry *interface* satisfied by an adapter over the global — injectable for tests
  without ripping out registration plumbing.

## The units

Five units, each one job:

| Unit | Responsibility | Depends on | File |
|------|---------------|------------|------|
| `SieveBlock` (model) | The block value + accessors. No I/O. | — | `sieve_block.go` (extracted from `block_document.go`) |
| `RegionScanner` | Split raw markdown → ordered `[]Region`. Kind-blind. Owns goldmark. | goldmark | `region_scanner.go` |
| `BlockProcessor` (flavour) | `Accepts(region)` + `Deserialize(region)` — recognise & build its kind. | `Region`, `SieveBlock` | existing processor files |
| `DocumentCodec` (service) | Orchestrate both directions: blocks→`Serialize`; regions→dispatch→`Deserialize`. Kind-blind. | registry, `RegionScanner` | `document_codec.go` |
| `EditorService` | Lifecycle only: `Store.Read`→`codec.Deserialize`→`ShadowDocument`, and the save mirror. | `DocumentCodec` | `editor_service.go` |

**Structural guarantee (carried from the serialize half):** `DocumentCodec` only ever
sees the registry + the `BlockProcessor` interface, so it *cannot* switch on kind.
`RegionScanner` is kind-blind by construction. All kind knowledge lives on processors.

## The interface change (the mirror)

Two exported methods join `BlockProcessor` (matching `Serialize`'s spelling/visibility):

```go
// Accepts reports whether this flavour claims the region. Cheap: structured kinds
// compare region.Kind to their fence tag; prose is NOT asked (it is the terminal
// mop-up — see dispatch).
Accepts(region Region) bool

// Deserialize builds blocks from a claimed region — the inverse of Serialize.
// Returns a slice: a fenced flavour yields one block; ProseProcessor yields N
// (it splits the run at its <!--s:ID--> markers, owning both sides of its SerDes).
Deserialize(region Region) ([]SieveBlock, error)
```

The portable region — **not** a goldmark `ast.Node` (the spec's fork: markdown is one
serialization, not the model):

```go
type Region struct {
    Kind string // fence info string ("code"), or "" for an untagged text run
    Body string // fence interior, or the text run's content
    Raw  string // exact source bytes — lets prose preserve unclaimed fences verbatim
}
```

Shared embeds mirror the serialize side:
- `FencedDeserializer` — inverse of `FencedSerializer`. `Accepts` = "is `region.Kind`
  my kind?"; `Deserialize` = parse the YAML body → one block. Embedded by the 8
  structured flavours. The kind it answers for is supplied by the embedding processor.
- `ProseProcessor` — owns its own marker-aware `Accepts`/`Deserialize`, absorbing
  today's `scanProseRegion`/`findClose`/`markerOpenRe`/`markerCloseRe`. `Accepts` on a
  text region is true (terminal), but prose is excluded from the dispatch `Accepts`
  loop and invoked explicitly as the mop-up.

## The deserialize algorithm

Requirement that shapes it: a plain ` ```python ` fence (no matching processor) must
stay *inside* the surrounding prose as literal content, exactly as today — so unclaimed
regions cannot each become their own block. Mechanic: coalesce unclaimed regions and
hand the run to prose.

```
DocumentCodec.Deserialize(markdown):
  regions := RegionScanner.Scan(markdown)        // ALL fences + text gaps, kind-blind
  out := []SieveBlock{}
  pending := []Region{}                           // run of unclaimed regions

  flushProse():                                   // hand the coalesced run to prose
    if pending non-empty:
       raw := concat(pending[].Raw)
       out += ProseProcessor.Deserialize(Region{Raw: raw})   // splits at markers → N
       pending = nil

  for region in regions:
     p := firstStructuredProcessorThatAccepts(region)   // registry order, prose EXCLUDED
     if p != nil:
        flushProse()                              // close prose run before structured block
        out += p.Deserialize(region)
     else:
        pending += region                         // unclaimed → coalesce into prose
  flushProse()
  return out
```

Ordering rules (straight from the brainstorm):
- **Prose excluded from the `Accepts` loop**, invoked only as terminal mop-up — enforces
  "prose must be lowest priority or it shadows every structured recogniser."
- **Coalescing unclaimed regions** keeps a stray ` ```python ` fence as literal prose
  content (its `Raw` joins the run), preserving today's round-trip.

`firstStructuredProcessorThatAccepts` walks the registry in priority order (registration
order — the same ordering paste-match uses) and returns the first non-prose processor
whose `Accepts` is true.

## DocumentCodec and registry injection

```go
// Narrow read-only seam over the registry — all DocumentCodec needs.
type ProcessorRegistry interface {
    Get(kind string) BlockProcessor
    Ordered() []BlockProcessor   // priority order, for the Accepts loop
}

type DocumentCodec struct {
    registry ProcessorRegistry
    scanner  *RegionScanner
}
func (c *DocumentCodec) Serialize(blocks []SieveBlock) (string, error)
func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error)
```

For this pass a thin adapter satisfies `ProcessorRegistry` over the existing
package-global registry; `ServiceProvider` constructs the one `DocumentCodec`. Tests
construct a `DocumentCodec` with a **fake registry** — no `resetRegistry()` global
gymnastics. Package-global registration stays as-is; de-globalizing it is a clean
separate follow-up.

## Retirements & rename

**Move to rightful owners (not deleted):**
- `scanBlocks`/`scanProseRegion`/`findClose`/marker regexes → `DocumentCodec.Deserialize`
  + `ProseProcessor` + `RegionScanner`.
- `SerializeBlockDocWithHandles` + `serializeBlock` → `DocumentCodec.Serialize`.

**Delete (audit item 3c — test-only-dead "parseAll smell"):**
- `ParseBlockDoc`, `SerializeBlockDoc` (handle-less convenience).
- `mintProseIDs` — likely redundant (`newSieveBlock` mints on construction); delete if
  no live caller survives.

**Rename:** `handle_anchor.go` → `block_serde.go` (or the spine moves wholesale into
`document_codec.go` and the file disappears). The lying "anchor" name goes; real anchors
remain in `block_anchor.go`.

## Testing

Discipline: **round-trip tests use the production codec, never a duplicate parser.**
- `DocumentCodec` round-trip: `Deserialize(Serialize(blocks)) == blocks` and
  `Serialize(Deserialize(md)) == md`, through the real service — successor to
  `TestSerialize_RoundTripsThroughProductionParser`.
- `RegionScanner`: markdown → expected ordered `[]Region`. Pure, no registry.
- Per-processor `Accepts`/`Deserialize` in isolation with a fake registry, including
  **negative** cases (a `code` processor rejects a `diagram` region).
- `ProseProcessor.Deserialize`: marker splitting, aliases, unbalanced opens → literal,
  the coalesced-unclaimed-fence case (a stray ` ```python ` stays as prose content).
- Ordering: prose-is-terminal (a claimed region never falls to prose) and `Accepts`
  priority order.

Built TDD — tests first, per task, commit per task, no Co-Authored-By.

## References

`docs/brainstorm-deserialization-is-a-processor-concern.md`,
`docs/brainstorm-block-document-model.md`, memories
`project_serialization_is_a_processor_concern`, `project_deserialization_processor_concern`,
`project_inline_not_a_block`, `project_shadowdoc_uniform_block_refactor`.
