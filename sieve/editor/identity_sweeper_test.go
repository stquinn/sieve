package editor

import (
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/services"
)

func newSweeper(t *testing.T) (*IdentitySweeper, *services.DocumentService) {
	t.Helper()
	ds, _ := newTestDocumentService(t)
	return NewIdentitySweeper(ds, block.NewDocumentCodec(block.GlobalRegistry())), ds
}

func saveDoc(t *testing.T, ds *services.DocumentService, body string) string {
	t.Helper()
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc.SetBody([]byte(body))
	if _, err := ds.Save(doc); err != nil {
		t.Fatalf("Save: %v", err)
	}
	return doc.UUID()
}

func TestSweepLibrary_UpgradesLegacyDocument(t *testing.T) {
	resetRegistry()
	sweeper, ds := newSweeper(t)
	uuid := saveDoc(t, ds, "<!--s:pr-aaaa-->\nProse.\n<!--/s:pr-aaaa-->\n\n"+
		"<!--s:pr-bbbb-->\nMore.\n<!--/s:pr-bbbb-->")

	got := sweeper.SweepLibrary()
	if got.Scanned != 1 || got.Migrated != 1 {
		t.Fatalf("result = %+v, want 1 scanned / 1 migrated", got)
	}
	if got.BlocksReidentified != 2 {
		t.Fatalf("blocks re-identified = %d, want 2", got.BlocksReidentified)
	}
	if len(got.Failures) != 0 {
		t.Fatalf("unexpected failures: %v", got.Failures)
	}

	doc, _ := ds.LoadByUUID(uuid)
	body := string(doc.Body())
	if strings.Contains(body, "pr-aaaa") || strings.Contains(body, "pr-bbbb") {
		t.Fatalf("legacy handles still on disk:\n%s", body)
	}
	blocks, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(body)
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	for i, b := range blocks {
		if !ident.Valid(b.ID) {
			t.Fatalf("block %d id %q is not a uuid", i, b.ID)
		}
	}
}

// The sweep reaches documents lazy migration never would, because nobody opened
// them — that is the entire reason it exists.
func TestSweepLibrary_CoversEveryDocument(t *testing.T) {
	resetRegistry()
	sweeper, ds := newSweeper(t)
	saveDoc(t, ds, "<!--s:pr-aaaa-->\nOne.\n<!--/s:pr-aaaa-->")
	saveDoc(t, ds, "<!--s:pr-bbbb-->\nTwo.\n<!--/s:pr-bbbb-->")
	saveDoc(t, ds, "<!--s:pr-cccc-->\nThree.\n<!--/s:pr-cccc-->")

	got := sweeper.SweepLibrary()
	if got.Scanned != 3 || got.Migrated != 3 {
		t.Fatalf("result = %+v, want 3 scanned / 3 migrated", got)
	}
}

// A second sweep must find nothing to do, and must not rewrite anything — no
// version churn for a library that is already migrated.
func TestSweepLibrary_IsIdempotent(t *testing.T) {
	resetRegistry()
	sweeper, ds := newSweeper(t)
	uuid := saveDoc(t, ds, "<!--s:pr-aaaa-->\nProse.\n<!--/s:pr-aaaa-->")

	if got := sweeper.SweepLibrary(); got.Migrated != 1 {
		t.Fatalf("first sweep: %+v", got)
	}
	afterFirst, _ := ds.LoadByUUID(uuid)
	bodyAfterFirst := string(afterFirst.Body())

	got := sweeper.SweepLibrary()
	if got.Migrated != 0 || got.BlocksReidentified != 0 {
		t.Fatalf("second sweep did work: %+v", got)
	}
	if got.Scanned != 1 {
		t.Fatalf("second sweep scanned %d, want 1", got.Scanned)
	}
	afterSecond, _ := ds.LoadByUUID(uuid)
	if string(afterSecond.Body()) != bodyAfterFirst {
		t.Fatalf("second sweep rewrote a migrated document:\n%s\n---\n%s",
			bodyAfterFirst, string(afterSecond.Body()))
	}
}

func TestSweepLibrary_RewritesRefs(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	sweeper, ds := newSweeper(t)
	uuid := saveDoc(t, ds, "<!--s:pr-aaaa-->\nTarget.\n<!--/s:pr-aaaa-->\n\n"+
		"```code\nid: co-1\nref: pr-aaaa\nsource: x\n```")

	if got := sweeper.SweepLibrary(); got.Migrated != 1 {
		t.Fatalf("sweep: %+v", got)
	}

	doc, _ := ds.LoadByUUID(uuid)
	blocks, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(string(doc.Body()))
	if err != nil {
		t.Fatalf("reparse: %v", err)
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d:\n%s", len(blocks), doc.Body())
	}
	if got := blocks[1].Ref(); got != blocks[0].ID {
		t.Fatalf("ref not rewritten: %q, want %q", got, blocks[0].ID)
	}
}

func TestSweepLibrary_NoLibraryReportsFailure(t *testing.T) {
	got := NewIdentitySweeper(nil, nil).SweepLibrary()
	if len(got.Failures) != 1 {
		t.Fatalf("want one failure, got %+v", got)
	}
}

func TestSweepLibrary_EmptyLibraryIsClean(t *testing.T) {
	resetRegistry()
	sweeper, _ := newSweeper(t)
	got := sweeper.SweepLibrary()
	if got.Scanned != 0 || got.Migrated != 0 || len(got.Failures) != 0 {
		t.Fatalf("empty library: %+v", got)
	}
}
