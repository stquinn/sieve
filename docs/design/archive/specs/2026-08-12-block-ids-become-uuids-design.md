> **STATUS: DONE** — shipped 2026-08-12 (#75 closed). All block ids are UUIDv7;
> the coordinate grammar (`domain.Address`) is built and tested but deliberately
> unadopted — #74 is its first consumer. Archived 2026-08-12.
>
> **Two decisions changed during implementation** and the body below reflects the
> final design, not the issue text: migration creates **no aliases** (in-document
> `ref` rewriting is provably exhaustive, so the safety net was unnecessary), and
> the migrator sits on the **load path** rather than inside `Deserialize`, flushed
> synchronously at open. The title's "permanent aliases" is the superseded
> framing, kept so the issue and this file still match by name.

# Block ids become UUIDs — short handles demoted to permanent aliases

**Status:** Implemented
**Tracked:** #75 (closed)
**Date:** 2026-08-12

## Problem

`GenerateBlockID` mints 2 random bytes behind a 2–3 char kind prefix — 65,536
values per prefix — and nothing checks for collisions. `NewSieveBlock` mints and
never verifies against the blocks already in the document.

Prose is node-granular, so every paragraph is a block and they all draw from the
single `pr-` space. By the birthday bound (N = 65536), a 300-paragraph note has a
**49.6%** chance of carrying a duplicate block id; 500 paragraphs is 85.1%.
Duplicate ids are known to break this system — the `splitBlock` attr-copy dup-id
trap is the same failure arriving from another direction.

The second problem is why this is urgent rather than merely wrong: block ids are
unique only *within* a document, so nothing outside a document can reference a
block. Every cross-document feature in flight (#74, #38, #37) needs that.

Today a block id appears only inside its own document, so migration is
per-document, self-contained, idempotent and verifiable by round-trip. The moment
the first block-granular cross-document reference is stored, that stops being
true and a later migration becomes *unsound* — referrers in unattached libraries
cannot be enumerated.

## Decision

**All ids are UUIDs — documents and blocks alike**, minted as UUIDv7 so they sort
chronologically. Existing document uuids are untouched: they are already UUIDs and
already globally unique, and nothing validates the version nibble.

Block ids migrate to UUID. Migration mints a new id per block and **rewrites
in-document refs**; it creates **no aliases**.

The issue proposed retaining each old short handle as a permanent alias, as a
safety net for referrers we cannot see. That net turns out to be unnecessary,
because no such referrer can exist. A block id is persisted in exactly one place
today — its own document:

- `sieve/domain/` (Document, Session, Tab, meta) carries no block-id field.
- `StateService`, `JobTracker` and `JobEngine` carry none.
- `BlockID` appears in five non-test files, all in-memory or on the WS wire
  (`command.Context.BlockID` is the ephemeral frontend selection context).
- `content_link.go` extracts `https?://` links only, so a block id never lands
  inside prose content.

`Attrs["ref"]` is therefore the **complete** referrer set, and rewriting it
in-document is exhaustive and verifiable by round-trip. This is the issue's own
sequencing argument turned around: precisely *because* no cross-document block
reference exists yet, the migration needs no safety net. It is also why the work
cannot be deferred — the first stored cross-document reference makes this
paragraph false.

Dropping migration aliases keeps one uniform rule for every kind, rather than
"prose upgrades, structured aliases", and removes the design's messiest corner:
resolving a legacy duplicate short handle across two blocks that would both claim
it as an alias.

### Identity versus naming

| | Role | Scope | Shape |
|---|---|---|---|
| **id** | identity | global | UUID, opaque, never displayed |
| **alias** | name | document | short, human, may carry domain meaning |

An alias may be domain-meaningful — a file block aliased to its upload path, a
web-clip to its source URL. Global identity, local naming.

**Hard rule:** an alias may never appear in a cross-document coordinate. The
grammar in §4 enforces this structurally — there is no bare `block:{alias}` form,
so the rule cannot be expressed wrongly.

### Aliases are durable by intent

An alias is only ever *given* to a block by a deliberate mechanism — a future UI
affordance, a domain-meaningful name. Nothing accumulates aliases automatically:
the prose-merge path that once did was cut on 2026-06-19 (`prose-markers.js:9`),
and migration creates none. There is therefore no unbounded growth to collect
against, and `gcAliases` (unwired dead code, called only from tests) is deleted.

After this change **nothing writes an alias at all**. The mechanism is kept, and
its persistence bug fixed (§3), because the identity-versus-naming split above is
the durable design and the alias UI is its first consumer.

**No auto-mint.** New blocks get a UUID and nothing else. A short handle
alongside it would give two spellings for one thing and recreate a collision
surface; per brainstorm 5 §7 the fence payload is *interpreted*, not read.

## Architecture

### 1. `ident` — one id package, one validator

`store/` does not import `sieve/`, so an id type in `sieve/domain/` is unreachable
from `filestore`. A new top-level package sits below both:

```go
package ident

func New() string        // uuid.NewV7 — time-ordered
func Valid(s string) bool
```

`github.com/google/uuid` is promoted from indirect to direct. Both
`filestore.newUUID` (its hand-rolled v4) and `block.GenerateBlockID` become calls
to `ident.New`; `filestore.looksLikeUUID` collapses into `ident.Valid`.

Named `ident`, not `id`, because `id` shadows the commonest local variable in the
codebase.

`GenerateBlockIDFor`, the `hasPrefix` interface, and `IDPrefix()` on all seven
processors become dead and are deleted — with no auto-mint, nothing needs a kind
prefix. **No production code infers a block's kind from its id prefix** (verified);
only two tests assert `HasPrefix(id, "pr-")`, and they are rewritten.

### 2. Migration — an explicit migrator on the load path

Migration is **not** embedded in `DocumentCodec.Deserialize`. `Deserialize` is a
pure parse, and making it mint identity as a side effect of reading would mean
read-only parses (`findBlockByID`'s markdown fallback, AI context building,
snapshot re-parse) mint ids that nothing persists and nothing can look up — with
no alias fallback, an old handle stops resolving the moment a block is renamed.

Instead a `BlockIdentityMigrator` owns the transform, called where a document is
loaded into a `ShadowDocument` (`NewShadow`) and by `/migrate-ids`. Minting
happens only where a save can follow.

```go
func (m BlockIdentityMigrator) Migrate(blocks []SieveBlock) ([]SieveBlock, bool)
```

Pass 1 assigns every block a unique id, recording old→new:

- ID is not a valid UUID → mint one, record `rename[old] = new` **first-wins**, so
  a legacy duplicate short handle binds to the first block in document order.
- ID is a valid UUID already seen in this document → mint a replacement and log a
  warning, recording **no** rename entry: refs naming that UUID belong to the
  first, legitimate holder. This is the uniqueness guard, and it **repairs and
  logs** rather than refusing to load — post-migration a duplicate can only mean
  corruption or a hand-edit, and a thinking tool must not refuse to open a note
  over one.

Pass 2 rewrites `Attrs["ref"]` through the rename map. Tokens absent from the map
are left alone.

Re-identifying a block must honour the **two-sided id invariant** that
`NewSieveBlock` enforces: the id lives on both the `ID` field and `Attrs["id"]`,
because the WYSIWYG wire and the fenced serializer both read it out of `Attrs`.
Writing only one side reintroduces the id-less-block bug.

`Migrate` returns `changed`. When true, `EditorService.open` flushes the document
**synchronously** — not merely arming the autosave debounce, which implementation
showed to be insufficient. `applyJobUpdate` transiently reopens a *closed*
document to apply a finished job's result, and the job carries the block id it
was dispatched with; if the upgrade were still sitting in memory behind a 30s
timer, that reopen would re-mint different ids and the result would be applied to
a block that no longer exists. `ShadowDocument.MigratedOnLoad` carries the signal;
`NewShadow` still arms the debounce as a fallback for callers that construct a
shadow directly. FileStore versioning is the rollback.

Documents never opened keep their short ids — still valid, just not externally
addressable — until `/migrate-ids` (§5) sweeps them.

### 3. Fenced blocks must persist aliases

`FencedSerializer.Serialize` writes only `block.Attrs`; `Aliases` is a sibling
struct field and is silently dropped on every save. Only prose survives today, via
its `<!--s:ID a1 a2-->` marker. Migration is unsound without this.

The serializer injects an `aliases:` key into the YAML from the struct field; the
deserializer lifts it back into `SieveBlock.Aliases` and removes it from `Attrs`,
so no stale second copy can diverge from `Merge`.

Aliases are deliberately *not* mirrored into `Attrs` the way `id` is. The `id`
mirror is safe because `Merge` never changes `ID`; `Merge` **does** replace
`Aliases`, so a mirrored copy would silently go stale.

No writer exists for aliases after this change (§Decision), so this fixes no live
data loss. It is in scope because it is ten lines, and because a silent
drop-on-save would otherwise ambush whoever builds the alias UI.

### 4. The coordinate grammar — `domain.Address`

```
container:{uuid}[@v{n}]
block:{uuid}
block:{container-uuid}[@v{n}]/{handle}
```

`handle` is a UUID or an alias, discriminated by `ident.Valid`.

```go
type Address struct { Scheme, Container, Block string; Version int }

func ParseAddress(s string) (Address, error)
func (a Address) String() string
func (a Address) IsPinned() bool
func (a Address) Equal(b Address) bool
```

Lives in `sieve/domain/`, imports `ident`. Implemented and tested here; **adopted
nowhere this round** — #74 is its first consumer.

**The scheme names shape, not service.** `container:` and `block:` are brainstorm
6 §7's own words. Naming the service instead — `document:` / `chat:` / `thing:` —
would encode *location*, and location is mutable: a block born in a document and
later published as a Thing would change address, and every citation would die.
Container *kinds* live in `.meta`, exactly as Note and Buffer do today.

**Versions belong to storables, not blocks.** A block has no version of its own;
its container does. So `block:{uuid}@v{n}` is meaningless and the pin attaches to
the container segment. This is why the container-qualified form is not a redundant
locator hint: it is the only form that can express a frozen block reference.

**Equality is post-resolution.** Two addresses are equal iff they resolve to the
same UUID *and* the same pin state — so `block:{uuid}` and `block:{c}@v7/{uuid}`
are deliberately not equal (live versus frozen). `Equal` returns false if either
operand still carries an alias.

Schemes are **not namespaced** (`block:`, not `sieve+block:`). The same field will
eventually hold `https:` and `file:` (#38), but the parser discriminates by scheme
and there is no collision. Namespace it later, only if addresses actually leave
the app.

#### Deviation from #75 as written

The issue lists four productions, separating `block:{c}/{alias}` from
`block:{c}@v{n}/{uuid}`. Three productions cover all four cases: the pin becomes
orthogonal to how the block is named, rather than coupled to it. This also
legalises `block:{c}/{uuid}` — unpinned, container-qualified, by UUID — which is a
useful locator hint for #37. The hard rule still holds structurally: there is no
bare `block:{alias}`, so an alias can never leave its container.

### 5. `/migrate-ids` — the explicit sweep

Migration is lazy: a document migrates when it is opened. A document never opened
keeps its short ids — still valid, but not externally addressable. `/migrate-ids`
closes that gap, walking every document, migrating, and saving only what changed
(so a clean library produces no version churn). It returns a `command-result`
block with counts — scanned, migrated, blocks re-identified — and *lists* any
document it had to skip, since a silently dropped document reads as "covered
everything" when it was not.

Chosen over a menu item because it needs no Wails menu surgery (post-startup menu
rebuilds are a known Linux crash source here) and it fits the workspace command
plane direction.

**Placement is forced by the import graph.** `command/` cannot import `block/` —
`block → ai → command` is an existing edge — and neither can `services/`, because
that same chain continues `command → services`. So the sweep itself lives in
`editor.IdentitySweeper`, the only package that sees both the codec and the
document service, behind a `command.IdentitySweeper` port whose result type
(`domain.IdentitySweepResult`) sits in the leaf both sides already share.

**The sweep covers buffers, not just filed notes.** `DocumentService.List` returns
only `LibraryCategory`, which is right for the sidebar and wrong here: Sieve is
scratchpad-first, so most documents at any moment are unfiled `WorkingCopy`
buffers. A sweep built on `List` would have left the majority of blocks
unaddressable. `DocumentService.AllUUIDs` was added for this, sweeping both
categories — the same pair `AssetService` and the store migration already use.

### 6. `handle_gc.go`

`gcAliases` is deleted with its tests. `collectHandles` is kept — it becomes the
uniqueness guard's index. `gcRefs` is kept: dangling-ref stripping is about refs,
not identity. The file header is rewritten to record that aliases are durable by
intent.

## Non-goals

- **Document uuids are not migrated.** They are already globally unique; v4 and v7
  are the same 128 bits in the same canonical form.
- **`/uuid` keeps minting v4.** It is a user utility for generating a random UUID
  to paste elsewhere, and v7 leaks a timestamp.
- **No adoption of the grammar.** #74 is its first consumer and owns that work.
- **No cross-document resolution.** #37's index is what makes global
  `block:{uuid}` resolution cheap; this issue only makes the addresses exist.

## Testing

- `ident`: mints valid v7, monotonic across calls, `Valid` accepts v4 and v7 and
  rejects malformed input.
- Migration: a fixture with short ids upgrades to UUIDs; a **second** pass is a
  no-op and reports `changed == false` (idempotence); refs are rewritten to the
  new ids; a fixture with duplicate short ids binds refs first-wins; `Attrs["id"]`
  tracks the `ID` field on every re-identified block.
- Guard: a duplicate UUID is re-minted, the document still loads, and refs naming
  it still resolve to the first holder.
- `Deserialize` stays pure: parsing a document with short ids leaves them
  untouched.
- Fenced alias round-trip: serialize → deserialize preserves `Aliases` and leaves
  `Attrs` free of an `aliases` key.
- Prose alias round-trip: existing marker tests continue to pass.
- `domain.Address`: table-driven parse/format round-trip over all three
  productions, malformed-input rejection, `Equal` semantics including the
  alias-returns-false rule.
