package ink

import (
	"encoding/json"
	"fmt"
	"go/build"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/store/filestore"
)

// metaOf reads a container's .meta from disk.
func metaOf(t *testing.T, st *filestore.FileStore, uuid string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(st.Root(), "testhost", domain.Blocks.Key, uuid, ".meta"))
	if err != nil {
		t.Fatal(err)
	}
	var meta map[string]interface{}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	return meta
}

// dropWhiteboard rewrites container uuid's .meta without note_whiteboard, as a face saved before
// that field existed.
func dropWhiteboard(t *testing.T, st *filestore.FileStore, uuid string) {
	t.Helper()
	meta := metaOf(t, st, uuid)
	delete(meta["extra"].(map[string]interface{}), "note_whiteboard")
	raw, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.Root(), "testhost", domain.Blocks.Key, uuid, ".meta"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDigitalNoteKind_AttrsFaceAndSourceThroughAContainer(t *testing.T) {
	kind := NewDigitalNoteKind()
	for _, tc := range []struct {
		name      string
		log       []link.Record
		wantFace  map[string]string
		wantPages int
	}{
		{"an empty note", nil,
			map[string]string{"note_title": "", "note_pages": "0", "note_device": "", "note_source": "strokes", "note_synced_seq": "0", "note_whiteboard": "false"}, 0},
		{"a note of two pages",
			logOf(header("Ideas"), pageAdd(page(1), 0, ruled, link.BoundsFixed), pageAdd(page(2), 1, dots, link.BoundsFixed),
				strokeAdd(page(1), stroke(1))),
			map[string]string{"note_title": "Ideas", "note_pages": "2", "note_device": aDevice.Name, "note_source": "strokes", "note_synced_seq": "4", "note_whiteboard": "false"}, 2},
		{"a whiteboard", logOf(header("Board"), pageAdd(page(1), 0, nil, link.BoundsUnbounded)),
			map[string]string{"note_title": "Board", "note_pages": "1", "note_device": aDevice.Name, "note_source": "strokes", "note_synced_seq": "2", "note_whiteboard": "true"}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			containers, st := newTestContainers(t)
			note := NewHeaderFold("")
			for _, r := range tc.log {
				note.Apply(r)
			}
			prov := Provenance{Companion: companionID, SourceID: noteID, SyncedSeq: uint32(len(tc.log))}
			c, err := containers.Create(KindDigitalNote, kind.Attrs(NewHeaderFold(""), Provenance{Companion: companionID, SourceID: noteID}))
			if err != nil {
				t.Fatalf("Create: %v", err)
			}
			created := metaOf(t, st, c.UUID())["extra"].(map[string]interface{})
			if created["note_synced_seq"] != "0" || created["note_source_id"] != noteID.String() || created["note_companion"] != companionID {
				t.Errorf("face on create = %v", created)
			}

			c.Merge(kind.Attrs(note, prov))
			saved, err := containers.Save(c)
			if err != nil {
				t.Fatalf("Save: %v", err)
			}
			loaded, err := reopen(t, st).Load(c.UUID())
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if !reflect.DeepEqual(loaded.Block().Attrs, saved.Block().Attrs) {
				t.Errorf("attrs changed across reload:\n%#v\n%#v", loaded.Block().Attrs, saved.Block().Attrs)
			}
			attrs := loaded.Block().Attrs
			for _, key := range []string{"id", "title", "note", "note_device", "note_companion", "note_source_id", "note_synced_seq", "source"} {
				if _, ok := attrs[key]; !ok {
					t.Errorf("no %s in %v", key, attrs)
				}
			}
			if len(attrs) != 8 {
				t.Errorf("attrs beyond the contract's: %v", attrs)
			}
			if pages := attrs["note"].(map[string]interface{})["pages"].([]interface{}); len(pages) != tc.wantPages {
				t.Errorf("pages %v", pages)
			}

			source, err := domain.ParseAddress(loaded.Block().StringAttr("source"))
			if err != nil || source.Container != c.UUID() || source.Leaf != StrokesKey {
				t.Errorf("source %q: %+v %v", loaded.Block().StringAttr("source"), source, err)
			}

			face := metaOf(t, st, c.UUID())["extra"].(map[string]interface{})
			tc.wantFace["note_companion"], tc.wantFace["note_source_id"] = companionID, noteID.String()
			for k, v := range tc.wantFace {
				if face[k] != v {
					t.Errorf("face %s = %v, want %q", k, face[k], v)
				}
			}
			before := map[string]string{}
			for k, v := range face {
				if s, ok := v.(string); ok && k != "note_whiteboard" {
					before[k] = s
				}
			}
			lifted := kind.Lifted(before, func() (domain.SieveBlock, error) { return loaded.Block(), nil })
			if lifted["note_whiteboard"] != tc.wantFace["note_whiteboard"] || lifted["note_title"] != tc.wantFace["note_title"] {
				t.Errorf("a face saved before note_whiteboard, lifted: %v", lifted)
			}
			if versions := len(saved.Versions()); versions != min(len(tc.log), 1) {
				t.Errorf("%d versions; a save that changes nothing makes none, any other one", versions)
			}
		})
	}
}

// Find answers from the face alone: a container whose block no longer parses is still found.
func TestDigitalNoteKind_FoundByItsFaceWithoutItsBody(t *testing.T) {
	containers, st := newTestContainers(t)
	kind := NewDigitalNoteKind()
	ours, err := containers.Create(KindDigitalNote, kind.Attrs(NewHeaderFold(""), Provenance{Companion: companionID, SourceID: noteID}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := containers.Create(KindDigitalNote, kind.Attrs(NewHeaderFold(""), Provenance{Companion: "another", SourceID: noteID})); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.Root(), "testhost", domain.Blocks.Key, ours.UUID(), ours.UUID()+".block"), []byte("a: [unclosed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fresh := reopen(t, st)
	for _, tc := range []struct {
		name string
		face map[string]string
		want int
	}{
		{"this companion's note", map[string]string{"note_companion": companionID, "note_source_id": noteID.String()}, 1},
		{"every companion's", map[string]string{"note_source_id": noteID.String()}, 2},
		{"another note", map[string]string{"note_companion": companionID, "note_source_id": testID(1).String()}, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			found, err := fresh.Find(KindDigitalNote, tc.face)
			if err != nil || len(found) != tc.want {
				t.Fatalf("found %v, %v; want %d", found, err, tc.want)
			}
			if tc.want == 1 && found[ours.UUID()] == nil {
				t.Errorf("found %v, want %s", found, ours.UUID())
			}
		})
	}
	if _, err := fresh.Load(ours.UUID()); err == nil {
		t.Error("the broken body parsed: the test proves nothing")
	}
}

// A note is called by the name Sieve gave it, otherwise by its tablet's title, and a description
// reads back from .meta as it was written, of the seq it was written at.
func TestDigitalNoteKind_NameAndDescriptionReadFromMeta(t *testing.T) {
	kind := NewDigitalNoteKind()
	for _, tc := range []struct {
		name string
		meta map[string]string
		want string
	}{
		{"no .meta", nil, "Untitled 05/11"},
		{"never named", map[string]string{"display_name": "null"}, "Untitled 05/11"},
		{"named", map[string]string{"display_name": "Kitchen extension planning"}, "Kitchen extension planning"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := kind.Name(tc.meta, "Untitled 05/11"); got != tc.want {
				t.Errorf("Name = %q", got)
			}
			blk := domain.NewSieveBlock(KindDigitalNote, "c", map[string]interface{}{"title": "Untitled 05/11"})
			if got := kind.ContainerName(blk, tc.meta); got != tc.want {
				t.Errorf("ContainerName = %q", got)
			}
		})
	}

	meta := map[string]string{}
	if _, _, ok := kind.Description(meta); ok || kind.SentSeq(meta) != 0 {
		t.Error("an undescribed note reads a description")
	}
	kind.Describe(domain.NewDocumentMeta(meta, func(map[string]string) {}), kitchen, 7)
	d, seq, ok := kind.Description(meta)
	if !ok || seq != 7 || fmt.Sprint(d) != fmt.Sprint(kitchen) {
		t.Errorf("Description = %+v at %d, %t", d, seq, ok)
	}
	kind.MarkSent(domain.NewDocumentMeta(meta, func(map[string]string) {}), 7)
	if kind.SentSeq(meta) != 7 || kind.DescribedSeq(meta) != 7 {
		t.Errorf("sent %d, described %d", kind.SentSeq(meta), kind.DescribedSeq(meta))
	}
}

// The package sits below the editor and the AI subsystem: EditorService and the
// composition root call it, never the reverse.
func TestDigitalNoteKind_PackageImportsNothingAboveBlockContainers(t *testing.T) {
	pkg, err := build.ImportDir(".", 0)
	if err != nil {
		t.Fatalf("ImportDir: %v", err)
	}
	for _, path := range pkg.Imports {
		switch path {
		case "sieve/sieve/editor", "sieve/sieve/ai", "sieve/requesthandlers":
			t.Errorf("imports %s", path)
		}
	}
}
