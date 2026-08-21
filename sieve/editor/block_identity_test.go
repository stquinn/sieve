package editor

import (
	"strings"
	"testing"
	"time"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

// Open mints handles for handle-less prose into the shadow's Doc, so the shadow
// is the single source of identity (load-through-shadow then returns real ids).
func TestOpen_MintsHandlelessProseIntoShadow(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("Just some prose with no handle."))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	shadow := es.shadows[uuid]
	if shadow == nil || len(shadow.Blocks) != 1 {
		t.Fatalf("unexpected shadow doc: %+v", shadow)
	}
	if !ident.Valid(shadow.Blocks[0].ID) {
		t.Fatalf("Open did not mint a durable handle: %q", shadow.Blocks[0].ID)
	}
}

// Re-opening a doc whose prose handle was already persisted keeps the SAME id —
// minting only fills empty handles, so identity is stable across reopen.
func TestOpen_PersistedHandleSurvivesReopen(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("Stable prose."))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open 1: %v", err)
	}
	first := es.shadows[uuid].Blocks[0].ID
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	es.Close(uuid)

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open 2: %v", err)
	}
	second := es.shadows[uuid].Blocks[0].ID
	if second != first {
		t.Fatalf("handle not stable across reopen: %q -> %q", first, second)
	}
}

// A legacy document — short handles minted by the pre-#75 scheme — is upgraded to
// UUIDs the first time it is opened, and in-document refs follow.
func TestOpen_MigratesLegacyBlockIDs(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("<!--s:pr-aaaa-->\nProse.\n<!--/s:pr-aaaa-->\n\n" +
		"```code\nid: co-1\nref: pr-aaaa\nsource: x\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer waitJobs(t, es, uuid)

	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	for i, b := range blocks {
		if !ident.Valid(b.ID) {
			t.Fatalf("block %d id %q not migrated", i, b.ID)
		}
	}
	if got := blocks[1].Ref(); got != blocks[0].ID {
		t.Fatalf("ref not rewritten: %q, want %q", got, blocks[0].ID)
	}
}

// The upgrade must reach DISK at open, not merely sit in memory behind the
// autosave debounce: until it lands, a reopen would mint different ids and any
// address taken from this document — including a block id a dispatched job is
// holding — would stop resolving.
func TestOpen_MigrationPersistsImmediately(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	// A long debounce: if the migration only armed the timer, nothing would be on
	// disk yet and this test would catch it.
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Hour)

	doc, _ := ds.New()
	doc.SetBody([]byte("<!--s:pr-aaaa-->\nProse.\n<!--/s:pr-aaaa-->"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	inMemory := es.shadows[uuid].Blocks[0].ID

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	body := string(reloaded.Body())
	if strings.Contains(body, "pr-aaaa") {
		t.Fatalf("legacy handle still on disk after open:\n%s", body)
	}
	if !strings.Contains(body, inMemory) {
		t.Fatalf("migrated id %q not persisted; disk body:\n%s", inMemory, body)
	}
}

// Open is idempotent: a second Open on an already-open uuid reuses the existing
// shadow (same minted ids, no reload), so load-through-shadow and the WS share
// one identity. (The HTTP load ensures-open before the WS connection does.)
func TestOpen_Idempotent_ReusesShadow(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("Some prose."))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open 1: %v", err)
	}
	shadow1 := es.shadows[uuid]
	id1 := shadow1.Blocks[0].ID

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open 2: %v", err)
	}
	shadow2 := es.shadows[uuid]
	if shadow2 != shadow1 {
		t.Fatal("second Open replaced the shadow instead of reusing it")
	}
	if shadow2.Blocks[0].ID != id1 {
		t.Fatalf("second Open re-minted: %q -> %q", id1, shadow2.Blocks[0].ID)
	}
}

// Load-through-shadow: FrontendBlocks returns the OPEN shadow's blocks, so the
// minted prose handle reaches the client as a real data-id (sync cache seeded).
func TestFrontendBlocks_ReturnsShadowMintedIDs(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("Prose needing a handle."))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	blocks, ok := es.FrontendBlocks(uuid)
	if !ok || len(blocks) != 1 {
		t.Fatalf("FrontendBlocks: ok=%v blocks=%+v", ok, blocks)
	}
	if blocks[0].Kind != block.KindProse || !ident.Valid(blocks[0].ID) {
		t.Fatalf("expected minted prose block, got %+v", blocks[0])
	}
	if blocks[0].Attrs["content"] != "Prose needing a handle." {
		t.Fatalf("content not preserved: %v", blocks[0].Attrs["content"])
	}
}

func TestFrontendBlocks_ClosedDocReturnsFalse(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	if _, ok := es.FrontendBlocks("not-open"); ok {
		t.Fatal("expected ok=false for an unopened uuid")
	}
}
