# Persistence Layer — Implementation Plan

Reference architecture: `docs/architecture-persistence.md`

This document is the agreed implementation plan. It is meant to be read, challenged, and edited before work begins.

---

## Current State

`stash.Store` is a path bag. Every consumer (`buffer.go`, `notes.go`, `history.go`, `app.go`) does its own file I/O, frontmatter parsing, and path construction. The goal is a single `Store` interface as the only boundary to storage, with typed abstractions above it and TypeScript that never sees frontmatter.

---

## Type Hierarchy

```
Storable                    — base: key, category, body, externalRef, versions
  └── MetaStorable          — adds: meta map (map[string]string)
        ├── Buffer           — business type: WorkingCopy category, DocumentMeta contract
        └── Note             — business type: Library category, DocumentMeta contract
  └── AssetStorable         — adds: encoding (inferred from bytes)
  └── FolderStorable        — adds: owns (recursive children)
```

`Buffer` and `Note` are not wrappers around `MetaStorable` — they **are** `MetaStorable`, specialised with a typed meta contract. `Category` is an internal detail of the business services that create them. The frontend never sees `Category`, `WorkingCopy`, or `Library`.

`DocumentMeta` is shared between `Buffer` and `Note` — the fields are identical. `status` is present as a read-only pass-through for backward compat with existing files and external editors. The business type (`Buffer` vs `Note`) is the authoritative signal — not the `status` field.

The meta map travels as `map[string]string` (Go) / `Record<string, string>` (TypeScript). `DocumentMeta` is a typed interface layered on top — the contract that all application code is written against. Unknown keys (e.g. `custom_bg`) round-trip through the map untouched. The Store has no opinion on keys; what they mean is the business layer's concern.

---

## Go Type Definitions

### store/ package — interfaces only, no implementation

```go
// store/interfaces.go

type Storable interface {
    Key()         string
    Category()    Category
    Body()        []byte
    ExternalRef() string
    Versions()    []VersionRef
}

type MetaStorable interface {
    Storable
    Meta() map[string]string   // wire format — use DocumentMeta accessors in business code
    SetBody([]byte)
    SetMeta(map[string]string)
}

type AssetStorable interface {
    Storable
    Encoding() Encoding
}

type FolderStorable interface {
    Storable
    Owns() []Storable
}

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

```go
// store/category.go

type IsolationLevel int
const (
    Shared   IsolationLevel = iota
    Isolated
)

// Category has three distinct identifiers — none should be conflated:
//   Go constant  (Library, WorkingCopy, State) — how developers reference it in code
//   Key          ("store", "buffers", "config") — backend-facing identifier
//   DisplayName  ("Library", "Working Copy", "State") — user-facing label
//
// Key is interpreted by each backend in its natural way:
//   FileStore    — directory name
//   SQLiteStore  — table scope / partition key
//   HTTPStore    — URL path segment
type Category struct {
    Key         string
    DisplayName string
    Isolation   IsolationLevel
}

// Key values match the existing on-disk layout — FileStore uses them as directory
// names with no translation layer.
//
//   Constant    Isolation  Key        FileStore resolved path
//   ────────    ─────────  ───        ──────────────────────────────────
//   Library     Shared     "store"    {root}/store/
//   WorkingCopy Isolated   "buffers"  {root}/{hostname}/buffers/
//   State       Isolated   "config"   {root}/{hostname}/config/
//
// State migration: settings.json and session.json currently live at {hostname}/ root.
// They must be moved to {hostname}/config/ before first run on the new code.
// One-time manual migration — confirmed acceptable.
//
// NOTE: architecture reference doc uses "notes" as the Library key.
// Actual existing directory is "store". Using "store" for backward compat.
// Renaming would require a store migration — decision deferred.
//
// FileStore construction — Key drives path resolution, no extra config needed:
//   filestore.NewFileStore(storePath, hostname)
var (
    Library     = Category{Key: "store",   DisplayName: "Library",      Isolation: Shared}
    WorkingCopy = Category{Key: "buffers", DisplayName: "Working Copy", Isolation: Isolated}
    State       = Category{Key: "config",  DisplayName: "State",        Isolation: Isolated}
)
```

```go
// store/version.go

type VersionRef struct {
    ID      string
    Created time.Time
    Size    int64
}

// VersionedStorable mirrors the data of a Storable at a point in time.
// It does not embed the Storable interface — Key, Category, ExternalRef, Versions
// have no meaning on a snapshot. REF + data is all it is.
// A Buffer that was later filed as a Note will have history entries from both
// states — VersionedStorable is untyped by design.
type VersionedStorable struct {
    Ref  VersionRef
    Body []byte
    Meta map[string]string
    Owns []Storable
}

var ErrStaleStorable = errors.New("storable is stale — reload and retry")
```

```go
// store/encoding.go

type Encoding int
const (
    Raw          Encoding = iota
    Base64
    LZCompressed
    Zipped
)
```

### stash/ package — business layer

```go
// stash/document_meta.go

// DocumentMeta is the typed contract over the meta map.
// Keys match the frontmatter field names exactly.
// The underlying map[string]string is the wire format — never access it directly outside store/.
type DocumentMeta interface {
    // map key: status
    // Pass-through for backward compat with existing files and external editors.
    // No setter — business type (Buffer vs Note) is the authoritative signal.
    Status() string

    // map key: version
    // Read-only — Store stamps on every Save(). UI may display. No setter.
    Version() int

    // map key: focus_count
    FocusCount() int
    SetFocusCount(v int)

    // map key: user_intent — 'keep' | 'trash' | null
    UserIntent() *string
    SetUserIntent(v *string)

    // map key: ai_eval — 'none' | 'evaluating' | 'complete' | 'timeout'
    AiEval() string
    SetAiEval(v string)

    // map key: ai_last_evaluated
    AiLastEvaluated() *string
    SetAiLastEvaluated(v *string)

    // map key: ai_folder_suggestion
    AiFolderSuggestion() *string
    SetAiFolderSuggestion(v *string)

    // map key: user_suggested_name
    UserSuggestedName() *string
    SetUserSuggestedName(v *string)

    // map key: display_name
    DisplayName() string
    SetDisplayName(v string)

    // map key: filename
    Filename() *string
    SetFilename(v *string)

    // map key: summary
    Summary() *string
    SetSummary(v *string)

    // map key: tags
    Tags() []string
    SetTags(v []string)

    // map key: ai_justification
    AiJustification() *string
    SetAiJustification(v *string)

    // map key: density_signals
    DensitySignals() []string
    SetDensitySignals(v []string)

    // map key: created  (read-only — stamped at Create())
    Created() time.Time

    // map key: modified  (read-only — stamped by Store on Save())
    Modified() time.Time

    // map key: cli
    CLI() *string
    SetCLI(v *string)

    // map key: ai_keep
    AiKeep() *bool
    SetAiKeep(v *bool)

    // map key: scroll
    Scroll() int
    SetScroll(v int)
}
```

```go
// stash/buffer.go

type Buffer struct {
    s store.MetaStorable
}

func (b *Buffer) UUID() string              { return b.s.Key() }
func (b *Buffer) Path() string              { /* store-relative */ }
func (b *Buffer) Body() []byte              { return b.s.Body() }
func (b *Buffer) SetBody(v []byte)          { b.s.SetBody(v) }
func (b *Buffer) Meta() DocumentMeta        { return newDocumentMeta(b.s.Meta(), b.s.SetMeta) }
func (b *Buffer) Versions() []store.VersionRef { return b.s.Versions() }
func (b *Buffer) Storable() store.MetaStorable { return b.s }
```

```go
// stash/note.go

type Note struct {
    s store.MetaStorable
}

// Same surface as Buffer — Category difference is internal to services
func (n *Note) UUID() string              { return n.s.Key() }
func (n *Note) Path() string              { /* store-relative */ }
func (n *Note) Body() []byte              { return n.s.Body() }
func (n *Note) SetBody(v []byte)          { n.s.SetBody(v) }
func (n *Note) Meta() DocumentMeta        { return newDocumentMeta(n.s.Meta(), n.s.SetMeta) }
func (n *Note) Versions() []store.VersionRef { return n.s.Versions() }
func (n *Note) Storable() store.MetaStorable { return n.s }
```

```go
// stash/image_asset.go

type ImageAsset struct {
    s store.AssetStorable
}

func (a *ImageAsset) ExternalRef() string      { return a.s.ExternalRef() }
func (a *ImageAsset) Encoding() store.Encoding { return a.s.Encoding() }
func (a *ImageAsset) Storable() store.AssetStorable { return a.s }
```

### Business services

```go
// stash/buffer_service.go
type BufferService struct { store store.Store }

func (s *BufferService) New() (*Buffer, error)
func (s *BufferService) Load(path string) (*Buffer, error)
func (s *BufferService) Save(b *Buffer) (*Buffer, error)
func (s *BufferService) Discard(b *Buffer) error
func (s *BufferService) File(b *Buffer) (*Note, error)                    // WorkingCopy → Library
func (s *BufferService) FileWithName(b *Buffer, name string) (*Note, error)
func (s *BufferService) List() ([]*Buffer, error)
```

```go
// stash/note_service.go
type NoteService struct { store store.Store }

func (s *NoteService) Load(path string) (*Note, error)
func (s *NoteService) Save(n *Note) (*Note, error)
func (s *NoteService) Delete(n *Note) error
func (s *NoteService) Move(n *Note, folder string) (*Note, error)
func (s *NoteService) Rename(n *Note, name string) (*Note, error)
func (s *NoteService) List() ([]NoteEntry, error)
func (s *NoteService) Search(query string) ([]SearchResult, error)
```

```go
// stash/asset_service.go
//
// ImageAsset is a first-class Storable — it exists independently.
// Ownership (which document contains it) is a graph relationship derived
// from the filesystem layout for FileStore. It is not a precondition for
// the asset to exist or be valid.
//
// The caller decides the category — WorkingCopy for a buffer paste,
// Library for a note paste. AssetService has no knowledge of documents.
type AssetService struct { store store.Store }

func (s *AssetService) Save(category Category, key string, data []byte) (*ImageAsset, error)
```

---

## Wails Bridge (app.go)

`app.go` is thin glue. It calls a service, converts the result to a DTO, returns it. DTO conversion is isolated to `app_types.go`.

```
app.go  →  service  →  store.Store  →  FileStore
```

### DTO types (app_types.go)

```go
// DocumentMetaDTO uses camelCase JSON tags — standard JSON convention.
// The frontmatter snake_case keys are an internal FileStore concern.
// FileStore maps snake_case frontmatter → camelCase DTO on load, and back on save.
//
// status  — pass-through for backward compat with existing files and external editors.
//           No setter. Business type (Buffer vs Note) is the authoritative signal.
// version — read-only. Store stamps it on every Save(). UI may display it.
//           No setter.
type DocumentMetaDTO struct {
    Status             string   `json:"status"`              // pass-through, no setter
    Version            int      `json:"version"`             // read-only, Store-owned
    FocusCount         int      `json:"focusCount"`
    UserIntent         *string  `json:"userIntent"`
    AiEval             string   `json:"aiEval"`
    AiLastEvaluated    *string  `json:"aiLastEvaluated"`
    AiFolderSuggestion *string  `json:"aiFolderSuggestion"`
    UserSuggestedName  *string  `json:"userSuggestedName"`
    DisplayName        *string  `json:"displayName"`
    Filename           *string  `json:"filename"`
    Summary            *string  `json:"summary"`
    Tags               []string `json:"tags"`
    AiJustification    *string  `json:"aiJustification"`
    DensitySignals     []string `json:"densitySignals"`
    Created            string   `json:"created"`             // read-only, Store-owned
    Modified           string   `json:"modified"`            // read-only, Store-owned
    CLI                *string  `json:"cli"`
    AiKeep             *bool             `json:"aiKeep"`
    Scroll             int               `json:"scroll"`
    All                map[string]string `json:"all"` // full raw map — every key including unknowns
}

type BufferDTO struct {
    UUID     string          `json:"uuid"`
    Path     string          `json:"path"`
    Body     string          `json:"body"`
    Meta     DocumentMetaDTO `json:"meta"`
    Versions []VersionRefDTO `json:"versions"`
}

type NoteDTO struct {
    UUID     string          `json:"uuid"`
    Path     string          `json:"path"`
    Body     string          `json:"body"`
    Meta     DocumentMetaDTO `json:"meta"`
    Versions []VersionRefDTO `json:"versions"`
}

type AssetDTO struct {
    UUID        string `json:"uuid"`
    Path        string `json:"path"`
    ExternalRef string `json:"externalRef"`
    Encoding    string `json:"encoding"`
}

type VersionRefDTO struct {
    ID      string `json:"id"`
    Created string `json:"created"`
    Size    int64  `json:"size"`
}

type VersionedStorableDTO struct {
    Ref  VersionRefDTO   `json:"ref"`
    Body string          `json:"body"`
    Meta DocumentMetaDTO `json:"meta"`
    Owns []AssetDTO      `json:"owns"`
}
```

**Meta map:** the full raw map is included in every DTO as `all: Record<string, string>`. Known fields are also present as typed properties. Unknown keys (custom fields, future fields, tooling metadata) are accessible via `meta.all` on the frontend without any special handling.

### Binding signatures

```go
// Buffers
func (a *App) NewBuffer() (BufferDTO, error)
func (a *App) LoadBuffer(path string) (BufferDTO, error)
func (a *App) SaveBuffer(dto BufferDTO) (BufferDTO, error)
func (a *App) DiscardBuffer(path string) error
func (a *App) FileBuffer(path string) (NoteDTO, error)
func (a *App) FileBufferWithName(path, name string) (NoteDTO, error)

// Notes
func (a *App) LoadNote(path string) (NoteDTO, error)
func (a *App) SaveNote(dto NoteDTO) (NoteDTO, error)
func (a *App) DeleteNote(path string) error
func (a *App) MoveNote(path, targetFolder string) (NoteDTO, error)
func (a *App) RenameNote(path, newName string) (NoteDTO, error)
func (a *App) GetNotes() []NoteEntry   // sidebar projection — unchanged

// Assets — caller specifies context, binding resolves to correct category
func (a *App) SaveAsset(context string, id, dataBase64 string) (AssetDTO, error)
func (a *App) DownloadAsset(context string, url, id string) (AssetDTO, error)
// context: store-relative path of the owning document, or "" for standalone

// History — refs travel with the loaded document (Storable.Versions())
// No separate list call needed — use a ref already held by the frontend
func (a *App) GetDocumentVersion(path string, ref VersionRefDTO) (VersionedStorableDTO, error)

// Removed
// SaveVersionSnapshot — Store.Save() handles this automatically
// resolvePath — Store handles path resolution internally
// GetBufferHistory — version refs come with the loaded Buffer/Note
```

---

## TypeScript Mirrors

Every DTO type has a direct TypeScript mirror. TypeScript codes against `DocumentMeta` (typed) — the raw `Record<string, string>` is accessible for unknown fields but is not the primary API.

```typescript
// types.ts
// Field names match the Go DTO json tags (camelCase).
// status  — pass-through, never written by frontend
// version — read-only, Store-owned, UI may display it
interface DocumentMeta {
    readonly status: 'unfiled' | 'filed'
    readonly version: number
    focusCount: number
    userIntent: 'keep' | 'trash' | null
    aiEval: 'none' | 'evaluating' | 'complete' | 'timeout'
    aiLastEvaluated: string | null
    aiFolderSuggestion: string | null
    userSuggestedName: string | null
    displayName: string | null
    filename: string | null
    summary: string | null
    tags: string[]
    aiJustification: string | null
    densitySignals: string[]
    readonly created: string
    readonly modified: string
    cli: string | null
    aiKeep: boolean | null
    scroll: number
    all: Record<string, string>          // full raw map — every key including unknowns
    [key: string]: unknown
}

interface Buffer {
    uuid: string
    path: string            // hostname/buffers/...
    body: string
    meta: DocumentMeta
    versions: VersionRef[]
}

interface Note {
    uuid: string
    path: string            // store/...
    body: string
    meta: DocumentMeta
    versions: VersionRef[]
}

interface Asset {
    uuid: string
    path: string
    externalRef: string     // insert directly into markdown body
    encoding: 'raw' | 'base64' | 'lz-compressed' | 'zipped'
}

interface VersionRef {
    id: string
    created: string
    size: number
}

// Untyped by design — a snapshot may predate or postdate Buffer→Note promotion
interface VersionedStorable {
    ref: VersionRef
    body: string
    meta: DocumentMeta
    owns: Asset[]
}
```

`TabState` holds a `Buffer | Note` reference (or its UUID to look up in a cache). `status` is no longer a separate field on `TabState` — the type of the object tells you whether it is filed.

---

## Frontend Changes (Phase 5)

### What is removed

| Location | Removed | Replaced by |
|---|---|---|
| `lib/markdown.ts` | `splitFrontmatter` | `LoadBuffer` returns `{body, meta}` already separated |
| `lib/fmUtils.ts` | `parseMeta` | read `buffer.meta.userIntent` etc. directly |
| `lib/fmUtils.ts` | `setYamlField`, `bumpFm` | mutate the typed `meta` object, call `SaveBuffer(buffer)` |
| `lib/fmUtils.ts` | `assetMarkdownPath` | `AssetDTO.externalRef` returned from Go |
| `App.tsx` | `fmCache` | `storableCache: Record<uuid, Buffer \| Note>` |
| `App.tsx` | `bumpFm()` before save | Store bumps version on `Save()` automatically |
| `App.tsx` | `SaveVersionSnapshot()` call | Store handles this |
| `App.tsx` | frontmatter prepend in flush | `SaveBuffer(buffer)` takes typed object |

### Save flow (after)

```typescript
// flush()
const body = editor.storage.markdown.getMarkdown()
const cached = storableCache[uuid]
if (body === savedBodyCache[uuid]) return   // no change

const updated: Buffer = { ...cached, body }
const saved = await SaveBuffer(updated)
storableCache[uuid] = saved                 // replace with ground truth from Go
savedBodyCache[uuid] = saved.body
```

### Meta mutation flow (after)

```typescript
// user clicks 'keep'
const cached = storableCache[uuid] as Buffer
const updated: Buffer = {
    ...cached,
    meta: { ...cached.meta, userIntent: 'keep' }
}
const saved = await SaveBuffer(updated)
storableCache[uuid] = saved
```

### Asset insertion flow (after)

```typescript
const asset = await SaveAsset(buffer.path, id, dataBase64)
editor.commands.insertContent(`![](${asset.externalRef})`)
```

### MetaPanel (after)

Receives `meta: DocumentMeta` — typed fields, no regex. History tab reads `buffer.versions` (refs already on the loaded document). Restore calls `GetDocumentVersion(path, ref)` returning `VersionedStorable`.

---

## FileStore Implementation (Phase 2)

Files under `store/filestore/`:

| File | Responsibility |
|---|---|
| `filestore.go` | `FileStore` struct, `NewFileStore(root, hostname)`, `ensureDirs`, category→path resolution via `Category.Key` and `IsolationLevel` |
| `storable.go` | Concrete `fileStorable`, `fileMetaStorable`, `fileAssetStorable`, `fileFolderStorable` — immutable value objects |
| `meta.go` | `fileDocumentMeta` — implements `DocumentMeta` over `map[string]string`. Parse YAML frontmatter once on Load. `Set*` methods mark dirty. `Save()` re-serialises only if dirty. |
| `graph.go` | Ownership graph via directory scan. `ExternalRef` computed by walking graph upward. Used by `List`, `Reparent`, `Rename`. |
| `version.go` | Every `Save()` writes a snapshot unconditionally. `VersionRef` carries ID/time/size. `RetrieveVersion` returns `VersionedStorable`. Snapshot dir respects `IsolationLevel`. Optimistic lock check before write. |
| `encoding.go` | Magic-byte sniffing to infer `Encoding` at `Create()` time — caller never declares it. |

**Key invariants:**
- `Create` stamps `Category` and derives `ExternalRef` — caller never sets these
- `Save` returns a new `Storable` — the input is stale after the call
- `Body()` from `Load` is pure markdown, frontmatter stripped
- `List(Library, "")` scans the directory tree and reconstructs the ownership graph
- `AssetStorable` encoding is inferred from magic bytes, not declared by caller

---

## What Gets Deleted

| File/Symbol | Replaced by |
|---|---|
| `stash/history.go` | `store/filestore/version.go` |
| `stash/store.go` `Open()` | `filestore.NewFileStore(...)` |
| `buffer.go` direct file ops | `BufferService` + `FileStore` |
| `notes.go` `ExtractFromFm`, `ExtractDisplayName` etc. | `meta.Get(...)` on loaded `MetaStorable` |
| `app.go` `splitFrontmatter`, `resolvePath`, `SaveVersionSnapshot` | removed |

---

## Phase Breakdown

### Phase 1 — Core interfaces (no behaviour change)
Create `store/` package: `category.go`, `interfaces.go`, `version.go`, `encoding.go`. Pure type definitions. Nothing in the app changes.

### Phase 2 — FileStore implementation
Create `store/filestore/`. Implement the `Store` interface. All existing tests must still pass — nothing is wired up yet.

### Phase 3 — Business layer
Create `stash/document_meta.go`, `stash/note.go`, update `stash/buffer.go`, update `stash/session.go`, update `stash/settings.go`. Business types and services built on top of the Store interface.

### Phase 4 — Wire up
Replace `a.stash *stash.Store` with `a.buffers *BufferService`, `a.notes *NoteService`, `a.assets *AssetService` in `app.go`. Update all bindings to use the new service layer and return DTOs. Old `stash.Store` path-bag deleted once `app.go` compiles clean.

Migrate in this order (highest coverage first):
1. `NewBuffer` / `DiscardBuffer` / `FileBuffer`
2. `LoadBuffer` / `SaveBuffer`
3. `GetBufferHistory` / `GetBufferHistoryBody`
4. `ScanNotes` / `DeleteNote` / `MoveNote`
5. Asset bindings
6. Session / Settings

### Phase 5 — Frontend
Done after Phase 4 is stable and all bindings return typed DTOs.

Migrate in this order:
1. Add `DocumentMeta`, `Buffer`, `Note`, `Asset`, `VersionRef` to `types.ts`
2. Update `App.tsx` load flow — `LoadBuffer` returns `BufferDTO`, populate `storableCache`
3. Update `App.tsx` save flow — `SaveBuffer(buffer)`, remove `bumpFm` and frontmatter prepend
4. Update `MetaPanel.tsx` — receive `meta: DocumentMeta`, remove internal YAML parsing
5. Update `useNoteOperations.ts` — meta mutations via typed object, not `setYamlField`
6. Update asset handlers — use `AssetDTO.externalRef`
7. Update `aiContextBuilder.ts` — use cached `buffer.body` directly
8. Delete `lib/markdown.ts`, clean `lib/fmUtils.ts`

---

## Decided

**Unknown meta keys:** the full raw map is included in the DTO alongside the typed fields. All map entries travel to the frontend — useful for inspection, custom fields, and tooling. The typed `DocumentMeta` interface covers known fields; unknown entries arrive via the index signature.

**FolderStorable:** everything goes through the Store interface, including folder create/rename. No carve-outs for direct file ops in Phase 4.

**History restore return type:** `VersionedStorable` — Ref + Body + Meta + Owns. Untyped by design: a Buffer that is filed as a Note has history spanning both states, so snapshots cannot carry a Buffer or Note type. Version refs travel with the loaded document (`Storable.Versions()`) — no separate history list binding is needed. Restore retrieves a snapshot via a ref already held by the frontend: `GetDocumentVersion(path, ref)`.
