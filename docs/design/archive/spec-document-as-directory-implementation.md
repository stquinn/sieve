# Implementation Plan: Document-as-Directory FileStore Rewrite

Companion to `spec-document-as-directory.md`. This document captures what was learned from reading the existing FileStore implementation so the next coding session can start immediately without re-discovery.

---

## 1. What We Are Replacing

The current structure is a single `.md` file per document with YAML frontmatter:

```
store/notes/kubernetes/k8s-ingress-fix.md     ← frontmatter + body in one file
store/notes/.assets/k8s-ingress-fix-blk-a3f9.png  ← co-prefixed in shared .assets/
store/notes/.history/abc123.12.md             ← snapshots in category-level .history/
```

The new structure is:

```
store/notes/kubernetes/k8s-ingress-fix/
    .meta                                     ← JSON, all metadata
    abc123.md                                 ← pure body, no frontmatter
    abc123-blk-a3f9.png                       ← co-located asset
    .history/
        abc123.1.md
        abc123.12.md
    .cache/
        sessions.json
        links.json
```

---

## 2. Key Insight: What Actually Changes

Despite the structural change, the **Store interface is unchanged** (plus one additive method). All callers above the store layer are unaffected. The entire rewrite is contained within `store/filestore/`.

The five files that change:

| File | Change magnitude |
|------|-----------------|
| `filestore.go` | Heavy — path helpers, create, save, load, rename, move, delete |
| `graph.go` | Heavy — scan logic entirely rewritten for directory-as-document |
| `version.go` | Moderate — historyDir becomes per-document |
| `meta.go` | Replace — YAML frontmatter → JSON .meta |
| `storable.go` | Light — add `docDir()` helper, update `fileFolderStorable.Key()` |

---

## 3. New Path Model

### Current path model

```go
// Key: category-relative path to the .md file
// e.g. "kubernetes/k8s-ingress-fix.md"
func (fs *FileStore) absPath(cat store.Category, key string) string {
    return filepath.Join(fs.categoryDir(cat), filepath.FromSlash(key))
}
```

### New path model

A document's **key** becomes the directory name without extension:
- Old key: `"kubernetes/k8s-ingress-fix.md"`
- New key: `"kubernetes/k8s-ingress-fix"`

```go
// docDir returns the absolute path to the document directory.
func (fs *FileStore) docDir(cat store.Category, key string) string {
    return filepath.Join(fs.categoryDir(cat), filepath.FromSlash(key))
}

// metaPath returns the .meta file path for a document or folder.
func (fs *FileStore) metaPath(cat store.Category, key string) string {
    return filepath.Join(fs.docDir(cat, key), ".meta")
}

// contentPath returns the uuid.md content file path. UUID is read from .meta.
func (fs *FileStore) contentPath(cat store.Category, key string, uuid string) string {
    return filepath.Join(fs.docDir(cat, key), uuid+".md")
}

// historyDir is now per-document (not per-category).
func (fs *FileStore) historyDir(cat store.Category, key string) string {
    return filepath.Join(fs.docDir(cat, key), ".history")
}
```

**ExternalRef** changes: was `"store/kubernetes/k8s-ingress-fix.md"`, becomes `"store/kubernetes/k8s-ingress-fix"`. This is the UUID-stable reference used in editor content and AI prompts. Verify no callers hardcode the `.md` extension assumption.

---

## 4. The `.meta` JSON Schema

Replace `meta.go`'s YAML parsing with JSON read/write. The JSON struct:

```go
// docMeta is the on-disk JSON structure for a document .meta file.
type docMeta struct {
    UUID              string     `json:"uuid"`
    Type              string     `json:"type"`              // "document" or "folder"
    Status            string     `json:"status,omitempty"`
    Version           int        `json:"version"`
    FocusCount        int        `json:"focus_count,omitempty"`
    UserIntent        string     `json:"user_intent,omitempty"`
    AIEval            string     `json:"ai_eval,omitempty"`
    AILastEvaluated   string     `json:"ai_last_evaluated,omitempty"`
    AIFolderSuggestion string    `json:"ai_folder_suggestion,omitempty"`
    Summary           string     `json:"summary,omitempty"`
    Tags              []string   `json:"tags,omitempty"`
    Created           string     `json:"created"`
    Modified          string     `json:"modified"`
    CLI               string     `json:"cli,omitempty"`
    Names             []nameEntry `json:"names"`
}

type nameEntry struct {
    Name string `json:"name"`
    From string `json:"from"`
}

// folderMeta is the on-disk JSON structure for a folder .meta file.
type folderMeta struct {
    UUID    string `json:"uuid"`
    Type    string `json:"type"` // "folder"
    Created string `json:"created"`
}
```

The existing `map[string]string` meta type is used throughout the service layer. The bridge: `docMetaToMap(dm docMeta) map[string]string` and `mapToDocMeta(m map[string]string) docMeta`. This keeps the interface contract and all callers working without change.

**What `meta.go` currently does that we no longer need:**
- `parseFrontmatter` — delete
- `serialiseFrontmatter` — delete
- `canonicalKeyOrder` — delete (JSON handles ordering)
- `tryFuzzyRepair` — delete (JSON marshal/unmarshal is clean)
- `inferEncoding` — **keep** (still needed for asset type detection)

---

## 5. Store Interface Addition

Add one method to `store/interfaces.go`:

```go
// SaveMeta writes only the metadata for s — no snapshot, no version bump.
// Used for focus count increments, AI evaluation updates, tag changes, renames.
SaveMeta(s MetaStorable) (MetaStorable, error)
```

`Save(s)` keeps its exact existing semantics: writes body, writes .meta (bumping version), takes snapshot. No existing callers change.

---

## 6. Rewriting `filestore.go`

### 6.1 `createMeta` → directory creation

Old flow: write one `.md` file with frontmatter prepended.

New flow:
```
1. mkdir {docDir}
2. stampCreate(meta)              // same logic, stamps uuid/version/timestamps
3. names = [{name: keyBasename, from: created}]
4. writeMetaJSON(metaPath, meta)  // replaces serialiseFrontmatter
5. writeAtomic(contentPath, body) // pure body, no frontmatter
```

Key generation for buffers: the generated key has no `.md` extension now. Old: `"buffers-20240102-1504.md"`. New: `"buffers-20240102-1504"` (the content file inside is `{uuid}.md`).

### 6.2 `Load`

Old flow: `os.ReadFile(absPath)` → `parseFrontmatter`.

New flow:
```go
func (fs *FileStore) Load(cat store.Category, key string) (store.Storable, error) {
    dm, err := fs.readMetaJSON(cat, key)         // read .meta
    if err != nil { ... }
    body, err := os.ReadFile(fs.contentPath(cat, key, dm.UUID))
    if err != nil { ... }
    versions := fs.loadVersions(cat, key, dm.UUID)
    // build fileMetaStorable from dm + body + versions
}
```

`readMetaJSON` reads `.meta`, JSON-unmarshals to `docMeta`, converts to `map[string]string` via bridge function.

### 6.3 `saveMeta` (existing internal Save for MetaStorable) → renamed `saveContent`

The **existing internal `saveMeta` function** (not the new public `SaveMeta`) handles `Save()` calls. Rename it `saveContent` internally for clarity. Changes:

```
1. Read .meta for optimistic lock (dm.Version vs incoming)
2. Increment version, update modified timestamp in meta map
3. writeAtomic(contentPath, body)        // write pure body
4. writeMetaJSON(metaPath, meta)         // write .meta separately
5. writeSnapshot(historyDir, uuid, ver, body)   // snapshot is body-only now
6. pruneVersions
```

**Snapshot content changes**: currently snapshots contain `frontmatter + body`. In the new model, snapshots are **body only** (pure markdown). Simpler to restore; `.meta` always reflects current metadata state.

### 6.4 New public `SaveMeta`

```go
func (fs *FileStore) SaveMeta(s store.MetaStorable) (store.MetaStorable, error) {
    key := s.Key()
    meta := s.Meta()
    // No optimistic lock on version (version doesn't change)
    // No version increment
    // No snapshot
    writeMetaJSON(fs.metaPath(s.Category(), key), meta)
    // Return updated storable
}
```

### 6.5 `Delete`

Old: `os.Remove(absPath)` + `deleteAllVersions`.

New:
```go
func (fs *FileStore) Delete(s store.Storable) error {
    return os.RemoveAll(fs.docDir(s.Category(), s.Key()))
    // .history, .cache, assets all deleted in one call
    // cascadeAssetUpdates is entirely gone — no separate asset cleanup needed
}
```

### 6.6 `Rename` (FileStore method)

Old: complex `renameKey` with `cascadeAssetUpdates` for body reference rewriting + asset rename.

New:
```go
func (fs *FileStore) Rename(s store.Storable, name string) (store.Storable, error) {
    dir := filepath.Dir(s.Key())
    var newKey string
    if dir == "." { newKey = name } else { newKey = dir + "/" + name }

    srcDir := fs.docDir(s.Category(), s.Key())
    dstDir := fs.docDir(s.Category(), newKey)
    if err := os.Rename(srcDir, dstDir); err != nil { ... }

    // Append name entry to .meta names array — no body change
    dm, _ := fs.readMetaJSONFromDir(dstDir)
    dm.Names = append(dm.Names, nameEntry{Name: name, From: time.Now().Format(...)})
    writeMetaJSONToDir(dstDir, dm)

    return fs.Load(s.Category(), newKey)
}
```

`cascadeAssetUpdates` is **deleted entirely**. The asset URL scheme (`/sieve/{uuid}/{filename}`) means asset references in body content never contain paths — they contain UUIDs. Nothing to rewrite on rename.

### 6.7 `Move` (category change: buffer → library on file)

Old: complex write + `cascadeAssetUpdates` + `migrateHistory`.

New:
```go
func (fs *FileStore) Move(s store.Storable, to store.Category) (store.Storable, error) {
    srcDir := fs.docDir(s.Category(), s.Key())
    dstDir := fs.docDir(to, s.Key())
    if err := os.MkdirAll(filepath.Dir(dstDir), 0o755); err != nil { ... }
    if err := os.Rename(srcDir, dstDir); err != nil { ... }
    return fs.Load(to, s.Key())
    // .history travels with the directory — migrateHistory is gone
    // assets travel with the directory — cascadeAssetUpdates is gone
}
```

### 6.8 `Reparent` and `MoveToKey`

Both become directory renames. Same simplification as `Move`.

### 6.9 `CreateAsset`

Old: `generateAssetKey` creates `.assets/{noteName}-{assetID}.png` in a shared `.assets/` dir, prefixing with the document name to avoid collisions.

New: assets are co-located inside the document directory — already namespaced, no prefix needed. The frontend passes a bare ID (`blk-abc123`, `img-xyz`, etc.); the store appends the correct extension by sniffing the bytes.

```go
func (fs *FileStore) CreateAsset(cat store.Category, parentKey string, assetID string, body []byte) (store.AssetStorable, error) {
    ext := extFromBytes(body)   // sniff magic bytes → ".png", ".jpg", ".webp", ".gif", etc.
    filename := assetID + ext
    assetPath := filepath.Join(fs.docDir(cat, parentKey), filename)
    os.WriteFile(assetPath, body, 0o644)
    // key: parentKey + "/" + filename
    // extRef: /sieve/{docUUID}/{filename}  (stable URL, not filesystem path)
}

// extFromBytes sniffs the MIME type from magic bytes and returns the canonical extension.
// Falls back to ".bin" for unrecognised types.
func extFromBytes(b []byte) string {
    mime := http.DetectContentType(b)  // stdlib, reads first 512 bytes
    switch mime {
    case "image/png":  return ".png"
    case "image/jpeg": return ".jpg"
    case "image/gif":  return ".gif"
    case "image/webp": return ".webp"
    default:           return ".bin"
    }
}
```

`inferEncoding` (current magic-byte sniffer) already does this — consolidate into `extFromBytes` and drop `inferEncoding`.
```

`generateAssetKey` and `syncOwnsToMeta` are **deleted** — assets are co-located, no collision avoidance needed, no separate `meta["assets"]` list. The document directory IS the asset list.

### 6.10 `PrepareCategory`

Old: creates `categoryDir`, `.assets/`, `.history/`.

New: creates only `categoryDir`. No shared `.assets/` or `.history/` — those are per-document.

---

## 7. Rewriting `graph.go`

### 7.1 `scanCategory` — node type detection

Old: `info.IsDir()` → `scanFolder` (a directory is a folder); `info.Name()` ends in `.md` → document.

New: every directory entry is a potential node. Read `.meta` to determine type.

```go
func (fs *FileStore) scanCategory(cat store.Category, prefix string) ([]store.Storable, error) {
    root := fs.categoryDir(cat)
    infos, _ := os.ReadDir(root)
    var results []store.Storable
    for _, info := range infos {
        if !info.IsDir() { continue }  // only directories are nodes now
        name := info.Name()
        if strings.HasPrefix(name, ".") { continue }  // skip .history, .cache, etc.

        metaPath := filepath.Join(root, name, ".meta")
        dm, err := readMetaJSONFromPath(metaPath)
        if err != nil { continue }  // no .meta = not a Sieve node, skip

        switch dm.Type {
        case "folder":
            folder, _ := fs.scanFolderNode(cat, name)
            results = append(results, folder)
            results = append(results, folder.Owns()...)
        case "document":
            s := fs.buildDocStorable(cat, name, dm, true)
            if s != nil { results = append(results, s) }
        }
    }
    // sort by key
    return results, nil
}
```

### 7.2 `scanFolder` — now recursive

Old: `if info.IsDir() { continue }` — skipped subdirectories entirely.

New: if a subdirectory contains `.meta` with `type=folder`, recurse into it.

```go
func (fs *FileStore) scanFolderNode(cat store.Category, dirKey string) (*fileFolderStorable, error) {
    dirPath := filepath.Join(fs.categoryDir(cat), dirKey)
    dm, _ := readMetaJSONFromPath(filepath.Join(dirPath, ".meta"))

    var owns []store.Storable
    infos, _ := os.ReadDir(dirPath)
    for _, info := range infos {
        if !info.IsDir() { continue }
        name := info.Name()
        if strings.HasPrefix(name, ".") { continue }

        childKey := dirKey + "/" + name
        childMetaPath := filepath.Join(dirPath, name, ".meta")
        childDM, err := readMetaJSONFromPath(childMetaPath)
        if err != nil { continue }

        switch childDM.Type {
        case "document":
            s := fs.buildDocStorable(cat, childKey, childDM, false)
            if s != nil { owns = append(owns, s) }
        case "folder":
            sub, _ := fs.scanFolderNode(cat, childKey)
            if sub != nil { owns = append(owns, sub) }
        }
    }

    return &fileFolderStorable{
        fileStorable: fileStorable{
            key:      dm.UUID,  // Key() returns UUID now, not path
            category: cat,
            extRef:   fs.externalRef(cat, dirKey),
        },
        dirKey: dirKey,  // add field: filesystem path (display only)
        owns:   owns,
    }, nil
}
```

### 7.3 `buildStorable` → `buildDocStorable`

Old: reads one file, calls `parseFrontmatter`.

New: takes pre-read `docMeta` (from `.meta`), reads `{uuid}.md` for body, loads versions from `{docDir}/.history/`.

```go
func (fs *FileStore) buildDocStorable(cat store.Category, key string, dm *docMeta, withVersions bool) store.Storable {
    body, err := os.ReadFile(fs.contentPath(cat, key, dm.UUID))
    if err != nil { body = []byte{} }  // document exists but body file missing

    var versions []store.VersionRef
    if withVersions {
        versions = fs.loadVersions(cat, key, dm.UUID)
    }

    meta := docMetaToMap(dm)
    return &fileMetaStorable{
        fileStorable: fileStorable{
            key:      key,
            category: cat,
            body:     body,
            extRef:   fs.externalRef(cat, key),
            versions: versions,
        },
        meta: meta,
    }
}
```

### 7.4 `isAssetKey` — deleted

Asset keys are now files inside a document directory (not in a shared `.assets/` dir). Assets are not surfaced in `List` results — they are loaded on-demand via the asset handler. Remove `isAssetKey` and all callers.

---

## 8. Rewriting `version.go`

### 8.1 `historyDir` — per-document

Old signature: `historyDir(cat store.Category) string`

New signature: `historyDir(cat store.Category, key string) string`

```go
func (fs *FileStore) historyDir(cat store.Category, key string) string {
    return filepath.Join(fs.docDir(cat, key), ".history")
}
```

Update all callers: `writeSnapshot`, `loadVersions`, `pruneVersions`, `deleteAllVersions`. All take `key` as an additional parameter.

### 8.2 Snapshot content — body only

Old: snapshots contain `frontmatter + body` (the full file content).

New: snapshots contain pure markdown body only. No frontmatter to strip/re-add on restore.

`writeSnapshot` writes `body []byte` (not `content []byte`). `retrieveVersion` returns the body directly — no `parseFrontmatter` call needed.

### 8.3 `migrateHistory` — deleted

History is co-located in the document directory. `os.Rename` on the directory moves history automatically. `migrateHistory` is unreachable and deleted.

---

## 9. Changes to `storable.go`

### 9.1 `fileFolderStorable` — add `dirKey` field

`Key()` currently returns the directory name (the filesystem path segment). After the rewrite, `Key()` must return the UUID (for the frontend's UUID-based references). The directory path is still needed for filesystem operations.

```go
type fileFolderStorable struct {
    fileStorable        // key = UUID (from .meta), extRef set normally
    dirKey string       // filesystem path relative to categoryDir (display/ops only)
    owns   []store.Storable
}

func (s *fileFolderStorable) Key() string { return s.fileStorable.key }   // UUID
func (s *fileFolderStorable) DirKey() string { return s.dirKey }          // path
```

All internal FileStore filesystem operations use `dirKey` (or a new `docDirFromDirKey` helper). All external-facing operations (responses to service layer) use `Key()` which returns UUID.

**Note**: this is the change that decouples the frontend from paths — `FolderStorable.Key()` returning UUID is the contract the frontend depends on for UUID-based folder references.

### 9.2 `fileMetaStorable` — remove `owns` for assets

The `owns []store.Storable` field in `fileMetaStorable` is currently used to track asset ownership for `meta["assets"]` serialization. In the new model, assets are files in the document directory — no ownership list needed.

`AttachAsset`, `ClearOwns`, `syncOwnsToMeta` can be removed or kept as no-ops for interface compatibility. Keep the interface methods as no-ops initially — remove in a follow-up once all callers are audited.

---

## 10. New: Asset HTTP Handler

Add `GET /sieve/{uuid}/{filename}` to `handlers.go`:

```go
// In handlers.go:
r.Get("/sieve/{uuid}/{filename}", handlers.AssetByUUID)

// In requesthandlers/assets.go:
func (h *AssetHandler) ServeByUUID(w http.ResponseWriter, r *http.Request) {
    uuid := chi.URLParam(r, "uuid")
    filename := chi.URLParam(r, "filename")

    // Look up document directory by UUID
    doc, err := h.store.LoadByUUID(uuid)   // new store method (see below)
    if err != nil { http.NotFound(w, r); return }

    assetPath := filepath.Join(doc.DocDir(), filename)
    http.ServeFile(w, r, assetPath)
}
```

`LoadByUUID` is **not** a scan — it reads from an in-memory UUID→dirKey index maintained on `FileStore`. A full scan on every asset request is O(n) `.meta` reads; a note with 5 images fires 5 parallel scans. The index makes every lookup O(1) with zero I/O.

### UUID index on FileStore

```go
type FileStore struct {
    root        string
    hostname    string
    maxVersions int
    indexMu     sync.RWMutex
    uuidIndex   map[string]uuidEntry  // uuid → {cat, dirKey}
}

type uuidEntry struct {
    cat    store.Category
    dirKey string  // category-relative directory path
}
```

**Population:** `scanCategory` already reads every `.meta` — register each document UUID as a side effect at zero extra I/O cost.

```go
// called inside scanCategory whenever a document .meta is read:
fs.indexMu.Lock()
fs.uuidIndex[dm.UUID] = uuidEntry{cat: cat, dirKey: dirKey}
fs.indexMu.Unlock()
```

**Invalidation:** single-entry updates on every mutating operation — no full rebuild needed.

| Operation | Index update |
|-----------|-------------|
| `createMeta` | add `uuid → {cat, newKey}` |
| `Rename` | update `dirKey` for uuid |
| `Move` | update `cat` + `dirKey` for uuid |
| `Delete` | delete entry for uuid |

**Asset handler with index:**

```go
func (h *AssetHandler) ServeByUUID(w http.ResponseWriter, r *http.Request) {
    uuid := chi.URLParam(r, "uuid")
    filename := chi.URLParam(r, "filename")

    entry, ok := h.fileStore.LookupUUID(uuid)
    if !ok { http.NotFound(w, r); return }

    assetPath := filepath.Join(h.fileStore.docDir(entry.cat, entry.dirKey), filename)
    http.ServeFile(w, r, assetPath)
}
```

`LookupUUID` is a simple RLock + map read. No disk I/O after the first `List` call warms the index.

On a cache miss (index not yet warmed, or a bug left an entry unregistered) fall back to a full scan and register the result before returning — so the miss only happens once:

```go
func (fs *FileStore) LookupUUID(uuid string) (uuidEntry, bool) {
    fs.indexMu.RLock()
    entry, ok := fs.uuidIndex[uuid]
    fs.indexMu.RUnlock()
    if ok { return entry, true }

    // Cache miss — scan all categories, register everything found, return if matched.
    // Should not happen in normal operation; logged as a warning.
    logger.Warn("filestore: UUID index miss for %s — scanning", uuid)
    fs.rebuildIndex()

    fs.indexMu.RLock()
    entry, ok = fs.uuidIndex[uuid]
    fs.indexMu.RUnlock()
    return entry, ok
}
```

`rebuildIndex` calls `scanCategory` across all categories (which populates the index as a side effect). After the rebuild, a second map read either finds the UUID or confirms it genuinely does not exist.

**`DocDir()` on MetaStorable**: not needed for the asset handler given the index approach. The handler goes directly through `fileStore.docDir(entry.cat, entry.dirKey)` without loading a Storable at all.

---

## 11. Store Marker File

Every store root contains a `{root}/.sieve` file. Its presence is the authoritative declaration of what the store is and whether it is healthy. `NewFileStore` reads this file before doing anything else.

```json
{
  "version": 1,
  "created": "2026-05-03T10:00:00Z",
  "migration": "complete"
}
```

### `migration` states

| Value | Meaning |
|-------|---------|
| `"complete"` | Store is at `version` and fully consistent |
| `"pending"` | Written immediately before migration starts — store is pre-migration |
| `"partial"` | Written if migration was interrupted — store is inconsistent, must not be opened |

### `NewFileStore` startup logic

```go
marker, err := fs.readStoreMarker()
if os.IsNotExist(err) {
    // Brand-new store — write marker and proceed.
    fs.writeStoreMarker(storeMeta{Version: currentStoreVersion, Migration: "complete"})
    return fs, nil
}
if marker.Migration == "partial" {
    return nil, fmt.Errorf("filestore: store at %s has a partial migration — run the migration tool to recover", root)
}
if marker.Version < currentStoreVersion {
    if err := fs.runMigrations(marker.Version); err != nil {
        return nil, err
    }
}
```

### Migration write fence

```go
func (fs *FileStore) RunMigrationIfNeeded() error {
    marker, _ := fs.readStoreMarker()
    if marker.Migration == "complete" && marker.Version == currentStoreVersion {
        return nil
    }
    // Mark as in-progress before touching any files.
    fs.writeStoreMarker(storeMeta{Version: marker.Version, Migration: "partial"})

    if err := fs.runDocumentMigration(); err != nil {
        // Leave as "partial" — startup will refuse and surface the error.
        return err
    }

    // Stamp complete only after all documents have been migrated.
    fs.writeStoreMarker(storeMeta{Version: currentStoreVersion, Migration: "complete"})
    return nil
}
```

If the process crashes between `"partial"` and `"complete"`, the next startup refuses to open the store and surfaces a clear error rather than silently operating on a half-migrated structure. The migration is idempotent — re-running it on a partial store is safe (already-migrated directories are skipped because they contain no `.md` file at their root).

`needsMigration()` and its heuristic glob are deleted — the marker is the only source of truth.

---

## 12. In-App Migration Tool
```

### Per-document migration

```go
func (fs *FileStore) migrateDocument(cat store.Category, mdPath string) error {
    // 1. Read file, parse YAML frontmatter
    data, _ := os.ReadFile(mdPath)
    meta, body, _ := parseFrontmatter(data)  // use the OLD parseFrontmatter

    uuid := meta["uuid"]
    name := strings.TrimSuffix(filepath.Base(mdPath), ".md")
    docDir := filepath.Join(filepath.Dir(mdPath), name)

    // 2. Create document directory
    os.MkdirAll(docDir, 0o755)

    // 3. Write .meta
    dm := mapToDocMeta(meta)
    dm.Type = "document"
    dm.Names = []nameEntry{{Name: name, From: dm.Created}}
    writeMetaJSONToDir(docDir, dm)

    // 4. Write {uuid}.md (body only, no frontmatter)
    writeAtomic(filepath.Join(docDir, uuid+".md"), body)

    // 5. Find and move assets from shared .assets/
    assetsDir := filepath.Join(fs.categoryDir(cat), ".assets")
    pattern := filepath.Join(assetsDir, name+"-*.png")
    matches, _ := filepath.Glob(pattern)
    newBody := body
    for _, assetPath := range matches {
        base := filepath.Base(assetPath)
        // Strip name prefix: "k8s-ingress-fix-blk-abc.png" → uuid + "-blk-abc.png"
        suffix := strings.TrimPrefix(base, name+"-")
        newFilename := uuid + "-" + suffix
        os.Rename(assetPath, filepath.Join(docDir, newFilename))

        // Update body references: old ExternalRef → new /sieve/{uuid}/{newFilename}
        oldRef := cat.Key + "/.assets/" + base
        newRef := "/sieve/" + uuid + "/" + newFilename
        newBody = bytes.ReplaceAll(newBody, []byte(oldRef), []byte(newRef))
    }
    if !bytes.Equal(newBody, body) {
        writeAtomic(filepath.Join(docDir, uuid+".md"), newBody)
    }

    // 6. Move snapshots from category .history/ to docDir/.history/
    histSrc := filepath.Join(fs.categoryDir(cat), ".history")
    histDst := filepath.Join(docDir, ".history")
    os.MkdirAll(histDst, 0o755)
    snapPattern := filepath.Join(histSrc, uuid+".*.md")
    snapMatches, _ := filepath.Glob(snapPattern)
    for _, snap := range snapMatches {
        // Strip frontmatter from snapshot body
        snapData, _ := os.ReadFile(snap)
        _, snapBody, err := parseFrontmatter(snapData)
        if err != nil { snapBody = snapData }  // best-effort: use raw data
        dst := filepath.Join(histDst, filepath.Base(snap))
        os.WriteFile(dst, snapBody, 0o644)
    }

    // 7. Remove original .md file (only after successful directory creation)
    os.Remove(mdPath)
    return nil
}
```

### Migration runner (startup hook)

```go
func (fs *FileStore) RunMigrationIfNeeded() error {
    if !fs.needsMigration() { return nil }
    logger.Info("filestore: running document-as-directory migration")

    for _, cat := range migratedCategories {
        matches, _ := filepath.Glob(filepath.Join(fs.categoryDir(cat), "*.md"))
        for _, m := range matches {
            if err := fs.migrateDocument(cat, m); err != nil {
                logger.Error("migration failed for %s: %v", m, err)
                // Continue — partial migration is recoverable
            }
        }
        // Recurse into subdirectories (folders)
        infos, _ := os.ReadDir(fs.categoryDir(cat))
        for _, info := range infos {
            if !info.IsDir() { continue }
            if strings.HasPrefix(info.Name(), ".") { continue }
            subMatches, _ := filepath.Glob(filepath.Join(fs.categoryDir(cat), info.Name(), "*.md"))
            for _, m := range subMatches {
                fs.migrateDocument(cat, m)
            }
        }
    }
    logger.Info("filestore: migration complete")
    return nil
}
```

Called from `NewFileStore` or from `app.go` startup:
```go
if err := fileStore.RunMigrationIfNeeded(); err != nil {
    logger.Error("migration error: %v", err)
}
```

---

## 13. Things to Watch During Implementation

### `currentVersion` — optimistic lock

Currently reads and parses the `.md` file to extract `version`. New implementation reads `.meta` JSON:

```go
func (fs *FileStore) currentVersion(cat store.Category, key string) (int, error) {
    dm, err := fs.readMetaJSON(cat, key)
    if err != nil { return -1, err }
    return dm.Version, nil
}
```

### `externalRef` — still path-based

The `ExternalRef` of a document is still a category-relative path (e.g. `"store/kubernetes/k8s-ingress-fix"`). This is what the AI CLI receives and what the editor uses for document references. The key change: no `.md` extension. Verify all callers that use `ExternalRef` don't append `.md` or make extension assumptions.

### `generateKey` for buffers

Old: `"buffers-20240102-1504.md"` — includes `.md` because buffers were single files.

New: `"buf-20240102-1504"` — directory name, content file inside is `{uuid}.md`. The existing `generateKey` logic (timestamp + collision avoidance) is kept; just remove the `.md` suffix.

### `PrepareCategory` — simplification

Old: creates `categoryDir`, `.assets/`, `.history/`.

New: creates only `categoryDir` (and optionally a `.meta` for the category root node). The category `.meta` file marks the root as a Sieve-managed folder with `type: "folder"`.

### Service layer: `meta["assets"]` field

Several service-layer call sites read `meta["assets"]` to list document assets. After migration, this field is no longer written (assets are discovered by scanning the document directory). Audit these callers and replace with a `store.LoadAssets(s MetaStorable)` call or an in-memory scan. This is the main cross-cutting caller change above the store boundary.

Search for: `meta["assets"]` and `ms.Owns()` in `sieve/` and `requesthandlers/`.

---

## 14. Suggested Implementation Order

1. **Write store marker** — `storeMeta` struct, `readStoreMarker`, `writeStoreMarker`, startup logic in `NewFileStore`.
2. **Write new `meta.go`** — `docMeta` struct, `readMetaJSON`, `writeMetaJSON`, `docMetaToMap`, `mapToDocMeta`. Parallel with old `meta.go` initially.
3. **Write new path helpers** — `docDir`, `metaPath`, `contentPath`, updated `historyDir(cat, key)`.
4. **Rewrite `Load`** — new path model, reads `.meta` + `{uuid}.md`.
5. **Rewrite `createMeta`** — writes directory + `.meta` + `{uuid}.md`.
6. **Rewrite `saveMeta`→`saveContent`** — writes `.meta` + `{uuid}.md` + snapshot (body-only).
7. **Add `SaveMeta`** — writes `.meta` only, no snapshot.
8. **Rewrite `Delete`** — `os.RemoveAll(docDir)`.
9. **Rewrite `Rename`/`Move`/`Reparent`/`MoveToKey`** — `os.Rename(srcDir, dstDir)`, delete `cascadeAssetUpdates`, `migrateHistory`.
10. **Rewrite `graph.go`** — `.meta`-based node detection, recursive scan, `buildDocStorable`, UUID index population.
11. **Update `version.go`** — `historyDir(cat, key)`, body-only snapshots.
12. **Add asset HTTP handler** — `/sieve/{uuid}/{filename}`, `LookupUUID` with index + scan fallback.
13. **Write migration tool** — `RunMigrationIfNeeded`, `migrateDocument`, marker write-fence.
14. **Audit `meta["assets"]` callers** in service layer.
15. **Delete dead code** — `parseFrontmatter`, `serialiseFrontmatter`, `cascadeAssetUpdates`, `migrateHistory`, `syncOwnsToMeta`, `generateAssetKey`, `isAssetKey`, `tryFuzzyRepair`, `needsMigration`.
