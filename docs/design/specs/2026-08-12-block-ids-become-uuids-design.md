# Block ids become UUIDs — short handles demoted to permanent aliases

**Status:** Draft
**Tracked:** #75
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

Block ids migrate to UUID with the existing short handle retained as a
**permanent alias**. `SieveBlock.Aliases` already exists, and `answersTo()`
already resolves a ref against the primary ID *or* any alias. Keeping the old
handle forever means no reference is ever rewritten to stay working — including
references we cannot see, in libraries that are not attached at migration time.

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

An alias is only ever *given* to a block by a deliberate mechanism: this
migration, a future UI affordance, a domain-meaningful name. Nothing accumulates
aliases automatically — the prose-merge path that once did was cut on 2026-06-19
(`prose-markers.js:9`). There is therefore no unbounded growth to collect against,
and `gcAliases` (which is unwired dead code, called only from tests) is deleted.

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

### 2. Migration — on the codec, invisible to callers

`DocumentCodec.Deserialize` gains a post-pass, so every parse path migrates
identically and idempotently:

1. A block whose ID is not a valid UUID gets one minted; the old id is appended
   to `Aliases`.
2. In-document `Attrs["ref"]` tokens are rewritten through the old→new map.
   Tokens that do not resolve in-document are left alone — they may target
   another library.
3. A uniqueness guard over primary IDs, indexed by `collectHandles`, **repairs and
   logs**: a duplicate is re-minted with a warning. Post-migration a duplicate can
   only mean corruption or a hand-edit, and a thinking tool must not refuse to open
   a note over one.
4. Duplicate *aliases* across blocks — the legacy short-id collision this issue
   exists to fix — resolve first-wins in document order. The later block drops the
   ambiguous handle and logs.

`findBlockByID` changes from `b.ID == id` to matching `b.answersTo()`. This is
required, not incidental: without it, a lookup by old handle fails the moment
migration renames the block.

Documents persist on their next normal save. FileStore versioning is the rollback.

### 3. Fenced blocks must persist aliases

`FencedSerializer.Serialize` writes only `block.Attrs`; `Aliases` is a sibling
struct field and is silently dropped on every save. Only prose survives today, via
its `<!--s:ID a1 a2-->` marker. Migration is unsound without this.

The serializer injects an `aliases:` key into the YAML from the struct field; the
deserializer lifts it back into `SieveBlock.Aliases` and removes it from `Attrs`,
so no stale second copy can diverge from `Merge`.

(`id` currently lives in both `Attrs` and the struct field. That divergence
predates this issue and is out of scope.)

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

Migration is lazy: a document migrates when it is parsed. A document never opened
keeps its short ids — still valid, but not externally addressable. `/migrate-ids`
closes that gap: a `FamilyUtil` command alongside `/uuid`, walking every document
in the attached library, parsing (which migrates) and saving what changed. It
returns a `command-result` block with counts — documents scanned, documents
migrated, blocks re-identified, collisions repaired.

Chosen over a menu item because it needs no Wails menu surgery (post-startup menu
rebuilds are a known Linux crash source here) and it fits the workspace command
plane direction.

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
- Migration: fixture document with short ids round-trips to UUIDs with old handles
  preserved as aliases; a **second** pass is a no-op (idempotence); refs are
  rewritten; a fixture with duplicate short ids repairs first-wins.
- Guard: duplicate primary ids are re-minted, and the document still loads.
- Fenced alias round-trip: serialize → deserialize preserves `Aliases` and leaves
  `Attrs` free of an `aliases` key.
- Prose alias round-trip: existing marker tests continue to pass.
- `domain.Address`: table-driven parse/format round-trip over all three
  productions, malformed-input rejection, `Equal` semantics including the
  alias-returns-false rule.
