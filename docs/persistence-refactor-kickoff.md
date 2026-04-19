# Persistence Refactor — Kickoff Document

Use this to resume work in a fresh session. Read this file and `docs/architecture-persistence-plan.md` before doing anything.

---

## What This Is

A full replacement of the current persistence layer. Today `stash.Store` is a path bag — every consumer does its own file I/O, frontmatter parsing, and path construction. After this refactor, a single `Store` interface is the only boundary to storage. TypeScript never sees frontmatter again.

---

## Key Documents

- `docs/architecture-persistence.md` — reference architecture (the design concept)
- `docs/architecture-persistence-plan.md` — the agreed implementation plan (read this carefully)

---

## Estimate

| Phase | Work | Complexity |
|---|---|---|
| 1 — Core interfaces | ~150 lines new | Low |
| 2 — FileStore | ~1,200 lines new | **High** |
| 3 — Business layer | ~750 lines new | Medium |
| 4 — Wire up | ~1,000 lines changed | Medium-High |
| 5 — Frontend | ~500 lines changed | Medium |

**Total: ~8–12 hours.** Phase 2 is the hardest (YAML round-tripping, ownership graph, optimistic locking). Phase 4 is the riskiest (live app migration).

---

## Task List

### Phase 1 — Core interfaces (no behaviour change)
- [ ] `store/category.go` — `IsolationLevel`, `Category` struct, `Library`/`WorkingCopy`/`State` vars
- [ ] `store/interfaces.go` — `Storable`, `MetaStorable`, `AssetStorable`, `FolderStorable`, `Store` interface
- [ ] `store/version.go` — `VersionRef`, `VersionedStorable`, `ErrStaleStorable`
- [ ] `store/encoding.go` — `Encoding` type and constants

### Phase 2 — FileStore implementation
- [ ] `store/filestore/encoding.go` — magic byte sniffing to infer `Encoding`
- [ ] `store/filestore/storable.go` — concrete `fileStorable`, `fileMetaStorable`, `fileAssetStorable`, `fileFolderStorable`
- [ ] `store/filestore/meta.go` — `fileDocumentMeta` over `map[string]string`, YAML parse/serialise, unknown key preservation, dirty tracking
- [ ] `store/filestore/graph.go` — directory scan, ownership graph reconstruction, `ExternalRef` computation
- [ ] `store/filestore/version.go` — snapshot writes on every `Save()`, pruning, `IsolationLevel` routing, optimistic lock check
- [ ] `store/filestore/filestore.go` — `FileStore` struct, `NewFileStore(root, hostname)`, full `Store` interface implementation

### Phase 3 — Business layer
- [ ] `stash/document_meta.go` — `DocumentMeta` interface
- [ ] `stash/image_asset.go` — `ImageAsset` wrapping `AssetStorable`
- [ ] `stash/note.go` — `Note` wrapping `MetaStorable`
- [ ] `stash/buffer.go` — rewrite: `Buffer` wrapping `MetaStorable`
- [ ] `stash/asset_service.go` — `AssetService.Save(category, key, data)`
- [ ] `stash/buffer_service.go` — `New`, `Load`, `Save`, `Discard`, `File`, `FileWithName`, `List`
- [ ] `stash/note_service.go` — `Load`, `Save`, `Delete`, `Move`, `Rename`, `List`, `Search`
- [ ] `stash/session.go` — redirect to `FileStore` `State` category
- [ ] `stash/settings.go` — redirect to `FileStore` `State` category

### Phase 4 — Wire up (riskiest phase — keep app compiling throughout)
- [ ] Manual store migration — move `settings.json`, `session.json` to `{hostname}/config/`
- [ ] `app_types.go` — all DTOs, `VersionedStorableDTO`, `toBufferDTO`/`fromBufferDTO` conversions
- [ ] `app.go` — replace `a.stash *stash.Store` with `a.buffers`, `a.notes`, `a.assets` services
- [ ] Migrate buffer bindings — `NewBuffer`, `LoadBuffer`, `SaveBuffer`, `DiscardBuffer`, `FileBuffer`, `FileBufferWithName`
- [ ] Migrate note bindings — `LoadNote`, `SaveNote`, `DeleteNote`, `MoveNote`, `RenameNote`, `GetNotes`
- [ ] Migrate asset bindings — `SaveAsset`, `DownloadAsset`
- [ ] Migrate history binding — `GetDocumentVersion(path, ref)`
- [ ] Migrate folder bindings — `CreateFolder`, `DeleteFolder`, `RenameFolder` via `Store`
- [ ] Migrate session and settings bindings
- [ ] Delete `stash/history.go`, old `stash/store.go`, `stash/notes.go` helpers
- [ ] Build and run — verify app works end to end before touching frontend

### Phase 5 — Frontend (only after Phase 4 verified)
- [ ] `types.ts` — add `Buffer`, `Note`, `Asset`, `DocumentMeta`, `VersionRef`, `VersionedStorable`
- [ ] `App.tsx` load flow — `LoadBuffer` returns `BufferDTO`, populate `storableCache`
- [ ] `App.tsx` save flow — `SaveBuffer(buffer)`, remove `bumpFm`, remove frontmatter prepend
- [ ] `MetaPanel.tsx` — receive `meta: DocumentMeta`, remove YAML parsing, read `buffer.versions` for history
- [ ] `useNoteOperations.ts` — meta mutations via typed object, not `setYamlField`
- [ ] Asset paste handlers — use `AssetDTO.externalRef`
- [ ] `aiContextBuilder.ts` — use `buffer.body` directly from cache
- [ ] Delete `lib/markdown.ts`, clean `lib/fmUtils.ts`

---

## Key Decisions Already Made

**Type hierarchy:**
```
Storable
  └── MetaStorable       (adds meta map[string]string)
        ├── Buffer        (WorkingCopy, DocumentMeta contract)
        └── Note          (Library, DocumentMeta contract)
  └── AssetStorable      (adds Encoding, inferred from bytes)
  └── FolderStorable     (adds Owns)
```

**Category:** three fields — Go constant (`State`), `Key` used by backends (`"config"`), `DisplayName` for UI (`"State"`). `Key` is how FileStore resolves paths. No `Folder` field — that would couple Category to the filesystem.

**Categories:**
```go
Library     = Category{Key: "store",   DisplayName: "Library",      Isolation: Shared}
WorkingCopy = Category{Key: "buffers", DisplayName: "Working Copy", Isolation: Isolated}
State       = Category{Key: "config",  DisplayName: "State",        Isolation: Isolated}
```

**State migration:** `settings.json` and `session.json` currently live at `{hostname}/`. Must be moved to `{hostname}/config/` before first run. One-time manual migration.

**DocumentMeta:** shared between Buffer and Note. `status` is read-only pass-through (backward compat). `version` is read-only (Store stamps it). Full raw map travels to frontend as `meta.all`.

**Wails bridge:** JSON serialisation. DTOs use camelCase json tags. `DocumentMetaDTO` has typed fields + `All map[string]string` carrying every key.

**Assets:** `AssetService.Save(category, key, data)` — three parameters, nothing more. Asset is a first-class Storable, exists independently. Ownership is derived by FileStore (filesystem scan or sidecar). ExternalRef is stamped by Store at Create time — business layer never computes paths.

**Version history:** refs travel with the loaded document (`Storable.Versions()`). No separate list binding. `GetDocumentVersion(path, ref)` retrieves a snapshot. `VersionedStorable` is Ref + Body + Meta + Owns — untyped by design (a Buffer filed as a Note has history spanning both states).

**Paste flow (verified clean):**
```typescript
const asset = await SaveAsset(buffer.path, id, base64Data)
editor.commands.insertContent(`![](${asset.externalRef})`)
```
`externalRef` is opaque — whatever the Store decided. No path computation in business layer or frontend.

---

## What Gets Deleted

| Old | Replaced by |
|---|---|
| `stash/history.go` | `store/filestore/version.go` |
| `stash/store.go` `Open()` | `filestore.NewFileStore(root, hostname)` |
| `buffer.go` direct file ops | `BufferService` + `FileStore` |
| `notes.go` `ExtractFromFm` etc. | `meta.Get(...)` on loaded `MetaStorable` |
| `app.go` `splitFrontmatter`, `resolvePath`, `SaveVersionSnapshot` | removed |
| `lib/markdown.ts` `splitFrontmatter` | `LoadBuffer` returns body already clean |
| `lib/fmUtils.ts` `parseMeta`, `setYamlField`, `bumpFm`, `assetMarkdownPath` | typed meta object + Store |

---

## Start Here

Read `docs/architecture-persistence-plan.md` in full. Then start Phase 1 — create the `store/` package with the four interface files. Nothing in the app changes in Phase 1.
