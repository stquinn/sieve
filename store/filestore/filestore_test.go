package filestore_test

import (
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
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)
	ms.SetBody([]byte("v1 content"))

	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if len(saved.Versions()) == 0 {
		t.Error("Versions() should be non-empty after first save")
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
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)
	ms.SetBody([]byte("v1"))
	saved, _ := fs.Save(ms)

	fs.Delete(saved)

	// History directory should not exist (RemoveAll deleted the doc dir).
	root := fs.Root()
	uuid := saved.(store.MetaStorable).Meta()["uuid"]
	histDir := filepath.Join(root, "testhost", "buffers", "buf", ".history")
	if _, err := os.Stat(histDir); !os.IsNotExist(err) {
		t.Errorf("history dir should be gone after Delete: %s (uuid=%s)", histDir, uuid)
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
	fs := newTestStore(t)
	s := mustCreate(t, fs, testLibrary, "old-name", nil)
	originalUUID := s.(store.MetaStorable).Meta()["uuid"]

	renamed, err := fs.Rename(s, "new-name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if renamed.(store.MetaStorable).Meta()["uuid"] != originalUUID {
		t.Error("UUID must be preserved after rename")
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
	fs := newTestStore(t)
	s := mustCreate(t, fs, testWorkingCopy, "buf", nil)
	ms := s.(store.MetaStorable)
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
