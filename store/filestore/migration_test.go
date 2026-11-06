package filestore_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"sieve/ident"
	"sieve/store"
	"sieve/store/filestore"
)

var testBlocks = store.Category{Key: "blocks", DisplayName: "Blocks", MetaEnabled: true, Isolation: store.Shared}

// legacyContainer is a block container as an Isolated Blocks category held it:
// {root}/{host}/blocks/{uuid}/ with its .meta, content file, an asset and a snapshot.
type legacyContainer struct {
	uuid, dir string
}

// writeLegacyContainer writes a container of kind into host's machine folder.
// metaJSON, when not empty, is written as the .meta in place of a valid one.
func writeLegacyContainer(t *testing.T, root, host, kind, metaJSON string) legacyContainer {
	t.Helper()
	uuid := ident.New()
	dir := filepath.Join(root, host, "blocks", uuid)
	if err := os.MkdirAll(filepath.Join(dir, ".history"), 0o755); err != nil {
		t.Fatal(err)
	}
	if metaJSON == "" {
		raw, err := json.Marshal(map[string]any{"uuid": uuid, "type": store.TypeBlock, "kind": kind, "version": 1})
		if err != nil {
			t.Fatal(err)
		}
		metaJSON = string(raw)
	}
	for name, body := range map[string]string{
		".meta":                         metaJSON,
		uuid + ".block":                 "kind: " + kind + "\n",
		"strokes.jsonl":                 "{}\n",
		".history/" + uuid + ".1.block": "kind: " + kind + "\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return legacyContainer{uuid: uuid, dir: dir}
}

// assertWhole reports whether dir holds the files writeLegacyContainer wrote for c.
func assertWhole(t *testing.T, dir string, c legacyContainer) {
	t.Helper()
	for _, name := range []string{".meta", c.uuid + ".block", "strokes.jsonl", ".history/" + c.uuid + ".1.block"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(name))); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestMoveFromMachineFolder(t *testing.T) {
	t.Run("a fresh store moves nothing", func(t *testing.T) {
		fs := newTestStore(t)
		if moved := fs.MoveFromMachineFolder(testBlocks); moved != 0 {
			t.Errorf("moved %d", moved)
		}
		if _, err := os.Stat(filepath.Join(fs.Root(), "blocks")); !os.IsNotExist(err) {
			t.Errorf("the move created the category directory: %v", err)
		}
	})

	t.Run("containers move whole onto their kind's shelf, once", func(t *testing.T) {
		fs := newTestStore(t)
		notes := []legacyContainer{
			writeLegacyContainer(t, fs.Root(), "testhost", "digital-note", ""),
			writeLegacyContainer(t, fs.Root(), "testhost", "digital-note", ""),
		}
		other := writeLegacyContainer(t, fs.Root(), "testhost", "other-kind", "")

		if moved := fs.MoveFromMachineFolder(testBlocks); moved != 3 {
			t.Fatalf("moved %d, want 3", moved)
		}
		for _, c := range notes {
			assertWhole(t, filepath.Join(fs.Root(), "blocks", "digital-note", c.uuid), c)
		}
		assertWhole(t, filepath.Join(fs.Root(), "blocks", "other-kind", other.uuid), other)
		if _, err := os.Stat(filepath.Join(fs.Root(), "testhost", "blocks")); !os.IsNotExist(err) {
			t.Errorf("the emptied machine folder is still there: %v", err)
		}

		fresh, err := filestore.NewFileStore(fs.Root(), "testhost")
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range append(notes, other) {
			s, err := fresh.LoadByUUID(c.uuid)
			if err != nil || len(s.Versions()) != 1 {
				t.Errorf("LoadByUUID(%s) = %v, %v; want it with its snapshot", c.uuid, s, err)
				continue
			}
			if _, err := fresh.LoadAsset(s.Category(), c.uuid, "strokes.jsonl"); err != nil {
				t.Errorf("LoadAsset(%s): %v", c.uuid, err)
			}
		}
		if listed, err := fresh.List(testBlocks, ""); err != nil || len(listed) != 3 {
			t.Errorf("List = %d, %v; want 3", len(listed), err)
		}

		if moved := fresh.MoveFromMachineFolder(testBlocks); moved != 0 {
			t.Errorf("a second run moved %d", moved)
		}
		for _, c := range notes {
			assertWhole(t, filepath.Join(fs.Root(), "blocks", "digital-note", c.uuid), c)
		}
	})

	t.Run("what cannot move stays where it is", func(t *testing.T) {
		fs := newTestStore(t)
		noKind := writeLegacyContainer(t, fs.Root(), "testhost", "", "")
		badKind := writeLegacyContainer(t, fs.Root(), "testhost", "../escape", "")
		unreadable := writeLegacyContainer(t, fs.Root(), "testhost", "digital-note", "{not json")
		clash := writeLegacyContainer(t, fs.Root(), "testhost", "digital-note", "")
		target := filepath.Join(fs.Root(), "blocks", "digital-note", clash.uuid)
		if err := os.MkdirAll(target, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, "already-here"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		movable := writeLegacyContainer(t, fs.Root(), "testhost", "digital-note", "")

		if moved := fs.MoveFromMachineFolder(testBlocks); moved != 1 {
			t.Fatalf("moved %d, want only the movable one", moved)
		}
		for _, c := range []legacyContainer{noKind, badKind, unreadable, clash} {
			assertWhole(t, c.dir, c)
		}
		if entries, err := os.ReadDir(target); err != nil || len(entries) != 1 || entries[0].Name() != "already-here" {
			t.Errorf("the existing target was changed: %v, %v", entries, err)
		}
		assertWhole(t, filepath.Join(fs.Root(), "blocks", "digital-note", movable.uuid), movable)
		if _, err := os.Stat(filepath.Join(fs.Root(), "escape")); !os.IsNotExist(err) {
			t.Errorf("a kind climbed out of the category: %v", err)
		}
	})

	t.Run("another host's machine folder is left alone", func(t *testing.T) {
		fs := newTestStore(t)
		theirs := writeLegacyContainer(t, fs.Root(), "otherhost", "digital-note", "")
		if moved := fs.MoveFromMachineFolder(testBlocks); moved != 0 {
			t.Errorf("moved %d", moved)
		}
		assertWhole(t, theirs.dir, theirs)
	})

	t.Run("an Isolated category is its machine folder", func(t *testing.T) {
		fs := newTestStore(t)
		ours := writeLegacyContainer(t, fs.Root(), "testhost", "digital-note", "")
		isolated := testBlocks
		isolated.Isolation = store.Isolated
		if moved := fs.MoveFromMachineFolder(isolated); moved != 0 {
			t.Errorf("moved %d", moved)
		}
		assertWhole(t, ours.dir, ours)
	})
}
