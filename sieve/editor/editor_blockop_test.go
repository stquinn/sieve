package editor

import (
	"crypto/sha1"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/services"
)

// onChangeProbeProcessor isolates the uniform update pipeline: OnChange stamps a
// marker (proving the pipeline invoked it) and InitAttrs seeds COMPLETE (never
// PENDING) so an update dispatches no background job — keeping the test
// deterministic (no goroutine racing temp-dir cleanup).
type onChangeProbeProcessor struct {
	testRunJobProcessor
}

func (p *onChangeProbeProcessor) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id, "status": block.BlockStatusComplete}
	for k, v := range overrides {
		attrs[k] = v
	}
	return attrs
}

func (p *onChangeProbeProcessor) OnChange(blk *block.SieveBlock) {
	if blk.Attrs == nil {
		blk.Attrs = map[string]interface{}{}
	}
	blk.Attrs["onChangeRan"] = "yes"
}

func frontendBlockByID(t *testing.T, es *EditorService, uuid, id string) block.FrontendBlock {
	t.Helper()
	blocks, ok := es.FrontendBlocks(uuid)
	if !ok {
		t.Fatalf("FrontendBlocks: no shadow for %q", uuid)
	}
	for _, b := range blocks {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("block %q not found among %d", id, len(blocks))
	return block.FrontendBlock{}
}

// blockIDOfKind returns the id of the first block of kind in the open document.
// Fixture bodies are written with readable legacy handles ("pb-1", "co-1"), which
// NewShadow upgrades to UUIDs on load (#75), so a test that needs to address a
// fixture block asks for its real id instead of naming one.
func blockIDOfKind(t *testing.T, es *EditorService, uuid, kind string) string {
	t.Helper()
	blocks, ok := es.FrontendBlocks(uuid)
	if !ok {
		t.Fatalf("FrontendBlocks: no shadow for %q", uuid)
	}
	for _, b := range blocks {
		if b.Kind == kind {
			return b.ID
		}
	}
	t.Fatalf("no %q block among %d", kind, len(blocks))
	return ""
}

// The converged update-block op runs the FULL uniform pipeline for a structured
// block: MERGE the partial patch (keep existing keys, not replace), run
// processor.OnChange, and notify the client with the merged result — the behaviour
// the retired block-update message had, now reached through the single block-op path.
func TestHandleBlockOp_structuredUpdateMergesRunsOnChangeAndNotifies(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&onChangeProbeProcessor{
		testRunJobProcessor: testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "probe"}},
	})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	var notified map[string]interface{}
	notifyCalled := make(chan struct{}, 1)
	es.SetLifecycleListener(&mockLifecycleListener{
		onUpdated: func(_, _ string, attrs map[string]interface{}) {
			notified = attrs
			select {
			case notifyCalled <- struct{}{}:
			default:
			}
		},
	})

	doc, _ := ds.New()
	doc.SetBody([]byte("```probe\nid: pb-1\nkeep: original\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	probeID := blockIDOfKind(t, es, uuid, "probe")

	// Partial patch — only `add`. `keep` must survive (merge, not replace).
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", BlockID: probeID, Kind: "probe",
		Attrs: map[string]interface{}{"add": "new"},
	}); err != nil {
		t.Fatalf("HandleBlockOp update: %v", err)
	}

	select {
	case <-notifyCalled:
	case <-time.After(2 * time.Second):
		t.Fatal("update-block did not notify the client")
	}

	blk := frontendBlockByID(t, es, uuid, probeID)
	if got, _ := blk.Attrs["keep"].(string); got != "original" {
		t.Errorf("merge dropped existing attr: keep=%q (want \"original\")", got)
	}
	if got, _ := blk.Attrs["add"].(string); got != "new" {
		t.Errorf("patch not applied: add=%q (want \"new\")", got)
	}
	if got, _ := blk.Attrs["onChangeRan"].(string); got != "yes" {
		t.Errorf("processor.OnChange did not run: onChangeRan=%q", got)
	}
	if notified["add"] != "new" || notified["onChangeRan"] != "yes" {
		t.Errorf("notify did not carry merged+OnChanged attrs: %v", notified)
	}
}

// Prose is NOT special on the op path: its body rides in attrs.content like every
// other kind, and an update MERGES it. Aliases (a real block field, optional on the
// op) are preserved when the patch omits them and replaced when it carries them.
// Guards the removal of op.Content + the KindProse branch in applyOpTo.
func TestHandleBlockOp_proseUpdateUsesAttrsContentAndKeepsAliases(t *testing.T) {
	resetRegistry() // registers the prose terminal

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("seed"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Seed a prose block with its body in attrs.content and an alias.
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: fixtureID("pr-1"),
		Attrs: map[string]interface{}{"content": "hello"}, Aliases: []string{"old-alias"}, Index: 0,
	}); err != nil {
		t.Fatalf("seed create: %v", err)
	}

	// Update with NO aliases: content updates via attrs.content, alias preserved.
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", Kind: "prose", BlockID: fixtureID("pr-1"),
		Attrs: map[string]interface{}{"content": "hello world"},
	}); err != nil {
		t.Fatalf("update (no aliases): %v", err)
	}
	blk := frontendBlockByID(t, es, uuid, fixtureID("pr-1"))
	if got, _ := blk.Attrs["content"].(string); got != "hello world" {
		t.Errorf("prose content not updated via attrs.content: %q", got)
	}
	if len(blk.Aliases) != 1 || blk.Aliases[0] != "old-alias" {
		t.Errorf("alias not preserved on attr-only update: %v", blk.Aliases)
	}

	// Update WITH aliases: replaced.
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", Kind: "prose", BlockID: fixtureID("pr-1"),
		Attrs: map[string]interface{}{"content": "hello world"}, Aliases: []string{"new-alias"},
	}); err != nil {
		t.Fatalf("update (with aliases): %v", err)
	}
	blk = frontendBlockByID(t, es, uuid, fixtureID("pr-1"))
	if len(blk.Aliases) != 1 || blk.Aliases[0] != "new-alias" {
		t.Errorf("alias not replaced: %v", blk.Aliases)
	}
}

// Create is uniform for EVERY kind, prose included: a create-block runs the one
// create lifecycle and notifies the client (render-back). The backend does not
// branch on kind — "the editor already holds this node" is the client's concern
// (it suppresses the redundant insert: insert-if-absent), not the backend's.
// Guards the removal of the KindProse fork in HandleBlockOp.
func TestHandleBlockOp_proseCreateNotifiesLikeEveryKind(t *testing.T) {
	resetRegistry() // registers the prose terminal

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	created := make(chan string, 1)
	es.SetLifecycleListener(&mockLifecycleListener{
		onCreated: func(_, _, blockID, _ string) {
			select {
			case created <- blockID:
			default:
			}
		},
	})

	doc, _ := ds.New()
	doc.SetBody([]byte("seed"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: fixtureID("pr-1"),
		Attrs: map[string]interface{}{"content": "hello"}, Index: 0,
	}); err != nil {
		t.Fatalf("create-block: %v", err)
	}

	select {
	case id := <-created:
		if id != fixtureID("pr-1") {
			t.Errorf("notified for wrong block: %q (want pr-1)", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("prose create-block did not notify the client — still on the forked path")
	}

	// The block still lands in the tree with its content (existing behavior preserved).
	blk := frontendBlockByID(t, es, uuid, fixtureID("pr-1"))
	if got, _ := blk.Attrs["content"].(string); got != "hello" {
		t.Errorf("prose content missing after create: %q (want \"hello\")", got)
	}
}

// seedProse opens an EMPTY document and creates one prose block per id, in
// order, so the ids under test are the document's whole order (any body text
// would parse into a prose block of its own).
// fixtureID turns a readable test label ("pr-1") into a REAL uuid, because the
// server now VALIDATES the ids a client supplies (issue #96) and a short handle
// is not one. Deterministic, so a test can name the same block twice and mean it.
func fixtureID(label string) string {
	sum := sha1.Sum([]byte(label))
	return fmt.Sprintf("00000000-0000-7000-8000-%x", sum[:6])
}

func seedProse(t *testing.T, es *EditorService, ds *services.DocumentService, ids ...string) string {
	t.Helper()
	doc, _ := ds.New()
	doc.SetBody(nil)
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	for i, id := range ids {
		if err := es.HandleBlockOp(uuid, block.BlockOp{
			Type: "create-block", Kind: "prose", BlockID: id,
			Attrs: map[string]interface{}{"content": id}, Index: i,
		}); err != nil {
			t.Fatalf("seed create %s: %v", id, err)
		}
	}
	if got := frontendIDs(t, es, uuid); !reflect.DeepEqual(got, ids) {
		t.Fatalf("seeded document holds %v, want %v", got, ids)
	}
	return uuid
}

// Every mutation echoes (#96): a delete-block the server applied must reach the
// client as its own render-back, or a follower model can only learn of the
// deletion by reloading the document.
func TestHandleBlockOp_deleteEchoesTheRemovedBlock(t *testing.T) {
	resetRegistry() // registers the prose terminal

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	uuid := seedProse(t, es, ds, fixtureID("pr-1"), fixtureID("pr-2"), fixtureID("pr-3"))

	var removed []string
	var orders [][]string
	es.SetLifecycleListener(&mockLifecycleListener{
		onRemoved: func(_, blockID string) { removed = append(removed, blockID) },
		onOrder:   func(_ string, order []string) { orders = append(orders, order) },
	})

	if err := es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: fixtureID("pr-2")}); err != nil {
		t.Fatalf("delete-block: %v", err)
	}

	if want := []string{fixtureID("pr-2")}; !reflect.DeepEqual(removed, want) {
		t.Errorf("removed echoes: %v, want %v", removed, want)
	}
	// Losing the id IS the order change: a second event for one mutation would be
	// a second repaint.
	if len(orders) != 0 {
		t.Errorf("a delete also echoed an order change: %v", orders)
	}
	if got := frontendIDs(t, es, uuid); !reflect.DeepEqual(got, []string{fixtureID("pr-1"), fixtureID("pr-3")}) {
		t.Errorf("tree after delete: %v", got)
	}
}

// A set-order echoes the container's COMPLETE new order, read back from the
// document rather than repeated off the request.
func TestHandleBlockOp_setOrderEchoesTheWholeNewOrder(t *testing.T) {
	resetRegistry()

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	uuid := seedProse(t, es, ds, fixtureID("pr-1"), fixtureID("pr-2"), fixtureID("pr-3"))

	var orders [][]string
	var removed []string
	es.SetLifecycleListener(&mockLifecycleListener{
		onOrder:   func(_ string, order []string) { orders = append(orders, order) },
		onRemoved: func(_, blockID string) { removed = append(removed, blockID) },
	})

	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "set-order", Order: []string{fixtureID("pr-3"), fixtureID("pr-1"), fixtureID("pr-2")},
	}); err != nil {
		t.Fatalf("set-order: %v", err)
	}

	want := [][]string{{fixtureID("pr-3"), fixtureID("pr-1"), fixtureID("pr-2")}}
	if !reflect.DeepEqual(orders, want) {
		t.Errorf("order echoes: %v, want %v", orders, want)
	}
	if len(removed) != 0 {
		t.Errorf("a reorder echoed a removal: %v", removed)
	}
	if got := frontendIDs(t, es, uuid); !reflect.DeepEqual(got, []string{fixtureID("pr-3"), fixtureID("pr-1"), fixtureID("pr-2")}) {
		t.Errorf("tree after set-order: %v", got)
	}
}

// A move is a reorder by another name, and echoes the order it produced — the
// op names an index, so only the document knows the result.
func TestHandleBlockOp_moveEchoesTheResultingOrder(t *testing.T) {
	resetRegistry()

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	uuid := seedProse(t, es, ds, fixtureID("pr-1"), fixtureID("pr-2"), fixtureID("pr-3"))

	var orders [][]string
	es.SetLifecycleListener(&mockLifecycleListener{
		onOrder: func(_ string, order []string) { orders = append(orders, order) },
	})

	if err := es.HandleBlockOp(uuid, block.BlockOp{Type: "move", BlockID: fixtureID("pr-3"), Index: 0}); err != nil {
		t.Fatalf("move: %v", err)
	}

	want := [][]string{{fixtureID("pr-3"), fixtureID("pr-1"), fixtureID("pr-2")}}
	if !reflect.DeepEqual(orders, want) {
		t.Errorf("order echoes: %v, want %v", orders, want)
	}
}

// An op that did not apply changed nothing, so it must echo nothing: a client
// that repainted on a refused delete would drop a block the document still holds.
func TestHandleBlockOp_refusedStructuralOpsEchoNothing(t *testing.T) {
	resetRegistry()

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	uuid := seedProse(t, es, ds, fixtureID("pr-1"), fixtureID("pr-2"))

	var echoes int
	es.SetLifecycleListener(&mockLifecycleListener{
		onRemoved: func(string, string) { echoes++ },
		onOrder:   func(string, []string) { echoes++ },
	})

	if err := es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: "ghost"}); err == nil {
		t.Fatal("deleting an unheld block was accepted")
	}
	// set-order refuses anything but a permutation — this one drops pr-2.
	if err := es.HandleBlockOp(uuid, block.BlockOp{Type: "set-order", Order: []string{fixtureID("pr-1")}}); err == nil {
		t.Fatal("a set-order that is not a permutation was accepted")
	}
	if echoes != 0 {
		t.Errorf("%d echo(es) fired for ops that did not apply", echoes)
	}
}

// frontendIDs returns the open document's top-level block ids in order.
func frontendIDs(t *testing.T, es *EditorService, uuid string) []string {
	t.Helper()
	blocks, ok := es.FrontendBlocks(uuid)
	if !ok {
		t.Fatalf("FrontendBlocks: no shadow for %q", uuid)
	}
	ids := make([]string, len(blocks))
	for i, b := range blocks {
		ids[i] = b.ID
	}
	return ids
}

// C.2b — EditorService.HandleBlockOp applies a wire op to the open shadow's Doc
// and the change persists on flush.
func TestEditorService_HandleBlockOp_UpdatesAndPersists(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody([]byte("Intro.\n\n```code\nid: co-1\nsource: x = 1\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	codeID := blockIDOfKind(t, es, uuid, "code")
	err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "update-block", BlockID: codeID, Kind: "code",
		Attrs: map[string]interface{}{"id": codeID, "source": "y = 2"},
	})
	if err != nil {
		t.Fatalf("HandleBlockOp: %v", err)
	}
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	reloaded, _ := ds.LoadByUUID(uuid)
	body := string(reloaded.Body())
	if !strings.Contains(body, "source: y = 2") || strings.Contains(body, "source: x = 1") {
		t.Fatalf("op not persisted, disk body:\n%s", body)
	}
}

func TestEditorService_HandleBlockOp_NoShadowErrors(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	if err := es.HandleBlockOp("missing", block.BlockOp{Type: "update-block", BlockID: "x"}); err == nil {
		t.Fatal("expected error when no document is open")
	}
}

// C.1 — the disk-direct job-update path (no open shadow) must also go through
// the serialization spine, not InjectBlocks. Characterization test: behavior is
// preserved across the refactor.
func TestApplyJobUpdate_NoShadow_WritesViaSpine(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "ai-block"}})

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	// A real ai-block id is a UUID (#75). It matters here specifically: this path
	// transiently REOPENS the document, and a job carries the block id it was
	// dispatched with — so the id on disk must be the one the job holds.
	const abID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a11"
	doc.SetBody([]byte("```ai-block\nid: " + abID + "\nresponse: old\nstatus: PENDING\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()

	// No Open → no shadow → disk-direct branch.
	es.applyJobUpdate(uuid, abID, "ai-block",
		map[string]interface{}{"response": "new", "status": "COMPLETE"}, nil, "test")

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	body := string(reloaded.Body())
	if !strings.Contains(body, "response: new") {
		t.Fatalf("expected updated response on disk, got:\n%s", body)
	}
	if strings.Contains(body, "response: old") {
		t.Fatalf("stale response still on disk:\n%s", body)
	}
}
