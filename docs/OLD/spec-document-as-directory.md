# Specification: Document-as-Directory Store Structure

## 1. The Core Problem

The current store conflates two distinct concerns into a single file:

```
store/notes/kubernetes/k8s-ingress-fix.md
```

This file contains both the markdown body **and** YAML frontmatter metadata (UUID, focus_count, tags, status, ai_last_evaluated, etc.). Because they live together:

- Any metadata change — a focus count increment, an AI tag update, `ai_last_evaluated` — writes the file and creates a version snapshot
- Version history is polluted with metadata-only changes; the signal is meaningless
- Rename or move requires cascading to assets in `store/assets/` and rewriting content references
- Derived data (session summaries, rich link cache) has no natural home
- The editor must strip frontmatter on load and re-prepend on save — a fragile contract

This spec resolves all of these by separating identity, metadata, content, and derived data into distinct files within a document directory.

---

## 2. New Structure

Every node in the store — folder or document — is a directory with a `.meta` file. The `.meta` file carries the UUID and all structured metadata. Content lives separately.

```
store/
├── notes/
│   ├── .meta                              ← root "notes" folder identity
│   └── kubernetes/
│       ├── .meta                          ← folder identity
│       └── k8s-ingress-fix/
│           ├── .meta                      ← document identity + all metadata
│           ├── abc123.md                  ← pure markdown content, no frontmatter
│           ├── abc123-blk-a3f9.png       ← assets, UUID-prefixed, co-located
│           ├── .history/                  ← content-only snapshots
│           │   ├── abc123.1.md
│           │   ├── abc123.2.md
│           │   └── abc123.12.md
│           └── .cache/                    ← derived, non-authoritative data
│               ├── sessions.json
│               └── links.json
│
└── {hostname}/
    ├── .meta                              ← host node identity
    ├── settings.json
    ├── session.json
    └── buffers/
        └── buf-20260411-1023/
            ├── .meta
            ├── def456.md
            └── .history/
```

---

## 3. The `.meta` File

Every directory — folder or document — contains a `.meta` file. Its presence marks the directory as a Sieve-managed node. Its absence means the directory is not part of the store.

`.meta` is JSON. Two shapes: folder and document.

### Folder `.meta`

```json
{
  "uuid": "fold-abc123",
  "type": "folder",
  "created": "2026-04-11T10:00:00Z"
}
```

### Document `.meta`

```json
{
  "uuid": "doc-abc123",
  "type": "document",
  "status": "filed",
  "version": 12,
  "focus_count": 4,
  "user_intent": null,
  "ai_eval": "complete",
  "ai_last_evaluated": "2026-05-01T14:30:00Z",
  "ai_folder_suggestion": "kubernetes",
  "summary": "Ingress annotation fix for websocket timeout handling",
  "tags": ["kubernetes", "networking", "ingress", "websocket"],
  "created": "2026-04-11T10:23:00Z",
  "modified": "2026-05-01T14:30:00Z",
  "cli": "claude-sonnet-4-6",
  "names": [
    { "name": "random-thought",  "from": "2026-04-11T10:23:00Z" },
    { "name": "websocket-issue", "from": "2026-04-15T09:10:00Z" },
    { "name": "k8s-ingress-fix", "from": "2026-05-01T14:30:00Z" }
  ]
}
```

`version` in `.meta` tracks content versions only — it increments when `abc123.md` is saved, not when `.meta` is updated. Focus count, tag updates, AI evaluations, and renames do not bump version.

`names` is an append-only log of every friendly name the document has held, with the timestamp it took that name. The first entry is always the original name at creation. Renames append to this array via `SaveMeta` — no content change, no version bump. Old names are included in the search index, allowing documents to be found by names they no longer carry. The name history also shows how understanding of the content evolved over time.

---

## 4. Distinguishing Folders from Documents

A directory is a **document** if it contains a `.meta` file where `type === "document"`.
A directory is a **folder** if it contains a `.meta` file where `type === "folder"`.
A directory with no `.meta` file is not part of the store — ignored by all store operations.

This is unambiguous and requires no naming conventions or separate marker files.

---

## 5. Two Distinct Save Operations

The store interface gains a clean semantic split:

| Operation | Writes | Creates snapshot | Bumps version |
|-----------|--------|-----------------|---------------|
| `SaveContent(s)` | `abc123.md` | Yes | Yes |
| `SaveMeta(s)` | `.meta` | No | No |

Focus count increments, AI metadata updates, tag changes — all go through `SaveMeta`. Only actual content edits go through `SaveContent`. Version history becomes a pure record of content changes.

---

## 6. What This Fixes

### Version history is meaningful

Only content edits create snapshots. A one-hour editing session with 45 autosaves produces 45 content snapshots. Ten focus count increments produce zero. The version stream is signal, not noise.

### Session log noise is eliminated at the source

The session grouping algorithm (30-minute gap between saves) now operates on a clean stream of content-only saves. The `<10 character diff` filter is still useful as a safety net but is no longer the primary noise filter — metadata churn cannot reach the version stream.

### Frontmatter is gone

The editor receives pure markdown. No stripping on load, no re-prepending on save. The fragile frontmatter contract between the store and the editor is removed entirely. `SetBody` / `SetMeta` as separate operations on `MetaStorable` maps directly to `SaveContent` / `SaveMeta`.

### Rename and move are atomic

A rename is `mv k8s-ingress-fix/ new-name/`. Assets, history, cache, and `.meta` all travel in one filesystem operation. No content rewriting, no asset prefix updating, no cascade.

### Derived data has a home

`.cache/` inside the document directory holds session summaries, rich link metadata, and any future document-level derived data. It travels with the document. It is deleted with the document. No global index, no sync problem.

### Consistent identity model

Every node is UUID-identified via `.meta`. The filesystem path is a display label, not an identity. The frontend never references a path — only a UUID.

### Maps directly to a relational model

The file structure is isomorphic to a relational schema:

```sql
nodes    (uuid, parent_uuid, friendly_name, type, created)
meta     (uuid, status, version, focus_count, user_intent, ai_eval,
          ai_last_evaluated, summary, tags, modified, cli)
content  (uuid, body)
versions (uuid, version_number, body, created_at)
assets   (uuid, block_id, filename, encoding)
```

`FileStore` writes `.meta` and `abc123.md`. A future `DBStore` writes to these tables. The `store.Store` interface is unchanged. The separation is already in the file structure.

---

## 7. Asset URL Scheme

Assets are served via a stable UUID-based URL pattern:

```
/sieve/{uuid}/{block-id}.png
```

The asset server resolves the request by looking up the document UUID to find its directory, then serving the file from within it. The document's markdown content references this URL — never a filesystem path.

**Why this is the right model:**

- The URL encodes identity, not location. Rename or move the document — the UUID is stable, the URL is stable, the reference in the markdown never changes. No rewriting, ever.
- The asset server holds all path resolution intelligence. The document is clean.
- Debuggable and guessable — knowing a document's UUID is enough to construct any asset URL directly.

**Asset server logic (Go):**

```go
// GET /sieve/{uuid}/{filename}
func (h *AssetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    uuid := chi.URLParam(r, "uuid")
    filename := chi.URLParam(r, "filename")
    doc, err := h.store.LoadByUUID(uuid)
    if err != nil { http.NotFound(w, r); return }
    http.ServeFile(w, r, filepath.Join(doc.Dir(), filename))
}
```

**S3:** the same URL pattern, the asset server proxies from `s3://{bucket}/{uuid}/{filename}`. The content references are unchanged between FileStore and S3Store.

**Rich link card images** follow the same scheme — when a link is enriched and the image is downloaded to `.cache/`, it is referenced in the fenced JSON as:

```json
{ "image": "/sieve/abc123/richlink-blk-xyz.png" }
```

The URL is stable regardless of where the document lives on disk or in S3.

---

## 8. Store Interface Changes

The `store.Store` interface contract remains stable. `FileStore` implementation changes internally.

### New methods

```go
// SaveMeta writes only the metadata for s — no snapshot, no version bump.
SaveMeta(s MetaStorable) (MetaStorable, error)
```

`Save(s)` retains its existing semantics — saves both content and metadata, writes a snapshot, and bumps version. A content save must update `.meta` anyway (new version number, updated `modified` timestamp), so the two are naturally coupled. No existing callers need to change.

`SaveMeta` is additive — new callers that only need to update metadata (focus count, tags, AI evaluation results, renames) use it directly. It never touches the content file and never creates a snapshot.

### Changed implementations

| Method | Change |
|--------|--------|
| `Load` | Read `{dir}/.meta` + `{dir}/{uuid}.md` |
| `SaveContent` | Write `{dir}/{uuid}.md`, snapshot to `.history/`, increment version in `.meta` |
| `SaveMeta` | Write `{dir}/.meta` only |
| `Rename` | `mv {dir}/ {newname}/` |
| `Move` | `mv {dir}/ {target}/{dir}/` |
| `Delete` | `rm -rf {dir}/` |
| `List` | Scan for directories containing `.meta` |
| `CreateAsset` | Write to `{docdir}/{uuid}-{id}.ext` |

---

## 9. Migration from Current Structure

A one-time automated migration. Safe to run repeatedly — idempotent.

**For each `.md` file in `store/notes/**/*.md`:**

1. Read UUID and all frontmatter fields from the file
2. Create directory `{parent}/{filename-without-ext}/`
3. Write `.meta` from frontmatter fields
4. Write `{uuid}.md` containing the body only (frontmatter stripped)
5. Find assets in `store/assets/` prefixed with the document filename
6. Move each to `{docdir}/{uuid}-{block-id}.ext`, stripping the filename prefix
7. Update asset references in the body (one-time rewrite)
8. Find snapshots in `.history/` matching `{uuid}.*.md`
9. For each snapshot: strip frontmatter from body, write to `{docdir}/.history/{uuid}.N.md`
10. Move to `{docdir}/.history/`

**For each buffer in `store/{hostname}/buffers/*.md`:**

Same process. Buffer directory name is the creation timestamp name.

**Detection:** if any `store/notes/` subdirectory contains a `.meta` file, migration has already run. Skip.

---

## 10. Open Questions

- **Buffer naming:** the content file inside every buffer directory is `{uuid}.md` from the moment of creation — not a timestamp name. The buffer directory itself can retain a timestamp name (`buf-20260411-1023/`) for human readability in the filesystem, but the file inside is always UUID-named. This means filing is a pure directory rename — nothing inside the directory changes. The UUID was already the filename; it just gets a new parent directory with the friendly note name.

- **Folder nesting:** enable arbitrary nesting as part of this migration. The structure already supports it — folders are just directories with a `.meta` file, recursion is free. The frontend must be rewritten anyway to move from path-based to UUID-based folder references (`FolderStorable.Key()` returns UUID, not path). Inside that rewrite, handling `n` levels vs `1` is minimal marginal cost — a recursive tree render instead of a flat list. The one-level limit was a policy decision on the old structure, not a constraint worth carrying forward.

- **S3 atomicity:** S3 has no atomic rename. Moving a document directory on S3 requires copying all objects under the old prefix to the new prefix, then deleting the old. This is not atomic. A partial move leaves the document in two places. This is a known limitation of any S3-backed filesystem-like store — worth documenting but not a blocker.

- **`.meta` as the node discriminator:** the current `FolderStorable` is detected by directory structure. With `.meta` as the discriminator, the store must read `.meta` to determine node type during `List`. Acceptable cost — `.meta` is tiny.
