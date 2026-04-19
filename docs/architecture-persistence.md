# Persistence Architecture

A design concept for the Stash persistence layer. This is not an implementation plan — it captures the abstractions and their relationships as a reference point before implementation begins.

---

## Core Principle

**One place touches storage. Everything else uses the results.**

Nothing in the business layer, UI, or editor constructs paths, reads files, or writes to disk directly. The Store is the single boundary. This holds whether the backend is a filesystem, a database, or an HTTP API.

**TypeScript is UI only.** All business logic lives in Go. TypeScript renders what the model says and calls Go when something happens. It never makes decisions, constructs paths, parses formats, or owns state beyond what is needed to drive the UI.

---

## Scope

Every piece of data that Stash persists belongs to exactly one scope.

```
Committed    → in the Library — canonical, permanent, shared
Uncommitted  → working copy — in progress, not yet committed
```

The naming is deliberate. Promotion is a commit. The Library is the committed store. Buffers are the working copy. The git analogy is not accidental — a git-backed Store implementation is a natural consequence of this abstraction.

Scope is an internal Store concept. Nothing above the Store needs to reason about it directly. The domain type already encodes scope implicitly — a Buffer is always Uncommitted, a Note is always Committed. The business layer speaks in domain terms; the Store translates to scope internally.

---

## Storable

The base contract for anything the Store can persist. A pure value object — no logic, no path awareness, no knowledge of how or where it is stored.

```go
type Storable interface {
    Key()         string       // logical identity within its scope
    Scope()       Scope        // Committed or Uncommitted
    Body()        []byte       // raw content — opaque to the Store
    ExternalRef() string       // backend-injected reference — path, URL, or identifier
    Versions()    []VersionRef // lightweight history refs — no content
}
```

**Rules:**
- Every Storable is created by the Store, not by the caller
- `ExternalRef()` is injected at creation time by the Store — the Storable carries it but did not compute it
- The caller never constructs or interprets `ExternalRef()` — it is used as an opaque string
- `Versions()` returns lightweight refs only — dates, sizes, identifiers — not content
- A Storable has no methods beyond these five

---

## MetaBasedStorable

A specialisation of Storable for content that carries structured metadata. Notes and buffers are MetaBasedStorables. Binary assets are plain Storables.

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
    Set(key string, value string)  // marks dirty internally
    IsDirty() bool
    All() map[string]string
}
```

Typed accessors are built on top of the base interface, per content type:

```go
type NoteMeta interface {
    Meta
    Status() string
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

`Set()` marks the Meta as dirty. On `Save()`, the Store checks `IsDirty()` and re-serializes meta if needed. The UI never constructs YAML, never mangles strings, never knows frontmatter exists.

**How Meta is stored is entirely backend-specific:**
- `FileStore` — YAML frontmatter, stripped from body on load, re-prepended on save
- `SQLiteStore` — separate metadata column or table, no parsing cost at query time
- `HTTPStore` — JSON sidecar or API fields
- `GitStore` — YAML frontmatter in committed files, same as FileStore

No code outside the Store ever parses frontmatter or constructs YAML.

**Note:** the `version` field previously tracked in frontmatter is removed. Versioning is a by-product of saving — owned by the Store, expressed through `Versions()` on the Storable, not stored as a meta field.

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
    Commit(s Storable) (Storable, error)
    RetrieveVersion(s Storable, ref VersionRef) (VersionedStorable, error)
}
```

`Promote` is renamed `Commit` — the naming aligns with the Committed/Uncommitted scope model and the git mental model.

**The Store is responsible for:**
- Generating keys and assigning them at creation
- Computing and injecting `ExternalRef()` into every Storable it creates or loads
- Marshaling and unmarshaling content — including meta serialisation
- Resolving ownership — which Storables belong to which (derived from content)
- Scope transition on commit — cascading owned items, re-forming external refs, updating content
- Versioning — creating a version record on every `Save()`, maintaining history
- All filesystem, database, or VCS operations

**The Store is not responsible for:**
- Domain decisions (whether to keep or discard a buffer)
- Business rules (which folder a note belongs in)
- Editor state

---

## Versioning

Versioning is a by-product of saving. Every `Save()` call produces a version. The Store owns this entirely — no business layer involvement, no UI action required.

```go
type VersionRef struct {
    ID      string
    Created time.Time
    Size    int64
}
```

`Storable.Versions()` returns a list of lightweight refs — enough to display a history list. Content is not included.

To retrieve a specific version:

```go
type VersionedStorable struct {
    Ref VersionRef
    Storable          // deserialized snapshot — not the live object
}
```

`RetrieveVersion` returns a `VersionedStorable`, not a `Storable`. The type distinction is intentional — a versioned snapshot cannot be accidentally saved back as the current document. The caller can read from it, diff against it, or offer a restore — but the type signals clearly that it is historical.

**Backend implementations:**
- `FileStore` — numbered snapshot files, same format as live files (frontmatter + body)
- `GitStore` — `git log` for history, `git show <hash>:path` for retrieval — free
- `SQLiteStore` — versions table with content column

The FileStore deserializer reads a versioned snapshot identically to a live file. The format is the same.

---

## ExternalRef

The string that leaves the Store boundary and is used by everything above it — the editor, the UI, the markdown on disk, AI CLIs, and external markdown editors.

```
FileStore  →  ../../buffers/assets/blk-a3f9.png
             ../../assets/note-name-blk-a3f9.png
HTTPStore  →  https://xyz.com/assets/blk-a3f9.png
GitStore   →  relative path within repo
```

The UI and business layer treat this as an opaque string. They pass it where a path or URL is needed, without knowing which form it takes.

This means:
- The UI never constructs paths
- Markdown on disk always contains real, externally-resolvable references — other editors and AI CLIs can open files and follow image links without any Stash-specific tooling
- Switching backends changes what `ExternalRef()` returns, nothing else

---

## Commit (formerly Promote)

When a buffer is committed its scope changes from `Uncommitted` to `Committed`. The Store owns this entirely.

On `Commit`:
1. Store resolves owned items (e.g. image assets referenced by the buffer)
2. Each owned item is re-created at the new scope with a new key and new `ExternalRef()`
3. Content is re-marshaled with updated external refs injected
4. Originals are deleted
5. A new Storable is returned — same content, Committed scope, correct refs

The caller receives a fully formed Storable with correct `ExternalRef()`. No path surgery in the business layer.

---

## Frontend Simplification

The Store boundary eliminates a class of accidental complexity that currently exists in the TypeScript layer.

**Before:** `splitFrontmatter` in App.tsx strips YAML frontmatter from raw markdown before passing content to Tiptap. The two things arrive mixed and must be pulled apart in the frontend.

**After:** The Store separates them on load. The frontend receives:
- `storable.Body()` — pure markdown, no frontmatter, straight into Tiptap
- `storable.Meta()` — typed meta object, straight into the Meta panel

The frontend never sees frontmatter. The raw markdown view shows clean body content only. The Meta panel binds to typed accessors. Nothing is mixed.

Meta changes go through the API:
```typescript
meta.setUserIntent("keep")  // marks dirty, Store re-serializes on next Save
```

The UI never constructs YAML, never parses strings, never touches frontmatter.

---

## Scope Visibility

Scope does not leak above the Store boundary in any meaningful way.

The domain type encodes scope implicitly — you do not need to ask a Note what scope it is in. The business layer calls `store.List(Committed, ...)` or `store.Create(Uncommitted, ...)` internally, but those calls happen inside domain services, not in the UI.

The UI is entirely scope-agnostic. It works with Storables and their typed APIs. Scope is an internal routing mechanism for the Store.

---

## Content Handler (separate concern)

Content classification and transformation — paste detection, language identification, content-type tagging — is a separate layer above the Store. Handlers are prioritised, first-match wins, and logic is delegated to Go for testability.

This is distinct from persistence and is not part of this document.

---

## What This Enables

**Today:** `FileStore` backed by the local store folder structure. External refs are relative filesystem paths. Markdown files are readable by any editor or AI CLI.

**Later:** `SQLiteStore`, `HTTPStore`, or `GitStore` can be introduced by implementing the `Store` interface. No business logic changes. No TypeScript changes. The `ExternalRef()` values change form — the callers do not.

**GitStore** is a natural implementation. Uncommitted = working tree. Committed = git history. `Save()` stages. `Commit()` commits. `Versions()` is `git log`. `RetrieveVersion()` is `git show`. The abstraction maps cleanly onto git primitives with no forcing.

**The invariant:** everything above the Store boundary is backend-agnostic. TypeScript is UI only.
