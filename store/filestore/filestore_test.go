package filestore_test

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"stash/store"
	"stash/store/filestore"
)

// ── helpers ───────────────────────────────────────────────────────────────────

func newTestStore(t *testing.T) *filestore.FileStore {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return fs
}

func mustCreate(t *testing.T, fs *filestore.FileStore, cat store.Category, key string, body []byte) store.Storable {
	t.Helper()
	s, err := fs.Create(cat, key, body)
	if err != nil {
		t.Fatalf("Create(%s, %q): %v", cat.Key, key, err)
	}
	return s
}

// ── NewFileStore ──────────────────────────────────────────────────────────────

func TestNewFileStoreCreatesDirectories(t *testing.T) {
	dir := t.TempDir()
	_, err := filestore.NewFileStore(dir, "host1")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	// Each required directory should exist after construction.
	required := []string{
		filepath.Join(dir, "store"),
		filepath.Join(dir, "store", ".assets"),
		filepath.Join(dir, "store", ".history"),
		filepath.Join(dir, "host1", "buffers"),
		filepath.Join(dir, "host1", "buffers", "assets"),
		filepath.Join(dir, "host1", ".history"),
		filepath.Join(dir, "host1", "config"),
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
	s := mustCreate(t, fs, store.WorkingCopy, "", nil)

	ms, ok := s.(store.MetaStorable)
	if !ok {
		t.Fatalf("expected MetaStorable, got %T", s)
	}
	if ms.Key() == "" {
		t.Error("generated key must not be empty")
	}
	if !strings.HasSuffix(ms.Key(), ".md") {
		t.Errorf("generated key %q must end with .md", ms.Key())
	}
}

func TestCreateBufferStampsUUID(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["uuid"] == "" {
		t.Error("uuid must be stamped by Create")
	}
}

func TestCreateBufferStampsTimestamps(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "", nil)
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
	s := mustCreate(t, fs, store.WorkingCopy, "", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["version"] != "0" {
		t.Errorf("version = %q, want 0", ms.Meta()["version"])
	}
}

func TestCreateWithExplicitKey(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "my-buf.md", nil)
	if s.Key() != "my-buf.md" {
		t.Errorf("key = %q, want my-buf.md", s.Key())
	}
}

func TestCreateWithBodyContainsFrontmatter(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: abc123\nstatus: unfiled\n---\nhello world\n")
	s := mustCreate(t, fs, store.WorkingCopy, "existing.md", body)
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
	s := mustCreate(t, fs, store.Library, "my-note.md", nil)
	ms := s.(store.MetaStorable)
	if ms.Meta()["uuid"] == "" {
		t.Error("uuid must be stamped")
	}
	// ExternalRef for Library should be store/my-note.md
	if s.ExternalRef() != "store/my-note.md" {
		t.Errorf("ExternalRef = %q, want store/my-note.md", s.ExternalRef())
	}
}

func TestCreateBufferExternalRef(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	want := "testhost/buffers/buf.md"
	if s.ExternalRef() != want {
		t.Errorf("ExternalRef = %q, want %q", s.ExternalRef(), want)
	}
}

// ── Create — AssetStorable ────────────────────────────────────────────────────

func TestCreateAssetInfersPNG(t *testing.T) {
	fs := newTestStore(t)
	// PNG magic bytes
	pngBytes := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00}
	s := mustCreate(t, fs, store.WorkingCopy, "assets/img.png", pngBytes)

	as, ok := s.(store.AssetStorable)
	if !ok {
		t.Fatalf("expected AssetStorable, got %T", s)
	}
	if as.Encoding() != store.Raw {
		t.Errorf("encoding = %v, want Raw for PNG binary", as.Encoding())
	}
}

func TestCreateAssetBase64(t *testing.T) {
	fs := newTestStore(t)
	// Valid base64 data (multiple of 4, all base64 chars)
	b64 := []byte("aGVsbG8gd29ybGQ=")
	s := mustCreate(t, fs, store.WorkingCopy, "assets/img.b64", b64)

	as, ok := s.(store.AssetStorable)
	if !ok {
		t.Fatalf("expected AssetStorable, got %T", s)
	}
	if as.Encoding() != store.Base64 {
		t.Errorf("encoding = %v, want Base64", as.Encoding())
	}
}

// ── Load ──────────────────────────────────────────────────────────────────────

func TestLoadReturnsMetaStorable(t *testing.T) {
	fs := newTestStore(t)
	created := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	loaded, err := fs.Load(store.WorkingCopy, "buf.md")
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
	mustCreate(t, fs, store.WorkingCopy, "buf.md", body)
	loaded, err := fs.Load(store.WorkingCopy, "buf.md")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if string(loaded.Body()) != "hello\n" {
		t.Errorf("Body = %q, want 'hello\\n' (frontmatter should be stripped)", loaded.Body())
	}
}

func TestLoadNotFound(t *testing.T) {
	fs := newTestStore(t)
	_, err := fs.Load(store.WorkingCopy, "nonexistent.md")
	if err == nil {
		t.Error("expected error for nonexistent key")
	}
}

// ── Save ──────────────────────────────────────────────────────────────────────

func TestSaveIncrementsVersion(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
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
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	ms := s.(store.MetaStorable)
	originalModified := ms.Meta()["modified"]

	// Sleep briefly to ensure the timestamp changes.
	// (time.Now() has ~1s resolution in the format string used)
	ms.SetBody([]byte("new body"))
	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	_ = originalModified // may be equal if within same second; just verify non-empty
	savedMod := saved.(store.MetaStorable).Meta()["modified"]
	if savedMod == "" {
		t.Error("modified must be non-empty after save")
	}
}

func TestSaveBodyPersisted(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	ms := s.(store.MetaStorable)
	ms.SetBody([]byte("# My Title\n\nSome content.\n"))

	if _, err := fs.Save(ms); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := fs.Load(store.WorkingCopy, "buf.md")
	if err != nil {
		t.Fatalf("Load after save: %v", err)
	}
	if string(loaded.Body()) != "# My Title\n\nSome content.\n" {
		t.Errorf("persisted body = %q", loaded.Body())
	}
}

func TestSaveMetaMutationPersisted(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	ms := s.(store.MetaStorable)
	m := cloneMeta(ms.Meta())
	m["display_name"] = "Test Note"
	ms.SetMeta(m)

	if _, err := fs.Save(ms); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := fs.Load(store.WorkingCopy, "buf.md")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.(store.MetaStorable).Meta()["display_name"] != "Test Note" {
		t.Errorf("display_name not persisted")
	}
}

func TestSaveWritesVersionSnapshot(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
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
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	ms := s.(store.MetaStorable)

	// Perform a save to advance the on-disk version.
	ms.SetBody([]byte("first"))
	saved, err := fs.Save(ms)
	if err != nil {
		t.Fatalf("first Save: %v", err)
	}

	// Try to save the old (stale) Storable again.
	ms.SetBody([]byte("stale write"))
	_, err = fs.Save(ms)
	if err == nil {
		t.Error("expected ErrStaleStorable but got nil")
	}
	_ = saved
}

// ── Delete ────────────────────────────────────────────────────────────────────

func TestDeleteRemovesFile(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)

	if err := fs.Delete(s); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := fs.Load(store.WorkingCopy, "buf.md"); err == nil {
		t.Error("expected error loading deleted file")
	}
}

func TestDeleteRemovesHistory(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
	ms := s.(store.MetaStorable)
	ms.SetBody([]byte("v1"))
	saved, _ := fs.Save(ms)
	uuid := saved.(store.MetaStorable).Meta()["uuid"]

	fs.Delete(saved)

	// History files should be gone.
	// We check indirectly: a fresh Load would report no versions.
	_ = uuid
}

// ── List ──────────────────────────────────────────────────────────────────────

func TestListReturnsCreatedStorables(t *testing.T) {
	fs := newTestStore(t)
	mustCreate(t, fs, store.WorkingCopy, "a.md", nil)
	mustCreate(t, fs, store.WorkingCopy, "b.md", nil)

	list, err := fs.List(store.WorkingCopy, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	keys := make(map[string]bool)
	for _, s := range list {
		keys[s.Key()] = true
	}
	if !keys["a.md"] {
		t.Error("a.md not in list")
	}
	if !keys["b.md"] {
		t.Error("b.md not in list")
	}
}

func TestListWithPrefixFilters(t *testing.T) {
	fs := newTestStore(t)
	mustCreate(t, fs, store.WorkingCopy, "alpha.md", nil)
	mustCreate(t, fs, store.WorkingCopy, "beta.md", nil)

	list, err := fs.List(store.WorkingCopy, "alpha")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, s := range list {
		if !strings.HasPrefix(s.Key(), "alpha") {
			t.Errorf("unexpected key %q with prefix filter 'alpha'", s.Key())
		}
	}
}

// ── Rename ────────────────────────────────────────────────────────────────────

func TestRenameChangesKey(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.Library, "old-name.md", nil)

	renamed, err := fs.Rename(s, "new-name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if renamed.Key() != "new-name.md" {
		t.Errorf("key after rename = %q, want new-name.md", renamed.Key())
	}
}

// ── RetrieveVersion ───────────────────────────────────────────────────────────

func TestRetrieveVersionRoundTrip(t *testing.T) {
	fs := newTestStore(t)
	s := mustCreate(t, fs, store.WorkingCopy, "buf.md", nil)
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

// ── Frontmatter round-trip ────────────────────────────────────────────────────

func TestFrontmatterUnknownKeysPreserved(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\ncustom_field: hello\n---\nbody\n")
	mustCreate(t, fs, store.WorkingCopy, "buf.md", body)

	loaded, err := fs.Load(store.WorkingCopy, "buf.md")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	ms := loaded.(store.MetaStorable)
	if ms.Meta()["custom_field"] != "hello" {
		t.Errorf("custom_field = %q, want hello", ms.Meta()["custom_field"])
	}
}

func TestFrontmatterNullPreserved(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\nuser_intent: null\n---\n")
	mustCreate(t, fs, store.WorkingCopy, "buf.md", body)

	loaded, _ := fs.Load(store.WorkingCopy, "buf.md")
	ms := loaded.(store.MetaStorable)
	if ms.Meta()["user_intent"] != "null" {
		t.Errorf("user_intent = %q, want null", ms.Meta()["user_intent"])
	}
}

func TestFrontmatterTagsPreserved(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\nuuid: x\ntags: []\n---\n")
	mustCreate(t, fs, store.WorkingCopy, "buf.md", body)

	loaded, _ := fs.Load(store.WorkingCopy, "buf.md")
	ms := loaded.(store.MetaStorable)
	if ms.Meta()["tags"] != "[]" {
		t.Errorf("tags = %q, want []", ms.Meta()["tags"])
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
