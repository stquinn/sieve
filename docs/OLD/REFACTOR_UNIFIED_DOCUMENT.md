# Refactor: Unified Document Interface + DocumentService

## Why

`Note` and `Buffer` are structurally identical — both wrap `store.MetaStorable` with the same method surface (`Slug`, `UUID`, `Path`, `Body`, `SetBody`, `Meta`, `Versions`, `Storable`). The only difference is which `store.Category` they live in (WorkingCopy vs Library). Having two separate types forces ugly dual-path branching throughout callers:

```go
if buf, err := buffers.LoadByUUID(id); err == nil {
    // handle buffer...
} else if note, err := notes.LoadByUUID(id); err == nil {
    // handle note...
}
```

This pattern appears in every handler, `app.go`, `filing.go`, and `ai_service.go`. The goal is to eliminate it entirely with a common `Document` interface and a single `DocumentService` that replaces both `NoteService` and `BufferService`.

**Key constraint:** `Note` and `Buffer` remain as concrete types (duck typing). `DocumentService` owns the store directly — it does NOT wrap the old services. Both old service files are deleted.

---

## Step 1 — New file: `sieve/document.go`

Define the interface and kind type. No existing code changes.

```go
type DocumentKind string

const (
    KindBuffer DocumentKind = "buffer"  // WorkingCopy category
    KindNote   DocumentKind = "note"    // Library category
)

type Document interface {
    Kind() DocumentKind
    UUID() string
    Path() string
    Slug() string
    Body() []byte
    SetBody(v []byte)
    Meta() DocumentMeta
    Versions() []store.VersionRef
    Storable() store.MetaStorable
}
```

---

## Step 2 — Add `Kind()` to `sieve/note.go` and `sieve/buffer.go`

**`sieve/note.go`**: add `kind DocumentKind` field to `Note`, set `kind: KindNote` in `newNote`, add `func (n *Note) Kind() DocumentKind { return n.kind }`.

**`sieve/buffer.go`**: same — `kind: KindBuffer` in `newBuffer`, add `Kind()`.

After this step both `*Note` and `*Buffer` satisfy `Document`.

---

## Step 3 — New file: `sieve/document_service.go` — replaces both services

`DocumentService` holds the store directly:

```go
type DocumentService struct {
    st store.Store
}

func NewDocumentService(st store.Store) (*DocumentService, error) {
    if err := st.PrepareCategory(Library); err != nil {
        return nil, err
    }
    if err := st.PrepareCategory(WorkingCopy); err != nil {
        return nil, err
    }
    return &DocumentService{st: st}, nil
}
```

**Shared methods** (route internally by `doc.Kind()`):

| Method | Behaviour |
|--------|-----------|
| `Load(path string) (Document, error)` | Detects category from path (checks WorkingCopy marker, falls back to Library). Returns `*Buffer` or `*Note` as Document |
| `LoadByUUID(uuid string) (Document, error)` | Scans Library first (stable IDs), then WorkingCopy |
| `Save(doc Document) (Document, error)` | Routes by kind — saves to correct category |
| `Delete(doc Document) error` | `st.Delete(doc.Storable())` regardless of kind |
| `SetIntent(doc Document, intent string) (Document, error)` | Mutate meta, call Save |
| `AttachAsset(doc Document, a store.AssetStorable) error` | Mutate storable, `st.Save` |
| `RetrieveVersion(doc Document, ref store.VersionRef) (store.VersionedStorable, error)` | `st.RetrieveVersion` |
| `Rename(doc Document, name string) (Document, error)` | Buffer: update `display_name`, save. Note: update `display_name`, `st.Rename` |

**Buffer-only** (error if `doc.Kind() != KindBuffer`):

| Method | Behaviour |
|--------|-----------|
| `New() (Document, error)` | Creates empty buffer in WorkingCopy with "Untitled N" name |
| `Discard(doc Document) error` | `st.Delete` |
| `Promote(doc Document) (Document, error)` | Rename within WorkingCopy → `st.Move` to Library. Returns `*Note` as Document |
| `PromoteWithName(doc Document, name string) (Document, error)` | Override `user_suggested_name` before Promote |

**Note-only** (error if `doc.Kind() != KindNote`):

| Method | Behaviour |
|--------|-----------|
| `Refile(doc Document) (Document, error)` | Derives folder+kebab from meta, calls `st.MoveToKey` |
| `Move(doc Document, folder string) (Document, error)` | `st.MoveToKey` preserving filename |
| `Search(query string) ([]SearchResult, error)` | Full-text + frontmatter scan of Library |
| `Count() int` | Count `.md` files in Library |

**Unified List:**

```go
type DocumentList struct {
    Kind    DocumentKind
    Entries []NoteEntry  // tree — populated when Kind == KindNote
    Docs    []Document   // flat — populated when Kind == KindBuffer
}

func (ds *DocumentService) List(kind DocumentKind) (DocumentList, error)
```

**Helpers migrated from old service files into `document_service.go`:**
- `keyFromPath` (from `buffer_service.go`)
- `deriveKebabNameFromMeta`, `deriveFolderFromMeta` (from `buffer_service.go`)
- `defaultMetaBody`, `nextUntitledNumber` (from `buffer_service.go`)
- `buildNoteTree`, `buildFolderChildren`, `metaString`, `max`, `min` (from `note_service.go`)
- `NoteEntry`, `SearchResult` types (from `note_service.go`)

String helpers `toKebab`, `cleanFolderPath`, `cleanFolderSegment` stay in `buffer.go`.

**Delete:**
- `sieve/note_service.go`
- `sieve/buffer_service.go`

---

## Step 4 — Update `sieve/filing.go`

```go
type FilingOutcome struct {
    Discarded bool
    Doc       Document  // replaces *Note / *Buffer fields
}

func filingLoadDoc(path string, docs *DocumentService) (Document, error)
func filingCommitDoc(doc Document, docs *DocumentService, save bool, fileAfter bool) (FilingOutcome, error)
func filingDiscardDoc(doc Document, docs *DocumentService) error
```

Replace `if isNote` branches with `if doc.Kind() == KindNote`. Merge or inline `filingCommitNote`/`filingCommitBuffer`.

---

## Step 5 — Update `sieve/service_provider.go`

```go
type ServiceProvider struct {
    Store     *store.Store
    Documents *DocumentService  // replaces Buffers + Notes
    Assets    *AssetService
    State     *StateService
    Prompts   *PromptService
    AI        *AIService
}
```

`Init` calls `NewDocumentService(store)`. Passes `Documents` to `NewAIService`.

---

## Step 6 — Update `sieve/ai_service.go`

```go
func NewAIService(state *StateService, prompts *PromptService, docs *DocumentService, storePath string) *AIService
```

Replace `buffers`/`notes` fields with `docs`. `filingLoadDoc` calls become single-argument. `libraryFolders()` calls `docs.List(KindNote).Entries`.

---

## Step 7 — Update `requesthandlers/`

All try-buffer-then-note patterns collapse to one `Documents.LoadByUUID` / `Documents.Load` call. Branch on `doc.Kind()` only where behaviour genuinely differs.

Files: `note_handler.go`, `ai_handler.go`, `editor_handler.go`, `meta_handler.go`, `context_menu_handler.go`, `sidebar_handler.go`

`sidebar_handler.go`: `RenderSidebar` accepts `*DocumentService`, calls `docs.List(KindNote).Entries`.

---

## Step 8 — Update `app.go` and `app_types.go`

Replace `a.Buffers`/`a.Notes` with `a.Documents`. `outcome.Note`/`outcome.Buffer` becomes `outcome.Doc`.

`toNoteBufferDTO` accepts `Document` interface. `Kind` field in DTO becomes `string(doc.Kind())`.

---

## File change summary

| File | Action |
|------|--------|
| `sieve/document.go` | **New** — `Document` interface + `DocumentKind` |
| `sieve/note.go` | Add `Kind()` method + field |
| `sieve/buffer.go` | Add `Kind()` method + field |
| `sieve/document_service.go` | **New** — all service logic merged here |
| `sieve/note_service.go` | **Deleted** |
| `sieve/buffer_service.go` | **Deleted** |
| `sieve/filing.go` | `FilingOutcome.Doc`, simplified helpers |
| `sieve/service_provider.go` | Replace `Buffers`/`Notes` with `Documents` |
| `sieve/ai_service.go` | Constructor + filing calls |
| `requesthandlers/*.go` | Collapse dual-path patterns |
| `app.go` + `app_types.go` | Same; `toNoteBufferDTO` accepts `Document` |

## What does NOT change

- `store.Category` — `DocumentKind` maps to it; store internals untouched
- `DocumentMeta` interface — unchanged
- `NoteEntry`, `SearchResult`, sidebar tree logic — unchanged
- Wails bridge method **names** — no frontend API change
- `PromptStorable` / `kind: 'prompt'` path — unchanged

## Verification

```bash
# 1. Go compiles clean
go build -tags webkit2_41 ./...

# 2. Manual smoke test in wails dev:
#    - Create buffer, edit, promote → appears in library as note (kind="note")
#    - Load existing note, edit, save → round-trips correctly
#    - Smart file a buffer → FilingOutcome.Doc non-nil with Kind==KindNote
#    - Sidebar renders note tree via List(KindNote).Entries
#    - Buffer list renders flat via List(KindBuffer).Docs
```
