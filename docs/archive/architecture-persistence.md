# Persistence Architecture

A design concept for the Stash persistence layer. This is not an implementation plan — it captures the abstractions and their relationships as a reference point before implementation begins.

---

## Core Principle

**One place touches storage. Everything else uses the results.**

Nothing in the business layer, UI, or editor constructs paths, reads files, or writes to disk directly. The Store is the single boundary. This holds whether the backend is a filesystem, a database, or an HTTP API.

**TypeScript is UI only.** All business logic lives in Go. TypeScript renders what the model says and calls Go when something happens. It never makes decisions, constructs paths, parses formats, or owns state beyond what is needed to drive the UI.

---

## Category

Every Storable belongs to exactly one Category. Categories are defined by the business layer — not by the Store. The Store executes, the business layer decides what categories exist and what they mean.

```go
type IsolationLevel int
const (
    Shared   IsolationLevel = iota  // cross-context — all hosts, all users
    Isolated                         // context-scoped — this host, this user
)

type Category struct {
    Name        string
    DisplayName string
    Isolation   IsolationLevel
}
```

Stash defines three:

```go
var (
    Library     = Category{Name: "library",      DisplayName: "Library",      Isolation: Shared}
    WorkingCopy = Category{Name: "working-copy",  DisplayName: "Working Copy", Isolation: Isolated}
    State       = Category{Name: "state",         DisplayName: "State",        Isolation: Isolated}
)
```

`IsolationLevel` is meaningful across all backends:
- `FileStore` — Shared → global path, Isolated → host-prefixed path
- `SQLiteStore` — Shared → global rows, Isolated → host/user-scoped rows
- `HTTPStore` — Shared → global endpoint, Isolated → user-scoped endpoint

Category is stamped onto every Storable at creation by the Store. Immutable after that — no setter. To change category, call `store.Move()` which returns a new Storable.

FileStore is configured at construction with a category-to-path mapping:

```go
store := NewFileStore(storePath, hostname, map[Category]string{
    Library:     "notes",
    WorkingCopy: "buffers",
    State:       "",
})
```

Isolation drives whether `{hostname}/` is prepended. The path suffix is FileStore configuration — not part of Category or the Store interface.

---

## Storable

The base contract for anything the Store can persist. A pure value object — no logic, no path awareness, no knowledge of how or where it is stored.

```go
type Storable interface {
    Key()         string       // logical identity within its category
    Category()    Category     // stamped at creation — immutable
    Body()        []byte       // raw content — opaque to the Store
    ExternalRef() string       // derived from ownership graph — never stored
    Versions()    []VersionRef // lightweight history refs — no content
}
```

**Rules:**
- Every Storable is created by the Store — never by the caller
- `Category()` is stamped at creation — immutable, no setter
- `ExternalRef()` is derived by walking the ownership graph at read time — never stored, always computed
- `Versions()` returns lightweight refs only — dates, sizes, identifiers, no content
- Storable is immutable except for two surfaces the editor may touch: Body and Meta

---

## Three Storable Types

Store understands three interfaces. The type determines how Store handles serialisation.

### Storable — base

Used for settings and session state. Opaque body bytes. No meta, no ownership. FileStore stores as-is.

### MetaBasedStorable

Used for notes and buffers. Extends Storable with structured metadata and asset ownership.

```go
type MetaBasedStorable interface {
    Storable
    Meta()  Meta
    Owns()  []AssetStorable
}
```

`Owns()` is the third mutable surface alongside Body and Meta — grows as assets are added during editing. All three are reconciled to Store on `Save()`.

FileStore serialises Meta as YAML frontmatter. No code outside Store ever parses frontmatter or constructs YAML.

### AssetStorable

Used for images, voice notes, and future binary content. A storage hint — tells Store the body is binary and how it is encoded.

```go
type AssetStorable interface {
    Storable
    Encoding() Encoding
}

type Encoding int
const (
    Raw          Encoding = iota
    Base64
    LZCompressed
    Zipped
)
```

Store infers and stamps `Encoding` from the raw bytes at creation — the caller never declares it. The key carries the file extension; the encoding tells Store how the bytes are packaged. Together that is everything Store needs. No mime type, no sidecar meta.

---

## Meta

The base metadata contract. Underneath it is a flat map of string to string — the wire format between the meta object and the Store.

```go
type Meta interface {
    Get(key string) string
    Set(key string, value string)  // marks dirty internally
    IsDirty() bool
    All() map[string]string
}
```

Typed domain accessors are built on top per content type:

```go
type NoteMeta interface {
    Meta
    Status() string
    FocusCount() int
    UserIntent() *string
    SetUserIntent(v *string)
    AiEval() string
    Tags() []string
    Summary() string
    Filename() string
    // etc.
}
```

Business logic and the UI use typed accessors exclusively. `Set()` marks Meta dirty. On `Save()`, Store checks `IsDirty()` and re-serialises. The UI never constructs YAML, never parses strings, never knows frontmatter exists.

**Note:** the `version` field previously tracked in frontmatter is removed. Versioning is a by-product of saving — owned entirely by the Store, not a meta field.

---

## FolderStorable

A first-class node in the ownership graph. Folders are not path prefixes or naming conventions — they are Storables that own other Storables.

```go
type FolderStorable interface {
    Storable
    Owns() []Storable  // MetaBasedStorable or FolderStorable — recursive
}
```

Stash v1 supports one level of folders. Arbitrary depth is structurally free — FolderStorable owning FolderStorable requires no Store changes, just business layer permission to create nested folders.

---

## Ownership Graph

The ownership hierarchy:

```
FolderStorable
  └── FolderStorable  (future — not v1)
        └── MetaBasedStorable
              └── AssetStorable
```

**The graph generates the path.** ExternalRef is computed by walking the ownership chain at read time — never stored. Store injects it into the Storable on every load or create.

```
Library
  └── FolderStorable  key="kubernetes"
        └── MetaBasedStorable  key="k8s-fix.md"
              └── AssetStorable  key="blk-a3f9.png"
```

Walk → `notes/kubernetes/k8s-fix.md`. No special knowledge required. The structure produces the path.

**Rename** — Store returns a new FolderStorable with a new key. Children are unchanged. Their ExternalRefs are correct on next read because the graph above them changed.

**Reparent** — change a node's parent. In FileStore this physically moves the file. The graph is then reconstructed from the directory scan. No cascade, no content rewriting, no reference updates. The graph walk produces correct refs automatically.

**FileStore and the graph** — for FileStore, the filesystem IS the ownership graph. Reading the directory tree reconstructs the hierarchy. No separate graph database, no manifest file. The Store scans the folder structure and the graph emerges.

---

## Store

The single persistence boundary. Factory, serialiser, and lifecycle manager for all Storables.

```go
type Store interface {
    Create(category Category, key string, body []byte) (Storable, error)
    Save(s Storable) (Storable, error)
    Load(category Category, key string) (Storable, error)
    Delete(s Storable) error
    List(category Category, prefix string) ([]Storable, error)
    Move(s Storable, to Category) (Storable, error)
    Reparent(s Storable, folder FolderStorable) (Storable, error)
    Rename(s Storable, name string) (Storable, error)
    RetrieveVersion(s Storable, ref VersionRef) (VersionedStorable, error)
}
```

**The Store is responsible for:**
- Generating keys and stamping Category at creation
- Deriving and injecting ExternalRef by walking the ownership graph
- Inferring and stamping Encoding on AssetStorables from raw bytes
- Marshaling and unmarshaling — including meta serialisation and frontmatter handling
- Versioning — creating a version record on every `Save()`, unconditionally
- All filesystem, database, or VCS operations

**The Store is not responsible for:**
- Domain decisions (whether to keep or discard a buffer)
- Business rules (which folder a note belongs in)
- Editor state

**Immutability** — every Store operation returns a new Storable. The old one is stale the moment the operation completes. Business layer and UI replace their reference. The only surfaces that change in place are Body, Meta, and Owns — the three editor-mutable surfaces of a MetaBasedStorable.

**Optimistic locking** — `Save()` compares the version of the incoming Storable against what is currently in the Store. If stale, the operation fails:

```go
var ErrStaleStorable = errors.New("storable is stale — reload and retry")
```

The caller reloads from Store, gets the current version, reapplies changes, and retries. No silent overwrites. No going back.

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

`Storable.Versions()` returns lightweight refs — enough to display a history list. Content is not included.

`RetrieveVersion` returns a `VersionedStorable` — a distinct type from Storable. A versioned snapshot cannot be accidentally saved back as the current document.

```go
type VersionedStorable struct {
    Ref      VersionRef
    Storable            // deserialized snapshot — not the live object
}
```

**Backend implementations:**
- `FileStore` — numbered snapshot files, same format as live files
- `GitStore` — `git log` for history, `git show <hash>:path` for retrieval — free
- `SQLiteStore` — versions table with content column

---

## ExternalRef

The string that leaves the Store boundary and is used by everything above it — the editor, the UI, the markdown on disk, AI CLIs, and external markdown editors.

```
FileStore  →  ../../buffers/assets/blk-a3f9.png
HTTPStore  →  https://xyz.com/assets/blk-a3f9.png
GitStore   →  relative path within repo
```

Derived by walking the ownership graph. Never stored. Always correct. The UI treats it as an opaque string — passes it where a path or URL is needed without knowing which form it takes.

Markdown on disk always contains real, externally-resolvable references. Other editors and AI CLIs can open files and follow image links without any Stash-specific tooling.

---

## Business Layer

Domain types (Note, Buffer, ImageAsset, Settings, Session) are business layer constructs. They wrap or hold a Storable and either embed it or can produce one for Store calls. The Store interface never knows about Note or Buffer — only Storable, MetaBasedStorable, AssetStorable, FolderStorable.

The business layer defines Categories and interprets them semantically. Stash reads WorkingCopy as buffers and Library as filed notes. Another application using the same Store abstraction defines its own categories.

Domain types add typed domain APIs above the base Storable. A Note wraps a MetaBasedStorable and exposes `NoteMeta` with typed accessors. Because it embeds or holds a Storable it can be handed directly to Store calls.

---

## Paste Flow — End to End

The image paste flow demonstrates the design working together:

1. Paste handler receives raw image bytes from clipboard
2. `store.Create(WorkingCopy, "blk-a3f9.png", imageBytes)` — Store infers encoding from bytes, stamps it, derives ExternalRef from ownership graph, returns `AssetStorable`
3. Asset added to current buffer's `Owns()` list
4. Editor inserts `![](asset.ExternalRef())` into body

The paste handler never constructs a path, never decides an encoding, never knows where the file went. It calls Store and uses what comes back.

---

## Frontend Simplification

The Store boundary eliminates accidental complexity in the TypeScript layer.

**Before:** `splitFrontmatter` in App.tsx strips YAML frontmatter from raw markdown before passing content to Tiptap. Two things arrive mixed and must be pulled apart in the frontend.

**After:** Store separates them on load. The frontend receives:
- `storable.Body()` — pure markdown, no frontmatter, straight into Tiptap
- `storable.Meta()` — typed meta object, straight into the Meta panel

The frontend never sees frontmatter. The raw markdown view shows clean body content only. The Meta panel binds to typed accessors. Nothing is mixed.

---

## What This Enables

**Today:** `FileStore` backed by the local store folder structure. The filesystem is the ownership graph — directory scan reconstructs it. Markdown files are readable by any editor or AI CLI.

**Later:** `SQLiteStore`, `HTTPStore`, or `GitStore` introduced by implementing the Store interface. No business logic changes. No TypeScript changes. ExternalRef values change form — callers do not.

**GitStore** is a natural implementation. WorkingCopy = working tree. Library = committed history. `Save()` stages. `Move()` commits. `Versions()` is `git log`. `RetrieveVersion()` is `git show`. The abstraction maps cleanly onto git primitives.

**The invariant:** everything above the Store boundary is backend-agnostic. TypeScript is UI only.
