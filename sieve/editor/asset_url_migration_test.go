package editor

import (
	"strings"
	"testing"
	"time"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/store"
)

// A document whose block ids are ALREADY canonical UUIDs but whose asset URLs
// still name the legacy route owes disk a rewrite at open, exactly as an id
// upgrade does: the debounce is an hour long here, so if MigratedOnLoad only
// tracked identity the rewrite would still be in memory and this would catch it.
// Until it lands, every reopen re-derives the same dead route and the image 404s.
func TestOpen_AssetURLMigrationPersistsImmediately(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewSmartImageProcessor(block.BlockServices{}))
	defer resetRegistry()

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Hour)

	doc, _ := ds.New()
	uuid := doc.UUID()
	blockID := ident.New()
	legacySrc := "/sieve/" + uuid + "/x.png"
	doc.SetBody([]byte("```smart-image\nid: " + blockID +
		"\nsrc: " + legacySrc +
		"\nstatus: COMPLETE\n```"))
	if _, err := ds.Save(doc); err != nil {
		t.Fatalf("Save: %v", err)
	}

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	body := string(reloaded.Body())
	if !strings.Contains(body, store.AssetURL(uuid, "x.png")) {
		t.Fatalf("asset route not migrated on disk after open:\n%s", body)
	}
	if strings.Contains(body, legacySrc) {
		t.Fatalf("legacy asset route still on disk after open:\n%s", body)
	}
	if !strings.Contains(body, blockID) {
		t.Fatalf("block id disturbed by a URL-only migration:\n%s", body)
	}
}
