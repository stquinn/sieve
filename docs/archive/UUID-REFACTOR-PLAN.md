# UUID Refactor: Remove Paths from Bridge Interface

## Progress Checklist

### Go Side
- [x] **Step 1** `stash/session.go` — remove `Tab.Path`
- [x] **Step 2** `stash/note_service.go` — add `ID` to `NoteEntry`; add `NoteService.LoadByUUID`
- [x] **Step 3** `stash/buffer_service.go` — add `BufferService.LoadByUUID`
- [x] **Step 4** `stash/prompts.go` — add `ID` to `PromptEntry`
- [x] **Step 5** `app.go` — bridge changes:
  - Add `LoadByUUID(uuid string) (interface{}, error)`
  - `MoveNote(uuid, folderID string) (NoteDTO, error)`
  - Add `RenameNote(uuid, newName string) (NoteDTO, error)`
  - `DeleteNote(uuid string) error`
  - `RenameFolder(folderID, newName string) (string, error)` — returns new folderID
  - `CreateFolder(parentFolderID, name string) error`

### Frontend Side
- [x] **Step 6** `frontend/src/lib/fmUtils.ts` — replace `getAncestorPaths` with `getAncestorFolderIDs`
- [x] **Step 7** `frontend/src/lib/StorableDataService.ts` — `loadByID`, `move`, `rename`, `renameDoc`, `discard`, `createFolder`
- [x] **Step 8** `frontend/src/components/NoteContextMenu.tsx` — `path` → `id`+`name`+`isPrompt`
- [x] **Step 9** `frontend/src/components/Sidebar.tsx` — remove all path parsing/construction
- [x] **Step 10** `frontend/src/components/TabBar.tsx` — display/rename/delete via UUID+slug
- [x] **Step 11** `frontend/src/App.tsx` — session save/restore, openDoc, openFolders, ancestors

### Verify
- [x] Go and TS compile clean (both `go build` and `tsc --noEmit` pass)
- [ ] Move note to folder (drag/drop)
- [ ] Move note to root (drag to Library header)
- [ ] Rename note
- [ ] Rename folder (expansion state preserved)
- [ ] Delete note
- [ ] Create folder at root
- [ ] Session restore (close+reopen — tabs load by UUID; old sessions with path gracefully handled)

---

## Context / Root Cause

The frontend constructs full store-relative paths and passes them to bridge operations. Specifically, `MoveNote` is called with two full paths (e.g. `"store/sub/my-note.md"` and `"store/ai-stuff/my-note.md"`), but Go's bridge passes the second arg directly to `notes.Move(n, folder)` which expects only the bare folder name (`"ai-stuff"`). Result: a mangled key like `"store/ai-stuff/my-note.md/my-note"`.

Root cause: bridge methods accept path strings, forcing the frontend to construct them — incorrectly. Fix: remove paths from all operational bridge methods. Use UUID for note identity, opaque ID (ExternalRef — never parsed) for folder identity. Session stores UUID, restores via `LoadByUUID`. ExternalRef remains visible as a label only (ShowInFiles).

---

## Go Changes Detail

### `stash/session.go`
Remove `Path string` from Tab. Old sessions decode fine (JSON ignores unknown fields).

### `stash/note_service.go`
Add to `NoteEntry`:
```go
ID string `json:"id"` // UUID for files; ExternalRef for folders (opaque to frontend)
```
Populate in `buildNoteTree` (files: `ms.Meta()["uuid"]`, folders: `s.ExternalRef()`)
and `buildFolderChildren` (files only: `ms.Meta()["uuid"]`).

Add method:
```go
func (ns *NoteService) LoadByUUID(uuid string) (*Note, error)
// Scans Library storables for ms.Meta()["uuid"] == uuid
```

### `stash/buffer_service.go`
Add method:
```go
func (bs *BufferService) LoadByUUID(uuid string) (*Buffer, error)
// Scans WorkingCopy storables for ms.Meta()["uuid"] == uuid
```

### `stash/prompts.go`
Add to `PromptEntry`:
```go
ID string `json:"id"` // "prompt:" + Name
```
Set when building list.

### `app.go`

**Add `LoadByUUID`:**
```go
func (a *App) LoadByUUID(uuid string) (interface{}, error)
// if "prompt:" prefix → load prompt content → return PromptDTO equivalent
// try notes.LoadByUUID → toNoteDTO
// try buffers.LoadByUUID → toBufferDTO
```

**Change `MoveNote(path, targetFolder string)` → `MoveNote(uuid, folderID string)`:**
```go
folder := strings.TrimPrefix(folderID, Library.Key+"/")
if folder == Library.Key { folder = "" }  // "store" → root
n, _ := a.notes.LoadByUUID(uuid)
moved, _ := a.notes.Move(n, folder)
return toNoteDTO(moved), nil
```

**Add `RenameNote(uuid, newName string) (NoteDTO, error)`:**
```go
n, _ := a.notes.LoadByUUID(uuid)
renamed, _ := a.notes.Rename(n, newName)
return toNoteDTO(renamed), nil
```

**Change `DeleteNote(path string)` → `DeleteNote(uuid string)`:**
```go
n, _ := a.notes.LoadByUUID(uuid)
return a.notes.Delete(n)
```

**Change `RenameFolder(oldPath, newPath string)` → `RenameFolder(folderID, newName string) (string, error)`:**
```go
parent := filepath.ToSlash(filepath.Dir(folderID))
newPath := parent + "/" + newName
os.Rename(a.resolvePath(folderID), a.resolvePath(newPath))
return newPath, nil  // new folderID for openFolders update
```

**Change `CreateFolder(path string)` → `CreateFolder(parentFolderID, name string)`:**
```go
if parentFolderID == "" || parentFolderID == Library.Key {
    folderPath = Library.Key + "/" + name
} else {
    folderPath = parentFolderID + "/" + name
}
os.MkdirAll(a.resolvePath(folderPath), 0o755)
```

---

## Frontend Changes Detail

### `fmUtils.ts`
Replace `getAncestorPaths(path string)` with:
```typescript
export function getAncestorFolderIDs(noteID: string, entries: NoteEntry[]): string[] {
  function search(nodes: NoteEntry[], acc: string[]): string[] | null {
    for (const node of nodes) {
      if (node.isDir && node.children) {
        const found = search(node.children, [...acc, node.id!])
        if (found) return found
      } else if (node.id === noteID) return acc
    }
    return null
  }
  return search(entries, []) ?? []
}
```

### `StorableDataService.ts`
Key method changes:
- `loadByID(id)` — new, calls `LoadByUUID` or `LoadPrompt`
- `move(noteUUID, targetFolderID)` — calls `MoveNote(uuid, folderID)`, updates registry from returned DTO
- `rename(id, newName, isDir)` — dirs: `RenameFolder(id, newName)` returns new folderID; files: `RenameNote(id, newName)` updates registry path
- `renameDoc(id, newName, isDir)` — delegates to `rename()` directly, no path construction
- `discard(uuid)` — filed: `DeleteNote(uuid)`; buffer: `DiscardBuffer(doc.path)` (ExternalRef label, acceptable)
- `createFolder(parentFolderID, name)` — two args to `CreateFolder`

### `NoteContextMenu.tsx`
Props change: `path: string` → `id: string`, `name: string`, `path?: string` (ExternalRef only for ShowInFiles), `isPrompt?: boolean`.
Remove `path.startsWith('prompt:')` and `path.split(':').pop()`.

### `Sidebar.tsx`
Interface additions: `NoteEntry.id?: string`, `PromptEntry.id: string`.

ContextMenuState: `path: string` → `id: string`, `name: string`, `path?: string`, `isPrompt?: boolean`.

Removals:
- `path.split('/').pop()` → use `contextMenu.name`
- `path.substring(0, lastIndexOf('/'))` + concat for rename → call `renameDoc(id, newName, isDir)`
- `\`${parentPath || 'store'}/${name}\`` for createFolder → `createFolder(entry.id || '', name)`
- `oldPath.split('/').pop()` + path construction in drag/drop → `onMove(noteID, 'store')` or `onMove(noteID, entry.id!)`
- `path.startsWith('prompt:')` → `contextMenu.isPrompt`
- `activePath === \`prompt:${p.name}\`` → `activePath === p.id`

Prop renames: `openPaths → openIDs`, `activePath → activeID`.
Drag: `setData('text/plain', entry.id!)`. Drop: no path construction.

### `TabBar.tsx`
- Display: `doc.meta?.displayName || doc.slug` (no path parsing)
- Rename: `dataService.rename(tab.uuid, newName, false)` → `RenameNote`
- Delete: uses `doc.meta?.displayName || doc.slug` in dialog

### `App.tsx`
- Session save: no `path` field in tab objects
- Session restore: `dataService.loadByID(t.id)` not `load(t.path)`
- `openNote(id)` → `dataService.loadByID(id)`
- Remove `uuidToPath` ref
- `getAncestorPaths(path)` → `getAncestorFolderIDs(doc.id, notes)`
- Props: `activePath → activeID` (= `activeTab?.uuid`), `openPaths → openIDs` (= `new Set(tabs.map(t => t.uuid))`)
- `onRenameFolder(oldFolderID, newFolderID)` — swaps in openFolders set
- `onEditPrompt(promptID)` — uses `prompt.id` directly
