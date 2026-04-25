package stash_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sieve/stash"
	"sieve/store/filestore"
)

// newTestNoteService creates a NoteService backed by a real FileStore in a
// temp directory. The returned cleanup func removes the temp dir.
func newTestNoteService(t *testing.T) (*stash.NoteService, string) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	svc, err := stash.NewNoteService(fs)
	if err != nil {
		t.Fatalf("NewNoteService: %v", err)
	}
	return svc, dir
}

// createTestNote writes a minimal note directly into the store dir and loads it.
func createTestNote(t *testing.T, svc *stash.NoteService, storeDir, relKey string) *stash.Note {
	t.Helper()
	absDir := filepath.Join(storeDir, "store", filepath.Dir(relKey))
	if err := os.MkdirAll(absDir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", absDir, err)
	}
	absPath := filepath.Join(storeDir, "store", relKey)
	body := []byte("---\nuuid: test-uuid-" + strings.ReplaceAll(relKey, "/", "-") + "\nstatus: filed\n---\ntest body\n")
	if err := os.WriteFile(absPath, body, 0o644); err != nil {
		t.Fatalf("write %s: %v", absPath, err)
	}
	note, err := svc.LoadByUUID("test-uuid-" + strings.ReplaceAll(relKey, "/", "-"))
	if err != nil {
		t.Fatalf("LoadByUUID for %s: %v", relKey, err)
	}
	return note
}

// ── Rename tests ──────────────────────────────────────────────────────────────

// A note at the library root should be renamed in place, staying at root.
func TestRenameNoteAtRoot(t *testing.T) {
	svc, dir := newTestNoteService(t)
	note := createTestNote(t, svc, dir, "old-name.md")

	renamed, err := svc.Rename(note, "New Name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}

	wantKey := "store/new-name.md"
	if renamed.Path() != wantKey {
		t.Errorf("Path after rename = %q, want %q", renamed.Path(), wantKey)
	}

	// Source file must be gone; destination must exist.
	if _, err := os.Stat(filepath.Join(dir, "store", "old-name.md")); !os.IsNotExist(err) {
		t.Error("old file still exists after rename")
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "new-name.md")); err != nil {
		t.Errorf("new file not found: %v", err)
	}
}

// A note inside a subfolder should be renamed in place — the folder must NOT
// be duplicated or nested.
func TestRenameNoteInSubfolder(t *testing.T) {
	svc, dir := newTestNoteService(t)
	note := createTestNote(t, svc, dir, "my-folder/old-name.md")

	renamed, err := svc.Rename(note, "New Name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}

	wantKey := "store/my-folder/new-name.md"
	if renamed.Path() != wantKey {
		t.Errorf("Path after rename = %q, want %q", renamed.Path(), wantKey)
	}

	// Must NOT create a nested folder like my-folder/my-folder/.
	nestedDir := filepath.Join(dir, "store", "my-folder", "my-folder")
	if _, err := os.Stat(nestedDir); !os.IsNotExist(err) {
		t.Errorf("nested folder %q was created — double-dir bug", nestedDir)
	}

	// Source must be gone; destination must exist.
	if _, err := os.Stat(filepath.Join(dir, "store", "my-folder", "old-name.md")); !os.IsNotExist(err) {
		t.Error("old file still exists after rename")
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "my-folder", "new-name.md")); err != nil {
		t.Errorf("new file not found: %v", err)
	}
}

// Rename must update the display_name metadata field so the UI reflects the
// new name even when an AI-set display_name was previously in the frontmatter.
func TestRenameUpdatesDisplayName(t *testing.T) {
	svc, dir := newTestNoteService(t)
	// Write a note with an existing AI-set display_name.
	absPath := filepath.Join(dir, "store", "old-slug.md")
	body := []byte("---\nuuid: test-uuid-display\nstatus: filed\ndisplay_name: Old AI Title\n---\nbody\n")
	if err := os.WriteFile(absPath, body, 0o644); err != nil {
		t.Fatal(err)
	}
	note, err := svc.LoadByUUID("test-uuid-display")
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}

	renamed, err := svc.Rename(note, "Brand New Name")
	if err != nil {
		t.Fatalf("Rename: %v", err)
	}

	got := renamed.Meta().DisplayName()
	if got != "Brand New Name" {
		t.Errorf("display_name after rename = %q, want %q", got, "Brand New Name")
	}

	// Verify it's persisted in the frontmatter on disk.
	data, err := os.ReadFile(filepath.Join(dir, "store", "brand-new-name.md"))
	if err != nil {
		t.Fatalf("reading renamed file: %v", err)
	}
	if !strings.Contains(string(data), "display_name: Brand New Name") {
		t.Errorf("display_name not written to frontmatter; file contents:\n%s", data)
	}
}

// ── Move tests ────────────────────────────────────────────────────────────────

// Moving a root-level note to a subfolder must place it in that folder, not
// create a nested folder inside it.
func TestMoveNoteFromRootToFolder(t *testing.T) {
	svc, dir := newTestNoteService(t)
	// Create target folder.
	if err := os.MkdirAll(filepath.Join(dir, "store", "target"), 0o755); err != nil {
		t.Fatal(err)
	}
	note := createTestNote(t, svc, dir, "my-note.md")

	moved, err := svc.Move(note, "target")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}

	wantKey := "store/target/my-note.md"
	if moved.Path() != wantKey {
		t.Errorf("Path after move = %q, want %q", moved.Path(), wantKey)
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "target", "my-note.md")); err != nil {
		t.Errorf("file not found at target: %v", err)
	}
}

// Moving a note that is ALREADY in a subfolder to a DIFFERENT subfolder must
// land in the target — NOT create target nested inside the current folder.
func TestMoveNoteFromSubfolderToOtherFolder(t *testing.T) {
	svc, dir := newTestNoteService(t)
	if err := os.MkdirAll(filepath.Join(dir, "store", "target"), 0o755); err != nil {
		t.Fatal(err)
	}
	note := createTestNote(t, svc, dir, "source-folder/my-note.md")

	moved, err := svc.Move(note, "target")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}

	wantKey := "store/target/my-note.md"
	if moved.Path() != wantKey {
		t.Errorf("Path after move = %q, want %q", moved.Path(), wantKey)
	}

	// Must NOT create source-folder/target/my-note.md.
	wrongPath := filepath.Join(dir, "store", "source-folder", "target", "my-note.md")
	if _, err := os.Stat(wrongPath); !os.IsNotExist(err) {
		t.Errorf("file landed at wrong nested path %q — double-dir bug", wrongPath)
	}
}

// Moving a note to the library root (empty folder) must place it at root.
func TestMoveNoteToRoot(t *testing.T) {
	svc, dir := newTestNoteService(t)
	note := createTestNote(t, svc, dir, "sub/my-note.md")

	moved, err := svc.Move(note, "")
	if err != nil {
		t.Fatalf("Move to root: %v", err)
	}

	wantKey := "store/my-note.md"
	if moved.Path() != wantKey {
		t.Errorf("Path after move to root = %q, want %q", moved.Path(), wantKey)
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "my-note.md")); err != nil {
		t.Errorf("file not found at root: %v", err)
	}
}
