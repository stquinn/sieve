package filestore_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"sieve/store"
	"sieve/store/filestore"
)

// testLibrary / testWorkingCopy mirror the business-layer category definitions.
// They are defined here rather than imported from sieve/ to avoid a circular
// dependency (sieve imports store; filestore is a sub-package of store).
var (
	testLibrary     = store.Category{Key: "store", DisplayName: "Library", Isolation: store.Shared}
	testWorkingCopy = store.Category{Key: "buffers", DisplayName: "Working Copy", Isolation: store.Isolated}
)

// ── helpers ───────────────────────────────────────────────────────────────────

func newTestStore(t *testing.T) *filestore.FileStore {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	fs.PrepareCategory(testLibrary)
	fs.PrepareCategory(testWorkingCopy)
	return fs
}

func mustCreate(t *testing.T, fs *filestore.FileStore, cat store.Category, key string, body []byte) store.Storable {
	t.Helper()
	s, err := fs.CreateMetaText(cat, key, body)
	if err != nil {
		t.Fatalf("CreateMetaText(%s, %q): %v", cat.Key, key, err)
	}
	return s
}

// contentTypes is every content-bearing .meta type with the extension its content
// file and snapshots must carry on disk.
var contentTypes = []struct{ contentType, ext string }{
	{store.TypeDocument, ".md"},
	{store.TypeBlock, ".block"},
}

// mustCreateTyped creates a storable of contentType with body held verbatim.
func mustCreateTyped(t *testing.T, fs *filestore.FileStore, cat store.Category, key, contentType string, body []byte) store.MetaStorable {
	t.Helper()
	ms, err := fs.CreateTyped(cat, key, contentType, map[string]string{store.MetaKeyKind: "test-kind"}, body)
	if err != nil {
		t.Fatalf("CreateTyped(%s, %q, %s): %v", cat.Key, key, contentType, err)
	}
	return ms
}

// ── PrepareCategory ───────────────────────────────────────────────────────────

func TestPrepareCategoryCreatesDirectories(t *testing.T) {
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "host1")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	if err := fs.PrepareCategory(testLibrary); err != nil {
		t.Fatalf("PrepareCategory(Library): %v", err)
	}
	if err := fs.PrepareCategory(testWorkingCopy); err != nil {
		t.Fatalf("PrepareCategory(WorkingCopy): %v", err)
	}

	required := []string{
		filepath.Join(dir, "store"),
		filepath.Join(dir, "host1", "buffers"),
	}
	for _, d := range required {
		if _, err := os.Stat(d); os.IsNotExist(err) {
			t.Errorf("expected directory to exist: %s", d)
		}
	}
}

// ── Create — MetaStorable ─────────────────────────────────────────────────────

func TestCreateBufferGeneratesKey(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "", nil)

	ms, ok := s.(store.MetaStorable)
	if !ok {
		t.Fatalf("expected MetaStorable, got %T", s)
	}
	if ms.Key() == "" {
		t.Error("generated key must not be empty")
	}
	if strings.HasSuffix(ms.Key(), ".md") {
		t.Errorf("generated key %q must not end with .md", ms.Key())
	}
}

func TestCreateBufferStampsUUID(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["uuid"] == "" {
		t.Error("uuid must be stamped by Create")
	}
}

func TestCreateBufferStampsTimestamps(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["created"] == "" {
		t.Error("created must be set")
	}
	if ms.Meta()["modified"] == "" {
		t.Error("modified must be set")
	}
}

func TestCreateBufferVersionIsZero(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["version"] != "0" {
		t.Errorf("version = %q, want 0", ms.Meta()["version"])
	}
}

func TestCreateWithExplicitKey(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "my-buf", nil)
	if !strings.HasSuffix(s.ExternalRef(), "/my-buf") {
		t.Errorf("ExternalRef = %q, want suffix /my-buf", s.ExternalRef())
	}
}

func TestCreateStripsMdExtensionFromKey(t *testing.T) {
	fs := newTestStore(t)
	// Callers passing legacy .md keys should get the stripped path back.
	s := mustCreate(t, fs, testWorkingCopy, "my-buf.md", nil)
	if !strings.HasSuffix(s.ExternalRef(), "/my-buf") {
		t.Errorf("ExternalRef = %q, want suffix /my-buf (extension stripped)", s.ExternalRef())
	}
}

func TestCreateWithBodyContainsFrontmatter(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: abc123\nstatus: unfiled\n---\nhello world\n")
	s := mustCreate(t, fs, testWorkingCopy, "existing", body)
	ms := s.(store.MetaStorable)

	if ms.Meta()["uuid"] != "abc123" {
		t.Errorf("uuid = %q, want abc123", ms.Meta()["uuid"])
	}
	if ms.Meta()["status"] != "unfiled" {
		t.Errorf("status = %q, want unfiled", ms.Meta()["status"])
	}
	if string(ms.Body()) != "hello world\n" {
		t.Errorf("body = %q, want 'hello world\\n'", ms.Body())
	}
}

func TestCreateLibraryNote(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testLibrary, "my-note", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["uuid"] == "" {
		t.Error("uuid must be stamped")
	}
	if s.ExternalRef() != "store/my-note" {
		t.Errorf("ExternalRef = %q, want store/my-note", s.ExternalRef())
	}
}

func TestCreateBufferExternalRef(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	want := "testhost/buffers/buf"
	if s.ExternalRef() != want {
		t.Errorf("ExternalRef = %q, want %q", s.ExternalRef(), want)
	}
}

// ── Create — AssetStorable ────────────────────────────────────────────────────

func TestCreateAssetInfersPNG(t *testing.T) {
	fs := newTestStore(t)
	doc := mustCreate(t, fs, testWorkingCopy, "my-doc", nil)
	pngBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00}
	as, err := fs.CreateAsset(testWorkingCopy, doc.Key(), "blk-img1", pngBytes)
	if err != nil {
		t.Fatalf("CreateAsset: %v", err)
	}
	if as.Encoding() != store.Raw {
		t.Errorf("encoding = %v, want Raw for PNG binary", as.Encoding())
	}
	// ExternalRef should use UUID-based URL scheme.
	if !strings.HasPrefix(as.ExternalRef(), store.AssetURLPrefix) {
		t.Errorf("ExternalRef = %q, want %s... prefix", as.ExternalRef(), store.AssetURLPrefix)
	}
}

func TestCreateAssetBase64(t *testing.T) {
	fs := newTestStore(t)
	doc := mustCreate(t, fs, testWorkingCopy, "my-doc", nil)
	b64 := []byte("aGVsbG8gd29ybGQ=")
	as, err := fs.CreateAsset(testWorkingCopy, doc.Key(), "blk-b64", b64)
	if err != nil {
		t.Fatalf("CreateAsset: %v", err)
	}
	if as.Encoding() != store.Base64 {
		t.Errorf("encoding = %v, want Base64", as.Encoding())
	}
}

// ── Load ──────────────────────────────────────────────────────────────────────

func TestLoadReturnsMetaStorable(t *testing.T) {
	fs := newTestStore(t)
	created := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	loaded, err := fs.Load(testWorkingCopy, "buf")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	ms, ok := loaded.(store.MetaStorable)
	if !ok {
		t.Fatalf("expected MetaStorable, got %T", loaded)
	}
	if ms.Meta()["uuid"] != created.(store.MetaStorable).Meta()["uuid"] {
		t.Error("loaded UUID differs from created UUID")
	}
}

func TestLoadBodyStripped(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\n---\nhello\n")
	mustCreate(t, fs, testWorkingCopy, "buf", body)
	loaded, err := fs.Load(testWorkingCopy, "buf")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if string(loaded.Body()) != "hello\n" {
		t.Errorf("Body = %q, want 'hello\\n' (frontmatter should be stripped)", loaded.Body())
	}
}

func TestLoadNotFound(t *testing.T) {
	fs := newTestStore(t)
	_, err := fs.Load(testWorkingCopy, "nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent key")
	}
}

// ── Save ──────────────────────────────────────────────────────────────────────

func TestSaveIncrementsVersion(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)

	ms.SetBody([]byte("updated body"))
	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	savedMS := saved.(store.MetaStorable)
	ver, _ := strconv.Atoi(savedMS.Meta()["version"])
	if ver != 1 {
		t.Errorf("version after first save = %d, want 1", ver)
	}
}

func TestSaveUpdatesModified(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)

	ms.SetBody([]byte("new body"))
	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	savedMod := saved.(store.MetaStorable).Meta()["modified"]
	if savedMod == "" {
		t.Error("modified must be non-empty after save")
	}
}

func TestSaveBodyPersisted(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)
	ms.SetBody([]byte("# My Title\n\nSome content.\n"))

	if _, err := fs.Save(ms); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := fs.Load(testWorkingCopy, "buf")
	if err != nil {
		t.Fatalf("Load after save: %v", err)
	}
	if string(loaded.Body()) != "# My Title\n\nSome content.\n" {
		t.Errorf("persisted body = %q", loaded.Body())
	}
}

func TestSaveMetaMutationPersisted(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)
	m := cloneMeta(ms.Meta())
	m["display_name"] = "Test Note"
	ms.SetMeta(m)

	if _, err := fs.Save(ms); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := fs.Load(testWorkingCopy, "buf")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.(store.MetaStorable).Meta()["display_name"] != "Test Note" {
		t.Errorf("display_name not persisted")
	}
}

func TestSaveWritesVersionSnapshot(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			ms := mustCreateTyped(t, fs, testWorkingCopy, "buf", tc.contentType, nil)
			ms.SetBody([]byte("v1 content"))

			saved, err := fs.Save(ms)
			if err != nil {
				t.Fatalf("Save: %v", err)
			}
			if len(saved.Versions()) != 1 {
				t.Fatalf("Versions() = %d after first save, want 1", len(saved.Versions()))
			}

			dir := filepath.Join(fs.Root(), "testhost", "buffers", "buf")
			uuid := saved.Key()
			for _, path := range []string{
				filepath.Join(dir, uuid+tc.ext),
				filepath.Join(dir, ".history", uuid+".1"+tc.ext),
			} {
				if got, err := os.ReadFile(path); err != nil || string(got) != "v1 content" {
					t.Errorf("%s = %q, %v; want the saved body", path, got, err)
				}
			}
		})
	}
}

// Retention counts and deletes a storable's own snapshots, whatever their extension.
func TestSavePrunesOldestSnapshots(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			fs.SetMaxVersions(2)
			var current store.Storable = mustCreateTyped(t, fs, testWorkingCopy, "buf", tc.contentType, nil)
			for i := 1; i <= 4; i++ {
				current.(store.MetaStorable).SetBody([]byte("v" + strconv.Itoa(i)))
				saved, err := fs.Save(current)
				if err != nil {
					t.Fatalf("Save %d: %v", i, err)
				}
				current = saved
			}
			versions := current.Versions()
			if len(versions) != 2 || versions[0].ID != "4" || versions[1].ID != "3" {
				t.Fatalf("versions = %+v, want the newest two, newest first", versions)
			}
			entries, err := os.ReadDir(filepath.Join(fs.Root(), "testhost", "buffers", "buf", ".history"))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 2 {
				t.Errorf("%d snapshot files left, want 2", len(entries))
			}
		})
	}
}

func TestSaveStaleReturnsError(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)

	ms.SetBody([]byte("first"))
	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("first Save: %v", err)
	}

	// Try to save the stale original.
	ms.SetBody([]byte("stale write"))
	_, err = fs.Save(ms)
	if err == nil {
		t.Error("expected ErrStaleStorable but got nil")
	}
	_ = saved
}

// ── SaveMeta ──────────────────────────────────────────────────────────────────

func TestSaveMetaDoesNotBumpVersion(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)

	m := cloneMeta(ms.Meta())
	m["focus_count"] = "3"
	ms.SetMeta(m)

	updated, err := fs.SaveMeta(ms)
	if err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	// Version must stay at 0 — no content change.
	if updated.Meta()["version"] != "0" {
		t.Errorf("version = %q after SaveMeta, want 0", updated.Meta()["version"])
	}

	// No version snapshot should have been written.
	if len(updated.Versions()) != 0 {
		t.Errorf("expected 0 versions after SaveMeta, got %d", len(updated.Versions()))
	}

	// Persisted meta should be readable on next Load.
	loaded, err := fs.Load(testWorkingCopy, "buf")
	if err != nil {
		t.Fatalf("Load after SaveMeta: %v", err)
	}
	if loaded.(store.MetaStorable).Meta()["focus_count"] != "3" {
		t.Errorf("focus_count not persisted by SaveMeta")
	}
}

// ── Delete ────────────────────────────────────────────────────────────────────

func TestDeleteRemovesDocument(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)

	if err := fs.Delete(s); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := fs.Load(testWorkingCopy, "buf"); err == nil {
		t.Error("expected error loading deleted document")
	}
}

func TestDeleteRemovesHistory(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			ms := mustCreateTyped(t, fs, testWorkingCopy, "buf", tc.contentType, nil)
			ms.SetBody([]byte("v1"))
			saved, _ := fs.Save(ms)

			fs.Delete(saved)

			// History directory should not exist (RemoveAll deleted the doc dir).
			histDir := filepath.Join(fs.Root(), "testhost", "buffers", "buf", ".history")
			if _, err := os.Stat(histDir); !os.IsNotExist(err) {
				t.Errorf("history dir should be gone after Delete: %s", histDir)
			}
			if _, err := fs.LoadByUUID(saved.Key()); err == nil {
				t.Error("uuid still resolves after Delete")
			}
		})
	}
}

// ── List ──────────────────────────────────────────────────────────────────────

func TestListReturnsCreatedStorables(t *testing.T) {
	fs := newTestStore(t)
	mustCreate(t, fs, testWorkingCopy, "a", nil)
	mustCreate(t, fs, testWorkingCopy, "b", nil)

	list, err := fs.List(testWorkingCopy, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	refs := make(map[string]bool)
	for _, s := range list {
		refs[s.ExternalRef()] = true
	}
	found := func(suffix string) bool {
		for ref := range refs {
			if strings.HasSuffix(ref, "/"+suffix) {
				return true
			}
		}
		return false
	}
	if !found("a") {
		t.Error("a not in list")
	}
	if !found("b") {
		t.Error("b not in list")
	}
}

func TestListWithPrefixFilters(t *testing.T) {
	fs := newTestStore(t)
	mustCreate(t, fs, testWorkingCopy, "alpha", nil)
	mustCreate(t, fs, testWorkingCopy, "beta", nil)

	list, err := fs.List(testWorkingCopy, "alpha")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, s := range list {
		if !strings.HasSuffix(s.ExternalRef(), "/alpha") && !strings.Contains(s.ExternalRef(), "/alpha/") {
			t.Errorf("unexpected ExternalRef %q with prefix filter 'alpha'", s.ExternalRef())
		}
	}
}

// ── Rename ────────────────────────────────────────────────────────────────────

func TestRenameChangesKey(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testLibrary, "old-name", nil)

	renamed, err := fs.Rename(s, "new-name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if !strings.HasSuffix(renamed.ExternalRef(), "/new-name") {
		t.Errorf("ExternalRef after rename = %q, want suffix /new-name", renamed.ExternalRef())
	}
}

func TestRenamePreservesUUID(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			ms := mustCreateTyped(t, fs, testLibrary, "old-name", tc.contentType, []byte("body"))

			renamed, err := fs.Rename(ms, "new-name")
			if err != nil {
				t.Fatalf("Rename: %v", err)
			}
			got := renamed.(store.MetaStorable)
			if got.Meta()["uuid"] != ms.Meta()["uuid"] {
				t.Error("UUID must be preserved after rename")
			}
			if got.Type() != tc.contentType || string(got.Body()) != "body" {
				t.Errorf("after rename: type %q body %q", got.Type(), got.Body())
			}
		})
	}
}

func TestRenameDoesNotChangeAssetURLs(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, testLibrary, "my-note", nil)

	pngBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	asset, err := fs.CreateAsset(testLibrary, s.Key(), "blk-img", pngBytes)
	if err != nil {
		t.Fatalf("CreateAsset: %v", err)
	}
	originalRef := asset.ExternalRef()

	// Rename the parent document.
	renamed, err := fs.Rename(s, "renamed-note")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	_ = renamed

	// The asset URL is UUID-based — it should not have changed after rename.
	if originalRef == "" {
		t.Fatal("originalRef must not be empty")
	}
	// Asset URLs use {prefix}{uuid}/... which is stable regardless of directory name.
	if !strings.HasPrefix(originalRef, store.AssetURLPrefix) {
		t.Errorf("asset ExternalRef %q should use %s... scheme", originalRef, store.AssetURLPrefix)
	}
}

// A folder rename must be atomic from the caller's view: the directory move on
// disk and the reload that refreshes the cache either both land or neither
// does. renameKey used to reload the moved entity via Load, which rejects
// anything whose .meta type isn't "document" — so a folder rename moved the
// directory, then failed, leaving the tree cache pointed at the old key while
// the note inside had already relocated on disk.
func TestRenameFolderContainingANote(t *testing.T) {
	fs := newTestStore(t)

	folder, err := fs.CreateOrLoadFolder(testLibrary, "old-folder")
	if err != nil {
		t.Fatalf("CreateOrLoadFolder: %v", err)
	}
	note := mustCreate(t, fs, testLibrary, "old-folder/my-note", nil)
	noteUUID := note.(store.MetaStorable).Meta()["uuid"]

	renamed, err := fs.Rename(folder, "new-folder")
	if err != nil {
		t.Fatalf("Rename(folder): %v", err)
	}

	rf, ok := renamed.(store.FolderStorable)
	if !ok {
		t.Fatalf("renamed folder is %T, want store.FolderStorable", renamed)
	}
	if rf.Name() != "new-folder" {
		t.Errorf("renamed folder name = %q, want %q", rf.Name(), "new-folder")
	}

	reloaded, err := fs.LoadFolder(testLibrary, "new-folder")
	if err != nil {
		t.Fatalf("LoadFolder(new-folder) after rename: %v", err)
	}
	if len(reloaded.Owns()) != 1 {
		t.Fatalf("reloaded folder owns %d children, want 1", len(reloaded.Owns()))
	}

	loadedNote, err := fs.LoadByUUID(noteUUID)
	if err != nil {
		t.Fatalf("LoadByUUID(note) after folder rename: %v", err)
	}
	if !strings.HasPrefix(loadedNote.ExternalRef(), "store/new-folder/") {
		t.Errorf("note ExternalRef after folder rename = %q, want prefix store/new-folder/", loadedNote.ExternalRef())
	}

	if _, err := fs.LoadFolder(testLibrary, "old-folder"); err == nil {
		t.Error("old-folder path still resolves after rename")
	}
}

// CreateOrLoadFolder("parent/child") must make every ancestor a real Sieve
// node: os.MkdirAll silently creates intermediate directories, and a
// directory without a .meta is invisible to both scanners (#72).
func TestCreateOrLoadFolderNestedPathIsFullyVisible(t *testing.T) {
	fs := newTestStore(t)

	folder, err := fs.CreateOrLoadFolder(testLibrary, "parent/child")
	if err != nil {
		t.Fatalf("CreateOrLoadFolder: %v", err)
	}
	note := mustCreate(t, fs, testLibrary, "a-note", nil)
	if _, err := fs.Reparent(note, folder); err != nil {
		t.Fatalf("Reparent: %v", err)
	}

	items, err := fs.List(testLibrary, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var parent store.FolderStorable
	for _, item := range items {
		if f, ok := item.(store.FolderStorable); ok && f.Name() == "parent" {
			parent = f
		}
	}
	if parent == nil {
		t.Fatalf("List root items = %v, want \"parent\" folder among them", items)
	}

	children := parent.Owns()
	if len(children) != 1 {
		t.Fatalf("parent owns %d children, want 1 (child folder)", len(children))
	}
	child, ok := children[0].(store.FolderStorable)
	if !ok || child.Name() != "child" {
		t.Fatalf("parent's child = %+v, want folder named \"child\"", children[0])
	}
	if len(child.Owns()) != 1 {
		t.Fatalf("child owns %d items, want 1 (the reparented note)", len(child.Owns()))
	}
}

// A repeat CreateOrLoadFolder over an existing ancestor must load, not
// re-identify — the .meta UUID minted for "parent" the first time round must
// survive a second call that walks through it.
func TestCreateOrLoadFolderNestedPathIsIdempotent(t *testing.T) {
	fs := newTestStore(t)

	if _, err := fs.CreateOrLoadFolder(testLibrary, "parent/child"); err != nil {
		t.Fatalf("CreateOrLoadFolder(parent/child) #1: %v", err)
	}
	items, err := fs.List(testLibrary, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var parentBefore store.FolderStorable
	for _, item := range items {
		if f, ok := item.(store.FolderStorable); ok && f.Name() == "parent" {
			parentBefore = f
		}
	}
	if parentBefore == nil {
		t.Fatalf("List root items = %v, want \"parent\" folder among them", items)
	}
	parentUUIDBefore := parentBefore.Key()
	if parentUUIDBefore == "" {
		t.Fatal("parent folder key must not be empty")
	}

	if _, err := fs.CreateOrLoadFolder(testLibrary, "parent/other"); err != nil {
		t.Fatalf("CreateOrLoadFolder(parent/other) #2: %v", err)
	}

	items, err = fs.List(testLibrary, "")
	if err != nil {
		t.Fatalf("List after second call: %v", err)
	}
	var parentAfter store.FolderStorable
	for _, item := range items {
		if f, ok := item.(store.FolderStorable); ok && f.Name() == "parent" {
			parentAfter = f
		}
	}
	if parentAfter == nil {
		t.Fatal("\"parent\" folder missing from List after second CreateOrLoadFolder call")
	}
	if parentAfter.Key() != parentUUIDBefore {
		t.Errorf("parent folder key changed from %q to %q — ancestor was re-identified instead of loaded", parentUUIDBefore, parentAfter.Key())
	}
	if len(parentAfter.Owns()) != 2 {
		t.Fatalf("parent owns %d children, want 2 (child, other)", len(parentAfter.Owns()))
	}
}

// ── RetrieveVersion ───────────────────────────────────────────────────────────

func TestRetrieveVersionRoundTrip(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			ms := mustCreateTyped(t, fs, testWorkingCopy, "buf", tc.contentType, nil)
			ms.SetBody([]byte("snapshot content"))

			saved, err := fs.Save(ms)
			if err != nil {
				t.Fatalf("Save: %v", err)
			}

			versions := saved.Versions()
			if len(versions) == 0 {
				t.Fatal("no versions after save")
			}

			vs, err := fs.RetrieveVersion(saved, versions[0])
			if err != nil {
				t.Fatalf("RetrieveVersion: %v", err)
			}
			if string(vs.Body) != "snapshot content" {
				t.Errorf("snapshot body = %q, want 'snapshot content'", vs.Body)
			}
		})
	}
}

// A .meta type is stamped once: SetMeta cannot overwrite it, and neither saves nor
// a move between categories rewrite it.
func TestMetaTypeSurvivesEveryWrite(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			ms := mustCreateTyped(t, fs, testWorkingCopy, "buf", tc.contentType, []byte("body"))

			meta := cloneMeta(ms.Meta())
			delete(meta, "type")
			meta["focus_count"] = "3"
			ms.SetMeta(meta)
			afterMeta, err := fs.SaveMeta(ms)
			if err != nil {
				t.Fatalf("SaveMeta: %v", err)
			}
			afterMeta.SetBody([]byte("edited"))
			afterSave, err := fs.Save(afterMeta)
			if err != nil {
				t.Fatalf("Save: %v", err)
			}
			moved, err := fs.Move(afterSave, testLibrary)
			if err != nil {
				t.Fatalf("Move: %v", err)
			}

			got := moved.(store.MetaStorable)
			if got.Type() != tc.contentType || got.Meta()["type"] != tc.contentType {
				t.Errorf("after the writes: Type()=%q meta type=%q, want %q", got.Type(), got.Meta()["type"], tc.contentType)
			}
			if got.Meta()[store.MetaKeyKind] != "test-kind" {
				t.Errorf("kind = %q, want it kept", got.Meta()[store.MetaKeyKind])
			}
			if string(got.Body()) != "edited" {
				t.Errorf("body = %q after the move", got.Body())
			}
		})
	}
}

// A directory may be named by its own uuid, which is also a key Load resolves
// through the index: a move must land on the new location, not the stale entry.
func TestMoveOfADirectoryNamedByItsUUID(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			const uuid = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
			ms, err := fs.CreateTyped(testWorkingCopy, uuid, tc.contentType, map[string]string{"uuid": uuid}, []byte("body"))
			if err != nil {
				t.Fatalf("CreateTyped: %v", err)
			}
			moved, err := fs.Move(ms, testLibrary)
			if err != nil {
				t.Fatalf("Move: %v", err)
			}
			if moved.Category().Key != testLibrary.Key || string(moved.Body()) != "body" {
				t.Errorf("moved = %s body %q", moved.Category().Key, moved.Body())
			}
			current, err := fs.LoadByUUID(uuid)
			if err != nil || current.Category().Key != testLibrary.Key {
				t.Errorf("index after Move: %v, %v", current, err)
			}
		})
	}
}

// A fresh FileStore has an empty index: each type must come back through the
// index rebuild, the category scan and a folder's children, with its content
// file read and not mistaken for an asset.
func TestContentTypesAreFoundByAFreshStore(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			top := mustCreateTyped(t, fs, testLibrary, "top", tc.contentType, []byte("top body"))
			nested := mustCreateTyped(t, fs, testLibrary, "nested", tc.contentType, []byte("nested body"))
			folder, err := fs.CreateOrLoadFolder(testLibrary, "folder")
			if err != nil {
				t.Fatalf("CreateOrLoadFolder: %v", err)
			}
			if _, err := fs.Reparent(nested, folder); err != nil {
				t.Fatalf("Reparent: %v", err)
			}

			fresh, err := filestore.NewFileStore(fs.Root(), "testhost")
			if err != nil {
				t.Fatalf("NewFileStore: %v", err)
			}
			for uuid, body := range map[string]string{top.Key(): "top body", nested.Key(): "nested body"} {
				s, err := fresh.LoadByUUID(uuid)
				if err != nil {
					t.Fatalf("LoadByUUID(%s) on a fresh store: %v", body, err)
				}
				ms := s.(store.MetaStorable)
				if ms.Type() != tc.contentType || string(ms.Body()) != body {
					t.Errorf("%s: type %q body %q", uuid, ms.Type(), ms.Body())
				}
				if len(ms.Owns()) != 0 {
					t.Errorf("%s: content file listed as an asset: %d owned", uuid, len(ms.Owns()))
				}
			}

			listed, err := fresh.List(testLibrary, "")
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			var topSeen, nestedSeen bool
			for _, s := range listed {
				switch s := s.(type) {
				case store.MetaStorable:
					topSeen = topSeen || s.Key() == top.Key()
				case store.FolderStorable:
					for _, child := range s.Owns() {
						nestedSeen = nestedSeen || child.Key() == nested.Key()
					}
				}
			}
			if !topSeen || !nestedSeen {
				t.Errorf("List: top seen %v, nested seen %v", topSeen, nestedSeen)
			}
		})
	}
}

// CreateTyped stores the body verbatim, so a block whose text opens like
// frontmatter is not split, and it refuses a type with no content file.
func TestCreateTypedStoresBytesAndRefusesContentlessTypes(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\ntitle: not frontmatter\n---\nrest")
	ms := mustCreateTyped(t, fs, testWorkingCopy, "blk", store.TypeBlock, body)
	if string(ms.Body()) != string(body) {
		t.Errorf("body = %q, want it verbatim", ms.Body())
	}
	if _, present := ms.Meta()["title"]; present {
		t.Error("the body was parsed as frontmatter")
	}

	for _, contentType := range []string{store.TypeFolder, "", "whiteboard"} {
		if _, err := fs.CreateTyped(testWorkingCopy, "x", contentType, nil, nil); err == nil {
			t.Errorf("CreateTyped(type %q) succeeded, want a refusal", contentType)
		}
	}
}

// A store written before block containers existed loads and rewrites its files
// byte for byte: same .meta, same content file, same snapshot names.
func TestExistingMarkdownStoreIsUntouched(t *testing.T) {
	fs := newTestStore(t)
	const uuid = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	dir := filepath.Join(fs.Root(), "store", "legacy-note")
	if err := os.MkdirAll(filepath.Join(dir, ".history"), 0o755); err != nil {
		t.Fatal(err)
	}
	metaBytes := []byte(`{
  "uuid": "` + uuid + `",
  "type": "document",
  "status": "filed",
  "version": 3,
  "display_name": "Legacy Note",
  "tags": [
    "a",
    "b"
  ],
  "created": "2026-05-22T10:00:00",
  "modified": "2026-05-23T10:00:00",
  "names": [
    {
      "name": "legacy-note",
      "from": "2026-05-22T10:00:00"
    }
  ]
}`)
	body := []byte("# Legacy\n\n<!--s:pr-aaaa-->\nProse.\n<!--/s:pr-aaaa-->\n")
	for name, content := range map[string][]byte{
		".meta":                      metaBytes,
		uuid + ".md":                 body,
		".history/" + uuid + ".3.md": []byte("snapshot three"),
		".history/" + uuid + ".2.md": []byte("snapshot two"),
		"image.png":                  {0x89, 0x50, 0x4E, 0x47},
	} {
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	s, err := fs.Load(testLibrary, "legacy-note")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	ms := s.(store.MetaStorable)
	if ms.Type() != store.TypeDocument || string(ms.Body()) != string(body) {
		t.Fatalf("loaded type %q body %q", ms.Type(), ms.Body())
	}
	if vs := ms.Versions(); len(vs) != 2 || vs[0].ID != "3" || vs[1].ID != "2" {
		t.Errorf("versions = %+v", vs)
	}
	if owned := ms.Owns(); len(owned) != 1 || owned[0].Key() != "image.png" {
		t.Errorf("assets = %v, want only image.png", owned)
	}
	if vs, err := fs.RetrieveVersion(ms, store.VersionRef{ID: "2"}); err != nil || string(vs.Body) != "snapshot two" {
		t.Errorf("RetrieveVersion = %q, %v", vs.Body, err)
	}

	if _, err := fs.SaveMeta(ms); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, ".meta")); string(got) != string(metaBytes) {
		t.Errorf(".meta changed by SaveMeta:\n%s", got)
	}

	ms.SetBody([]byte("edited"))
	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, uuid+".md")); string(got) != "edited" {
		t.Errorf("content file = %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, ".history", uuid+".4.md")); string(got) != "edited" {
		t.Errorf("snapshot 4 = %q", got)
	}
	if len(saved.Versions()) != 3 {
		t.Errorf("versions after save = %d, want 3", len(saved.Versions()))
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".block") {
			t.Errorf("a markdown document grew %s", e.Name())
		}
	}
	if got, _ := os.ReadFile(filepath.Join(dir, ".meta")); strings.Contains(string(got), `"kind"`) {
		t.Errorf(".meta grew a kind:\n%s", got)
	}
}

// ── Meta field round-trips ────────────────────────────────────────────────────

func TestMetaUnknownKeysPreserved(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\ncustom_field: hello\n---\nbody\n")
	mustCreate(t, fs, testWorkingCopy, "buf", body)

	loaded, err := fs.Load(testWorkingCopy, "buf")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	ms := loaded.(store.MetaStorable)
	if ms.Meta()["custom_field"] != "hello" {
		t.Errorf("custom_field = %q, want hello", ms.Meta()["custom_field"])
	}
}

func TestMetaNullPreserved(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\nuser_intent: null\n---\n")
	mustCreate(t, fs, testWorkingCopy, "buf", body)

	loaded, _ := fs.Load(testWorkingCopy, "buf")
	ms := loaded.(store.MetaStorable)
	if ms.Meta()["user_intent"] != "null" {
		t.Errorf("user_intent = %q, want null", ms.Meta()["user_intent"])
	}
}

func TestMetaTagsPreserved(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\ntags: []\n---\n")
	mustCreate(t, fs, testWorkingCopy, "buf", body)

	loaded, _ := fs.Load(testWorkingCopy, "buf")
	ms := loaded.(store.MetaStorable)
	if ms.Meta()["tags"] != "[]" {
		t.Errorf("tags = %q, want []", ms.Meta()["tags"])
	}
}

// ── Assets co-located ────────────────────────────────────────────────────────

func TestAssetIsColocatedInDocDir(t *testing.T) {
	fs := newTestStore(t)
	doc := mustCreate(t, fs, testLibrary, "my-note", nil)

	pngBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	asset, err := fs.CreateAsset(testLibrary, doc.Key(), "blk-abc", pngBytes)
	if err != nil {
		t.Fatalf("CreateAsset: %v", err)
	}

	// Asset file must exist inside the document directory.
	root := fs.Root()
	docDir := filepath.Join(root, "store", "my-note")
	entries, err := os.ReadDir(docDir)
	if err != nil {
		t.Fatalf("ReadDir %s: %v", docDir, err)
	}
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "blk-abc") {
			found = true
		}
	}
	if !found {
		t.Errorf("asset file not found in document directory %s", docDir)
	}
	_ = asset
}

// DeleteAsset removes only a file the document owns as an asset; the document's
// own files and anything outside its directory are refused and left in place.
func TestDeleteAssetRemovesOnlyAnOwnedAsset(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			doc := mustCreateTyped(t, fs, testLibrary, "my-note", tc.contentType, []byte("body"))
			uuid := doc.Meta()["uuid"]
			if _, err := fs.CreateAsset(testLibrary, uuid, "holiday.png", []byte{0x89, 0x50, 0x4E, 0x47}); err != nil {
				t.Fatalf("CreateAsset: %v", err)
			}
			docDir := filepath.Join(fs.Root(), "store", "my-note")
			outside := filepath.Join(fs.Root(), "store", "keep.png")
			if err := os.WriteFile(outside, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}

			for _, key := range []string{uuid + tc.ext, ".meta", "../keep.png", "missing.png", ""} {
				if err := fs.DeleteAsset(testLibrary, uuid, key); err == nil {
					t.Errorf("DeleteAsset(%q) succeeded, want a refusal", key)
				}
			}
			for _, path := range []string{filepath.Join(docDir, uuid+tc.ext), filepath.Join(docDir, ".meta"), outside} {
				if _, err := os.Stat(path); err != nil {
					t.Errorf("%s was removed by a refused delete: %v", path, err)
				}
			}

			if err := fs.DeleteAsset(testLibrary, uuid, "holiday.png"); err != nil {
				t.Fatalf("DeleteAsset: %v", err)
			}
			if _, err := os.Stat(filepath.Join(docDir, "holiday.png")); !os.IsNotExist(err) {
				t.Errorf("asset still on disk: %v", err)
			}
			if _, err := fs.LoadAsset(testLibrary, uuid, "holiday.png"); err == nil {
				t.Error("the document still owns the deleted asset")
			}
		})
	}
}

// OwnedAssets attaches to the owner it was handed and to the Store's current
// instance, replacing an asset of the same key, and leaves the version alone,
// whether it saves the asset whole or appends to it. An appended asset reads as
// stored, through every owner and through a fresh load.
func TestOwnedAssetsWriteAttachesWithoutAVersionBump(t *testing.T) {
	for _, verb := range []struct {
		name  string
		write func(store.OwnedAssets, store.MetaStorable, []byte) (store.AssetStorable, error)
		want  string
	}{
		{"save", func(o store.OwnedAssets, ms store.MetaStorable, b []byte) (store.AssetStorable, error) {
			return o.Save(ms, "strokes.jsonl", b)
		}, "two\n"},
		{"append", func(o store.OwnedAssets, ms store.MetaStorable, b []byte) (store.AssetStorable, error) {
			return o.Append(ms, "strokes.jsonl", b)
		}, "one\ntwo\n"},
	} {
		for _, tc := range contentTypes {
			t.Run(verb.name+"/"+tc.contentType, func(t *testing.T) {
				fs := newTestStore(t)
				first := mustCreateTyped(t, fs, testLibrary, "my-note", tc.contentType, []byte("body"))
				// A second load replaces the index entry, so first is no longer current.
				reloaded, err := fs.Load(testLibrary, "my-note")
				if err != nil {
					t.Fatalf("Load: %v", err)
				}
				assets := store.OwnedAssets{Store: fs}
				for _, data := range []string{"one\n", "two\n"} {
					if _, err := verb.write(assets, first, []byte(data)); err != nil {
						t.Fatalf("%s: %v", verb.name, err)
					}
				}

				for name, ms := range map[string]store.MetaStorable{"handed": first, "current": reloaded.(store.MetaStorable)} {
					owned := ms.Owns()
					if len(owned) != 1 || string(owned[0].Body()) != verb.want {
						t.Errorf("%s owner holds %d assets, want the one asset holding %q", name, len(owned), verb.want)
					}
					if ms.Meta()["version"] != "0" {
						t.Errorf("%s owner version = %q, want 0", name, ms.Meta()["version"])
					}
				}
				got, err := fs.LoadAsset(testLibrary, first.Key(), "strokes.jsonl")
				if err != nil || string(got.Body()) != verb.want {
					t.Errorf("LoadAsset = %v, %v", got, err)
				}
				fresh, err := filestore.NewFileStore(fs.Root(), "testhost")
				if err != nil {
					t.Fatal(err)
				}
				if got, err := fresh.LoadAsset(testLibrary, first.Key(), "strokes.jsonl"); err != nil || string(got.Body()) != verb.want {
					t.Errorf("a fresh store's LoadAsset = %v, %v", got, err)
				}
			})
		}
	}
}

// AppendAsset writes only beside its owner's own files, never over them.
func TestAppendAssetRefusesWhatIsNotAnAssetKey(t *testing.T) {
	for _, tc := range contentTypes {
		t.Run(tc.contentType, func(t *testing.T) {
			fs := newTestStore(t)
			doc := mustCreateTyped(t, fs, testLibrary, "my-note", tc.contentType, []byte("body"))
			uuid := doc.Meta()["uuid"]
			for _, key := range []string{uuid + tc.ext, ".meta", "../keep.jsonl", "sub/a.jsonl", ""} {
				if _, err := fs.AppendAsset(testLibrary, uuid, key, []byte("x")); err == nil {
					t.Errorf("AppendAsset(%q) succeeded, want a refusal", key)
				}
			}
			if _, err := fs.AppendAsset(testLibrary, "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a77", "a.jsonl", []byte("x")); err == nil {
				t.Error("AppendAsset to an unknown owner succeeded")
			}
			if body, _ := os.ReadFile(filepath.Join(fs.Root(), "store", "my-note", uuid+tc.ext)); string(body) != "body" {
				t.Errorf("content file = %q", body)
			}
		})
	}
}

// Every verb that yields an asset yields the one file-backed kind: Body is the
// file's bytes at the moment of the call, so a file changed on disk after the
// storable was obtained is seen by the next Body, and the encoding is inferred
// from the file's leading bytes.
func TestAssetStorableIsBackedByItsFile(t *testing.T) {
	assetFiles := []struct {
		key  string
		data []byte
		enc  store.Encoding
	}{
		{"pic.png", []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00}, store.Raw},
		{"diagram.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), store.Raw},
		{"strokes.jsonl", []byte("{\"x\":1}\n"), store.Raw},
		{"b64.txt", []byte("aGVsbG8gd29ybGQ="), store.Base64},
		{"pack.zip", []byte("PK\x03\x04rest"), store.Zipped},
	}
	verbs := []struct {
		name string
		get  func(t *testing.T, fs *filestore.FileStore, owner store.MetaStorable, key string, data []byte) store.Storable
	}{
		{"create", func(t *testing.T, fs *filestore.FileStore, owner store.MetaStorable, key string, data []byte) store.Storable {
			a, err := fs.CreateAsset(testLibrary, owner.Key(), key, data)
			if err != nil {
				t.Fatalf("CreateAsset: %v", err)
			}
			return a
		}},
		{"append", func(t *testing.T, fs *filestore.FileStore, owner store.MetaStorable, key string, data []byte) store.Storable {
			a, err := fs.AppendAsset(testLibrary, owner.Key(), key, data)
			if err != nil {
				t.Fatalf("AppendAsset: %v", err)
			}
			return a
		}},
		{"load", func(t *testing.T, fs *filestore.FileStore, owner store.MetaStorable, key string, data []byte) store.Storable {
			if _, err := (store.OwnedAssets{Store: fs}).Save(owner, key, data); err != nil {
				t.Fatalf("Save: %v", err)
			}
			a, err := fs.LoadAsset(testLibrary, owner.Key(), key)
			if err != nil {
				t.Fatalf("LoadAsset: %v", err)
			}
			return a
		}},
		{"list", func(t *testing.T, fs *filestore.FileStore, owner store.MetaStorable, key string, data []byte) store.Storable {
			if _, err := fs.CreateAsset(testLibrary, owner.Key(), key, data); err != nil {
				t.Fatalf("CreateAsset: %v", err)
			}
			loaded, err := fs.Load(testLibrary, "my-note")
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			for _, a := range loaded.(store.MetaStorable).Owns() {
				if a.Key() == key {
					return a
				}
			}
			t.Fatalf("scan did not list %s", key)
			return nil
		}},
		{"save", func(t *testing.T, fs *filestore.FileStore, owner store.MetaStorable, key string, data []byte) store.Storable {
			a, err := fs.CreateAsset(testLibrary, owner.Key(), key, data)
			if err != nil {
				t.Fatalf("CreateAsset: %v", err)
			}
			saved, err := fs.Save(a)
			if err != nil {
				t.Fatalf("Save: %v", err)
			}
			return saved
		}},
	}
	for _, verb := range verbs {
		for _, af := range assetFiles {
			t.Run(verb.name+"/"+af.key, func(t *testing.T) {
				fs := newTestStore(t)
				owner := mustCreateTyped(t, fs, testLibrary, "my-note", "document", []byte("body"))
				got := verb.get(t, fs, owner, af.key, af.data)

				as, ok := got.(store.AssetStorable)
				if !ok {
					t.Fatalf("%T is not an AssetStorable", got)
				}
				if as.Encoding() != af.enc {
					t.Errorf("encoding = %v, want %v", as.Encoding(), af.enc)
				}
				if !bytes.Equal(as.Body(), af.data) {
					t.Errorf("Body = %q, want %q", as.Body(), af.data)
				}

				path := filepath.Join(fs.Root(), "store", "my-note", af.key)
				if err := os.WriteFile(path, []byte("changed on disk"), 0o644); err != nil {
					t.Fatal(err)
				}
				if string(as.Body()) != "changed on disk" {
					t.Errorf("Body after the file changed = %q", as.Body())
				}
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
				if as.Body() != nil {
					t.Errorf("Body of a missing file = %q, want nil", as.Body())
				}
			})
		}
	}
}

// ── Compile-time interface check ──────────────────────────────────────────────

var _ store.Store = (*filestore.FileStore)(nil)

// ── test helper ──────────────────────────────────────────────────────────────
func cloneMeta(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}
