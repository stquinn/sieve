# Persistence Architecture

A design concept for the Stash persistence layer. This is not an implementation plan — it captures the abstractions and their relationships as a reference point before implementation begins.

---

## Core Principle

**One place touches storage. Everything else uses the results.**

Nothing in the business layer, UI, or editor constructs paths, reads files, or writes to disk directly. The Store is the single boundary. This holds whether the backend is a filesystem, a database, or an HTTP API.

---

## Scope

Every piece of data that Stash persists belongs to exactly one scope.

```
Global     → shared across all hosts  (notes/, assets/)
HostLocal  → specific to this machine ({hostname}/buffers/, settings, session)
```

Scope is a first-class concept throughout the system. It determines where data lives and how external references are formed. A buffer promoted to a note changes scope — that transition is owned entirely by the Store.

---

## Storable

The base contract for anything the Store can persist. A pure value object — no logic, no path awareness, no knowledge of how or where it is stored.

```go
type Storable interface {
    Key()         string  // logical identity within its scope
    Scope()       Scope   // Global or HostLocal
    Body()        []byte  // raw content — opaque to the Store
    ExternalRef() string  // backend-injected reference — path, URL, or identifier
}
```

**Rules:**
- Every Storable is created by the Store, not by the caller
- `ExternalRef()` is injected at creation time by the Store — the Storable carries it but did not compute it
- The caller never constructs or interprets `ExternalRef()` — it is used as an opaque string
- A Storable has no methods beyond these four

---

## MetaBasedStorable

A specialisation of Storable for content that carries structured metadata. Notes, buffers, and settings are all MetaBasedStorables. Binary assets are plain Storables.

```go
type MetaBasedStorable interface {
    Storable
    Meta() Meta
}
```

### Meta

The base metadata contract. Underneath it is a flat map of string to string — the simplest possible wire format between the meta object and the Store.

```go
type Meta interface {
    Get(key string) string
    Set(key string, value string)
    All() map[string]string
}
```

Typed accessors are built on top of the base interface, per content type:

```go
type NoteMeta interface {
    Meta
    Status() string
    Version() int
    FocusCount() int
    UserIntent() *string
    AiEval() string
    Tags() []string
    Summary() string
    Filename() string
    // etc.
}
```

Business logic and the UI use typed accessors exclusively. String key access is an implementation detail of the Store.

**How Meta is stored is entirely backend-specific:**
- `FileStore` — YAML frontmatter, stripped from body before storage, re-prepended on read
- `SQLiteStore` — separate metadata column or table, no parsing cost at query time
- `HTTPStore` — JSON sidecar or API fields

No code outside the Store ever parses frontmatter or constructs YAML.

---

## Store

The single persistence boundary. Factory, serialiser, and lifecycle manager for all Storables.

```go
type Store interface {
    Create(scope Scope, kind Kind, body []byte) (Storable, error)
    Save(s Storable) error
    Load(scope Scope, key string) (Storable, error)
    Delete(scope Scope, key string) error
    List(scope Scope, prefix string) ([]Storable, error)
    Promote(s Storable, targetScope Scope) (Storable, error)
}
```

**The Store is responsible for:**
- Generating keys and assigning them at creation
- Computing and injecting `ExternalRef()` into every Storable it creates or loads
- Marshaling and unmarshaling content — including meta serialisation
- Resolving ownership — which Storables belong to which (derived from content)
- Scope promotion — cascading owned items, re-forming external refs, updating content
- All filesystem or database operations

**The Store is not responsible for:**
- Domain decisions (whether to keep or discard a buffer)
- Business rules (which folder a note belongs in)
- Editor state

---

## ExternalRef

The string that leaves the Store boundary and is used by everything above it — the editor, the UI, the markdown on disk, AI CLIs, and external markdown editors.

```
FileStore  →  ../../buffers/assets/blk-a3f9.png
             ../../assets/note-name-blk-a3f9.png
HTTPStore  →  https://xyz.com/assets/blk-a3f9.png
```

The UI and business layer treat this as an opaque string. They pass it where a path or URL is needed, without knowing which form it takes.

This means:
- The UI never constructs paths
- Markdown on disk always contains real, externally-resolvable references — other editors and AI CLIs can open files and follow image links without any Stash-specific tooling
- Switching backends changes what `ExternalRef()` returns, nothing else

---

## Promotion

When a buffer is promoted to a note its scope changes from `HostLocal` to `Global`. The Store owns this entirely.

On `Promote`:
1. Store resolves owned items (e.g. image assets referenced by the buffer)
2. Each owned item is re-created at the new scope with a new key and new `ExternalRef()`
3. Content is re-marshaled with updated external refs injected
4. Originals are deleted
5. A new Storable is returned — same content, new scope, new refs

The caller receives a fully formed Storable with correct `ExternalRef()`. No path surgery in the business layer.

---

## Content Handler (separate concern)

Content classification and transformation — paste detection, language identification, content-type tagging — is a separate layer above the Store. Handlers are prioritised, first-match wins, and logic is delegated to Go for testability.

This is distinct from persistence and is not part of this document.

---

## What This Enables

**Today:** `FileStore` backed by the local store folder structure. External refs are relative filesystem paths. Markdown files are readable by any editor or AI CLI.

**Later:** `SQLiteStore` or `HTTPStore` can be introduced by implementing the `Store` interface. No business logic changes. The `ExternalRef()` values change form — the callers do not.

**The invariant:** everything above the Store boundary is backend-agnostic.
