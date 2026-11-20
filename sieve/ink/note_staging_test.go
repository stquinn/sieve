package ink

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"sieve/ident"
	"sieve/sieve/ink/link"
)

// Appends to one container's staged file accumulate, and Resume reads them back as the records
// that follow the cursor given, until Drop; another container's file is its own.
func TestNoteStaging_ResumesWhatWasAppendedUntilDropped(t *testing.T) {
	records := strokesLog(4)
	staging := NewNoteStaging(filepath.Join(t.TempDir(), "sieve-ink"))
	uuid, other := ident.New(), ident.New()
	var from link.Cursor
	for _, rec := range records[:2] {
		body, _ := rec.Body()
		if err := from.Accept(rec, body); err != nil {
			t.Fatal(err)
		}
	}
	if staged, err := staging.Resume(uuid, from); err != nil || len(staged.Records) != 0 {
		t.Fatalf("nothing staged resumed as %+v, %v", staged, err)
	}
	for _, part := range [][]link.Record{records[2:3], records[3:]} {
		if err := staging.Append(uuid, jsonlOf(t, part)); err != nil {
			t.Fatal(err)
		}
	}
	if err := staging.Append(other, jsonlOf(t, records[:1])); err != nil {
		t.Fatal(err)
	}
	staged, err := staging.Resume(uuid, from)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := ReadStrokeBasedNote(uuid, nil).Read(jsonlOf(t, records))
	if !bytes.Equal(staged.Bytes, jsonlOf(t, records[2:])) || len(staged.Records) != len(records)-2 || staged.Records[0].Seq != 3 || staged.Cursor != want {
		t.Errorf("resumed %d records to seq %d", len(staged.Records), staged.Cursor.Seq)
	}
	if err := staging.Drop(uuid); err != nil {
		t.Fatal(err)
	}
	if err := staging.Drop(uuid); err != nil {
		t.Errorf("dropping nothing: %v", err)
	}
	if staged, err := staging.Resume(uuid, from); err != nil || len(staged.Records) != 0 {
		t.Errorf("a dropped file resumed as %+v, %v", staged, err)
	}
	if staged, err := staging.Resume(other, link.Cursor{}); err != nil || len(staged.Records) != 1 {
		t.Errorf("the other container's file resumed as %+v, %v", staged, err)
	}
	if entries, _ := os.ReadDir(staging.dir); len(entries) != 1 {
		t.Errorf("staging holds %d files", len(entries))
	}
}

// A name that is not a container uuid never reaches the file system.
func TestNoteStaging_RefusesWhatIsNoContainerUUID(t *testing.T) {
	staging := NewNoteStaging(t.TempDir())
	for _, uuid := range []string{"", "../escape", "not-a-uuid"} {
		if err := staging.Append(uuid, []byte("x\n")); err == nil {
			t.Errorf("Append(%q) was taken", uuid)
		}
		if _, err := staging.Resume(uuid, link.Cursor{}); err == nil {
			t.Errorf("Resume(%q) was taken", uuid)
		}
		if err := staging.Drop(uuid); err == nil {
			t.Errorf("Drop(%q) was taken", uuid)
		}
	}
}
