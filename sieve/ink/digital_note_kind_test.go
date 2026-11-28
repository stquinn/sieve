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
	dir, _ := st.DocDirByUUID(uuid)
	raw, err := os.ReadFile(filepath.Join(dir, ".meta"))
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
	dir, _ := st.DocDirByUUID(uuid)
	if err := os.WriteFile(filepath.Join(dir, ".meta"), raw, 0o644); err != nil {
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
		// wantNames are the names the block's pages carry, "" for a page with none.
		wantNames []string
		// wantProperties is the note attr's properties, nil when it has none.
		wantProperties map[string]interface{}
	}{
		{"an empty note", nil,
			map[string]string{"note_title": "", "note_created": "", "note_pages": "0", "note_device": "", "note_device_id": "", "note_source": "strokes", "note_synced_seq": "0",
				"note_whiteboard": "false", "note_type": "", "note_period": "", "note_properties": "{}"}, 0, nil, nil},
		{"a note of two pages",
			logOf(header("Ideas"), pageAdd(page(1), 0, ruled, link.BoundsFixed), pageAdd(page(2), 1, dots, link.BoundsFixed),
				strokeAdd(page(1), stroke(1))),
			map[string]string{"note_title": "Ideas", "note_created": "2023-11-14T22:13:20Z", "note_pages": "2", "note_device": aDevice.Name, "note_device_id": aDevice.ID, "note_source": "strokes",
				"note_synced_seq": "4", "note_whiteboard": "false", "note_type": "", "note_period": "", "note_properties": "{}"}, 2, []string{"", ""}, nil},
		{"a whiteboard", logOf(header("Board"), pageAdd(page(1), 0, nil, link.BoundsUnbounded)),
			map[string]string{"note_title": "Board", "note_pages": "1", "note_device": aDevice.Name, "note_source": "strokes", "note_synced_seq": "2",
				"note_whiteboard": "true", "note_type": "", "note_properties": "{}"}, 1, []string{""}, nil},
		{"a diary chunk of named pages",
			logOf(header("November"), noteProperty("type", "diary"), noteProperty("period", "2026-11"), noteProperty("x.later", "a", "b"),
				pageAdd(page(1), 0, nil, link.BoundsFixed), pageProperty(page(1), "name", "2026-11-20"), pageAdd(page(2), 1, nil, link.BoundsFixed)),
			map[string]string{"note_title": "November", "note_created": "2023-11-14T22:13:20Z", "note_pages": "2", "note_whiteboard": "false", "note_device_id": aDevice.ID, "note_synced_seq": "7", "note_type": "diary",
				"note_period": "2026-11", "note_named_by": "tablet", "note_properties": `{"period":["2026-11"],"type":["diary"],"x.later":["a","b"]}`}, 2, []string{"2026-11-20", ""},
			map[string]interface{}{"type": []interface{}{"diary"}, "period": []interface{}{"2026-11"}, "x.later": []interface{}{"a", "b"}}},
		{"a period that is not a month", logOf(header("Q4"), noteProperty("period", "2026-Q4")),
			map[string]string{"note_title": "Q4", "note_whiteboard": "false", "note_type": "", "note_period": "", "note_properties": `{"period":["2026-Q4"]}`}, 0, nil,
			map[string]interface{}{"period": []interface{}{"2026-Q4"}}},
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
			header := attrs["note"].(map[string]interface{})
			pages := header["pages"].([]interface{})
			if len(pages) != tc.wantPages {
				t.Errorf("pages %v", pages)
			}
			for i, p := range pages {
				name, named := p.(map[string]interface{})["name"]
				if want := tc.wantNames[i]; named != (want != "") || (named && name != want) {
					t.Errorf("page %d is named %v, want %q", i, name, want)
				}
			}
			if got, held := header["properties"]; held != (tc.wantProperties != nil) || (held && !reflect.DeepEqual(got, tc.wantProperties)) {
				t.Errorf("note properties %#v, want %#v", got, tc.wantProperties)
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
			if _, named := face[domain.MetaKeyNamedBy]; named != (tc.wantFace[domain.MetaKeyNamedBy] != "") {
				t.Errorf("face note_named_by = %v, want %q", face[domain.MetaKeyNamedBy], tc.wantFace[domain.MetaKeyNamedBy])
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
	dir, _ := st.DocDirByUUID(ours.UUID())
	if err := os.WriteFile(filepath.Join(dir, ours.UUID()+".block"), []byte("a: [unclosed\n"), 0o644); err != nil {
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
		{"a diary chunk", map[string]string{"note_type": "diary"}, 0},
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

	diary := NewHeaderFold("")
	for _, r := range logOf(header("November"), noteProperty("type", "diary"), noteProperty("period", "2026-11")) {
		diary.Apply(r)
	}
	chunk, err := fresh.Create(KindDigitalNote, kind.Attrs(diary, Provenance{Companion: companionID, SourceID: testID(2)}))
	if err != nil {
		t.Fatal(err)
	}
	if found, err := fresh.Find(KindDigitalNote, map[string]string{"note_type": "diary", "note_device_id": aDevice.ID}); err != nil || len(found) != 1 || found[chunk.UUID()] == nil {
		t.Errorf("the diary chunk found as %v, %v", found, err)
	}
	diary.Apply(link.Record{Seq: 4, Op: link.OpNoteProperty, Key: "type"})
	chunk.Merge(kind.Attrs(diary, Provenance{Companion: companionID, SourceID: testID(2)}))
	if _, err := fresh.Save(chunk); err != nil {
		t.Fatal(err)
	}
	if found, err := fresh.Find(KindDigitalNote, map[string]string{"note_type": "diary"}); err != nil || len(found) != 0 {
		t.Errorf("a note whose type was removed is still found as a diary chunk: %v, %v", found, err)
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
		{"named by its tablet", map[string]string{"display_name": "Kitchen extension planning", "note_named_by": "tablet"}, "Untitled 05/11"},
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
	if !kind.Unsent(meta) {
		t.Error("a description never sent is not unsent")
	}
	kind.MarkSent(domain.NewDocumentMeta(meta, func(map[string]string) {}), 7)
	if kind.SentSeq(meta) != 7 || kind.DescribedSeq(meta) != 7 || kind.Unsent(meta) {
		t.Errorf("sent %d, described %d, unsent %t", kind.SentSeq(meta), kind.DescribedSeq(meta), kind.Unsent(meta))
	}
}

// A name given by hand is the note's name and its description's title, kept by Describe, which
// still writes the rest, and is unsent at the seq already sent; with no description it is one of
// no seq. Cleared, the note is called by its tablet's title and holds no description of any seq.
func TestDigitalNoteKind_ANameGivenByHand(t *testing.T) {
	kind := NewDigitalNoteKind()
	edit := func(meta map[string]string) domain.DocumentMeta {
		return domain.NewDocumentMeta(meta, func(map[string]string) {})
	}

	fresh := map[string]string{}
	kind.NameByHand(edit(fresh), "Mine")
	if d, seq, ok := kind.Description(fresh); !ok || seq != 0 || d.Title != "Mine" || !kind.Unsent(fresh) || kind.NamedBy(fresh) != NamedByHand {
		t.Errorf("an undescribed note named by hand: %+v at %d, %t, unsent %t", d, seq, ok, kind.Unsent(fresh))
	}

	meta := map[string]string{}
	kind.Describe(edit(meta), kitchen, 7)
	kind.MarkSent(edit(meta), 7)
	kind.NameByHand(edit(meta), "Mine")
	if kind.Name(meta, "Ideas") != "Mine" || !kind.Unsent(meta) {
		t.Errorf("named by hand: %q, unsent %t", kind.Name(meta, "Ideas"), kind.Unsent(meta))
	}
	kind.Describe(edit(meta), domain.NoteMetadata{Title: "The AI's", Summary: "Revised."}, 9)
	if d, seq, _ := kind.Description(meta); d.Title != "Mine" || d.Summary != "Revised." || seq != 9 {
		t.Errorf("described over a name given by hand: %+v at %d", d, seq)
	}

	kind.NameByHand(edit(meta), "")
	if _, seq, ok := kind.Description(meta); kind.Name(meta, "Ideas") != "Ideas" || ok || seq != 0 || kind.NamedBy(meta) != NamedByNamer || kind.Unsent(meta) {
		t.Errorf("cleared: called %q, a description of %d (%t)", kind.Name(meta, "Ideas"), seq, ok)
	}
	kind.Describe(edit(meta), kitchen, 9)
	if kind.Name(meta, "Ideas") != kitchen.Title || !kind.Unsent(meta) {
		t.Errorf("described after clearing: %q, unsent %t", kind.Name(meta, "Ideas"), kind.Unsent(meta))
	}
}

// The package sits below the editor and the AI subsystem: EditorService and the
// composition root call it, never the reverse.
// Who names a note decides whether the namer keeps its name and whether a person may rename it.
// A note its tablet names is called by the tablet's title: Describe writes the rest and no
// display_name, its description's title is empty, and it is unsent only once described.
func TestDigitalNoteKind_ANoteItsTabletNames(t *testing.T) {
	for _, tc := range []struct {
		by              NamedBy
		kept, renamable bool
	}{
		{NamedByNamer, false, true},
		{NamedByHand, true, true},
		{NamedByTablet, true, false},
	} {
		if tc.by.Kept() != tc.kept || tc.by.Renamable() != tc.renamable {
			t.Errorf("%q: kept %t, renamable %t", tc.by, tc.by.Kept(), tc.by.Renamable())
		}
	}

	kind := NewDigitalNoteKind()
	meta := map[string]string{"note_named_by": "tablet"}
	if _, _, ok := kind.Description(meta); ok || kind.Unsent(meta) {
		t.Error("an undescribed note its tablet names reads a description")
	}
	kind.Describe(domain.NewDocumentMeta(meta, func(map[string]string) {}), kitchen, 7)
	d, seq, ok := kind.Description(meta)
	if _, given := meta["display_name"]; given || kind.Name(meta, "November") != "November" {
		t.Errorf("described: display_name %q, called %q", meta["display_name"], kind.Name(meta, "November"))
	}
	if !ok || seq != 7 || d.Title != "" || d.Summary != kitchen.Summary || fmt.Sprint(d.Keywords) != fmt.Sprint(kitchen.Keywords) || !kind.Unsent(meta) {
		t.Errorf("Description = %+v at %d, %t, unsent %t", d, seq, ok, kind.Unsent(meta))
	}
}

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
