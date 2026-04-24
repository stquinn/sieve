# Refactor: Unified Document Type + FilingService

## Why

Two related design problems identified during the EvaluateAndFile refactor (session April 2026):

**1. Business logic sharding**
`EvaluateAndFileDoc` ended up as a free function in `stash/filing.go` taking 8 arguments
`(path, buffers, notes, settings, folders, prompt, fileAfter, allowDiscard)`. A cross-service
orchestration operation like this belongs on a named service, not a free function with every
dependency threaded by hand.

**2. Buffer/Note type duplication**
`Buffer` (`stash/buffer.go`) and `Note` (`stash/note.go`) are structurally **identical**:
same wrapped `store.MetaStorable`, same method set (`Slug`, `UUID`, `Path`, `Body`, `SetBody`,
`Meta`, `Versions`, `Storable`). The only difference is which `store.Category` they live in
(WorkingCopy vs Library). Since `DocumentKind` == `store.Category`, the two-type model
provides no type-system value — it only forces ugly `(isNote bool, *Buffer, *Note)` patterns
in `filing.go` and `instanceof` checks in TypeScript.

---

## Approach (4 steps)

### Step 1 — Unified `Document` domain type

Replace `Buffer` and `Note` with a single `Document` type in new file `stash/document.go`.

```go
type DocumentKind string
const (
    KindBuffer DocumentKind = "buffer"  // WorkingCopy category
    KindNote   DocumentKind = "note"    // Library category
)

type Document struct {
    s    store.MetaStorable
    kind DocumentKind
    slug string
}

func newBufferDoc(s store.MetaStorable) *Document  // sets meta["status"] = "unfiled"
func newNoteDoc(s store.MetaStorable) *Document    // sets meta["status"] = "filed" (unless "error")

func (d *Document) Kind() DocumentKind
func (d *Document) IsBuffer() bool
func (d *Document) IsNote() bool
func (d *Document) Slug() string
func (d *Document) UUID() string
func (d *Document) Path() string
func (d *Document) Body() []byte
func (d *Document) SetBody([]byte)
func (d *Document) Meta() DocumentMeta
func (d *Document) Versions() []store.VersionRef
func (d *Document) Storable() store.MetaStorable
```

**Keep `BufferService` and `NoteService` as separate structs** — they have different
capabilities (`NoteService` has tree `List`, `Search`, `Count`; `BufferService` has `New`).
They just return `*Document` instead of `*Buffer`/`*Note`.

Files changed:
- **Delete** `stash/buffer.go` — shared string helpers (`toKebab`, `cleanFolderPath`, etc.)
  move into `stash/document.go`
- **Delete** `stash/note.go`
- **New** `stash/document.go`
- `stash/buffer_service.go` — all return types `*Buffer` → `*Document`; internal calls to
  `newBuffer(...)` → `newBufferDoc(...)`
- `stash/note_service.go` — all return types `*Note` → `*Document`; `newNote(...)` → `newNoteDoc(...)`

---

### Step 2 — `FilingService` as a proper service

Replace the free function `EvaluateAndFileDoc` and its internal helpers with a `FilingService`
struct. All of this lives in `stash/filing.go` (replacing the current content).

```go
type FilingService struct {
    buffers *BufferService
    notes   *NoteService
}

func NewFilingService(buffers *BufferService, notes *NoteService) *FilingService

type FilingOutcome struct {
    Discarded bool
    Doc       *Document   // nil when Discarded; Doc.Kind() tells you buffer vs note
}

func (fs *FilingService) EvaluateAndFile(
    path         string,
    settings     Settings,
    folders      []string,
    promptTmpl   string,
    fileAfter    bool,
    allowDiscard bool,
) (FilingOutcome, error)
```

Internal helpers become unexported methods on `*FilingService`:
- `fs.loadDoc(path) (*Document, error)` — tries buffers then notes, returns single `*Document`
- `fs.applyEval(doc *Document, folders []string, settings Settings, prompt string) (bool, error)`
- `fs.commit(doc *Document, save bool, fileAfter bool) (FilingOutcome, error)`
- `fs.discard(doc *Document) error`

No more `(isNote bool, *Buffer, *Note)` anywhere. `commit` branches on `doc.Kind()`:
- `KindBuffer + fileAfter` → `fs.buffers.File(doc)` → returns `*Document` with `KindNote`
- `KindNote  + fileAfter` → `fs.notes.Refile(doc)` → returns `*Document` with `KindNote`

`app.go` gets a `filing *stash.FilingService` field, initialized in `startup()` after the
two service constructors:

```go
a.filing = stash.NewFilingService(a.buffers, a.notes)
```

Bridge method shrinks to:

```go
func (a *App) EvaluateAndFile(path string, fileAfter bool, allowDiscard bool) (EvaluateAndFileResult, error) {
    if a.filing == nil {
        return EvaluateAndFileResult{}, fmt.Errorf("store not open")
    }
    settings := a.state.LoadSettings()
    prompt, _ := a.prompts.GetPromptContent("file")
    outcome, err := a.filing.EvaluateAndFile(path, settings, a.libraryFolders(), prompt, fileAfter, allowDiscard)
    if err != nil {
        return EvaluateAndFileResult{}, err
    }
    if outcome.Discarded {
        return EvaluateAndFileResult{Discarded: true}, nil
    }
    return EvaluateAndFileResult{Doc: toDocumentDTO(outcome.Doc)}, nil
}
```

---

### Step 3 — Unified `DocumentDTO` on the wire

Replace `BufferDTO` + `NoteDTO` with a single `DocumentDTO` in `app_types.go`. Fields are
identical to the current DTOs — just one struct. `kind` is the discriminator.

```go
type DocumentDTO struct {
    Kind     string          `json:"kind"`     // "buffer" or "note"
    UUID     string          `json:"uuid"`
    Path     string          `json:"path"`
    Slug     string          `json:"slug"`
    Body     string          `json:"body"`
    Meta     DocumentMetaDTO `json:"meta"`
    Versions []VersionRefDTO `json:"versions"`
}
```

Remove `toBufferDTO`, `toNoteDTO`, `toNoteBufferDTO`. Replace with:

```go
func toDocumentDTO(d *stash.Document) DocumentDTO {
    return DocumentDTO{
        Kind:     string(d.Kind()),
        UUID:     d.UUID(),
        Path:     d.Path(),
        Slug:     d.Slug(),
        Body:     string(d.Body()),
        Meta:     toDocumentMetaDTO(d.Meta()),
        Versions: toVersionRefDTOs(d.Versions()),
    }
}
```

`EvaluateAndFileResult` changes `Doc BufferDTO` → `Doc DocumentDTO`.

`SaveBuffer(dto BufferDTO)` → `SaveBuffer(dto DocumentDTO)` — routes by `dto.Kind` (or
`dto.Meta.Status`) to `notes.Save` vs `buffers.Save`. Same logic as today, simpler type.

`LoadBuffer` return type stays `interface{}` (Wails needs this for polymorphic return) but
the underlying struct is always `DocumentDTO`.

Wails binding files (manually updated — not auto-generated in this project):
- `frontend/wailsjs/go/models.ts` — add `DocumentDTO` class, remove `BufferDTO`/`NoteDTO`
- `frontend/wailsjs/go/main/App.d.ts` — update signatures that referenced `BufferDTO`/`NoteDTO`
- `frontend/wailsjs/go/main/App.js` — no change (bridge method names unchanged)

---

### Step 4 — TypeScript cleanup

With a single `DocumentDTO` class from Step 3:

**`frontend/src/lib/SmartStorables.ts`**
- Augment `DocumentDTO.prototype` once (replacing the two separate augmentations for
  `BufferDTO` and `NoteDTO`)

**`frontend/src/lib/StorableDataService.ts`**
- `load()`: `const doc = new main.DocumentDTO(raw)` instead of branching on `status`
  to choose BufferDTO vs NoteDTO; set `doc.kind` from `meta.status === 'filed'`
- `save()`: remove `instanceof BufferDTO`/`instanceof NoteDTO` — use `doc.kind` directly
- `create()`: return `new main.DocumentDTO(...)` with `kind = 'buffer'`
- `set()`: same — `new main.DocumentDTO(...)` setting kind from status

**`frontend/src/types.ts`**
- `Storable` interface — `kind: 'buffer' | 'note' | 'prompt'` stays as-is (no change)

**`frontend/src/App.tsx`**
- `isBuffer` check already uses `doc?.kind === 'buffer'` (fixed in previous session) —
  no further change needed

---

## File change summary

| File | Action |
|------|--------|
| `stash/buffer.go` | **Delete** (content folds into `document.go`) |
| `stash/note.go` | **Delete** (content folds into `document.go`) |
| `stash/document.go` | **New** — `Document`, `DocumentKind`, `newBufferDoc`, `newNoteDoc`, shared string helpers |
| `stash/buffer_service.go` | Return `*Document` everywhere; `newBuffer` → `newBufferDoc` |
| `stash/note_service.go` | Return `*Document` everywhere; `newNote` → `newNoteDoc` |
| `stash/filing.go` | Rewrite as `FilingService` struct with method `EvaluateAndFile` |
| `app_types.go` | `DocumentDTO` replaces `BufferDTO`+`NoteDTO`; single `toDocumentDTO` |
| `app.go` | Add `filing *stash.FilingService`; update bridge methods to use `DocumentDTO` |
| `frontend/wailsjs/go/models.ts` | Add `DocumentDTO`; remove `BufferDTO`, `NoteDTO` |
| `frontend/wailsjs/go/main/App.d.ts` | Update signatures |
| `frontend/src/lib/StorableDataService.ts` | Remove `instanceof` checks; use `DocumentDTO` |
| `frontend/src/lib/SmartStorables.ts` | Single augmentation on `DocumentDTO.prototype` |

## What does NOT change

- `store.Category` — `DocumentKind` maps to it; store internals untouched
- `DocumentMeta` interface — unchanged
- `EvaluateBuffer`, `ApplyFilingRec` — unchanged signatures (still take `DocumentMeta`, `[]byte`)
- `PromptStorable` / `kind: 'prompt'` path — unchanged
- Wails bridge method **names** — no frontend API change; no Wails re-bind needed
- `NoteEntry`, `SearchResult`, sidebar tree logic — unchanged

## Verification

```bash
# 1. Go compiles clean
go build -tags webkit2_41 ./...

# 2. All stash package tests pass
go test ./stash/...

# 3. Manual smoke test in wails dev:
#    - Create a new buffer, type content, trigger EvaluateAndFile → appears in library as note
#    - Load an existing note, edit body, save → round-trips correctly
#    - Create empty buffer, trigger file → discarded (not in library)
#    - Set user_intent=trash, EvaluateAndFile with allowDiscard=false → save-only (no AI, no file)
#    - Set user_intent=trash, EvaluateAndFile with allowDiscard=true → discarded
```
