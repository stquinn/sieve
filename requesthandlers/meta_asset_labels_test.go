package requesthandlers

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store"
	"sieve/store/filestore"
)

// fakeAsset is the minimum of store.AssetStorable these views read.
type fakeAsset struct {
	store.AssetStorable
	ref   string
	blkID string
	body  []byte
}

func (f fakeAsset) ExternalRef() string { return f.ref }
func (f fakeAsset) BlkID() string       { return f.blkID }
func (f fakeAsset) Body() []byte        { return f.body }

func TestAssetViews_labelledByTheirOwningBlock(t *testing.T) {
	// An asset is stored as <blockID><ext>, so the tab would otherwise list two
	// uuids and leave a user unable to tell two JSON files apart.
	assets := []store.Storable{
		fakeAsset{ref: "store/doc/01a01bcd-273b.json", blkID: "01a01bcd-273b"},
		fakeAsset{ref: "store/doc/01a01bcd-3ec8.json", blkID: "01a01bcd-3ec8"},
	}
	labels := map[string]assetLabel{
		"01a01bcd-273b": {Name: "swagger.yml"},
		"01a01bcd-3ec8": {Name: "payments-fixture.json"},
	}

	views := toAssetViews(testAssetDoc, assets, labelled(labels))
	if len(views) != 2 {
		t.Fatalf("views: got %d, want 2", len(views))
	}
	if views[0].Name != "swagger.yml" {
		t.Errorf("Name: got %q, want the owning block's title", views[0].Name)
	}
	if views[1].Name != "payments-fixture.json" {
		t.Errorf("Name: got %q, want the owning block's title", views[1].Name)
	}
	// The stored name survives for the tooltip — it is what you need when reading
	// the document directory by hand.
	if views[0].FileName != "01a01bcd-273b.json" {
		t.Errorf("FileName: got %q, want the name on disk", views[0].FileName)
	}
}

func TestAssetViews_unclaimedAssetKeepsItsFilename(t *testing.T) {
	// No block claims it (a smart-card's OG image is stored as <blockID>-img, so
	// it never matches) — the row must still be identifiable, not blank.
	views := toAssetViews(
		testAssetDoc,
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-9f2b-img.png", blkID: "01a01bcd-9f2b-img"}},
		labelled(map[string]assetLabel{"01a01bcd-9f2b": {Name: "Auth Design"}}),
	)
	if len(views) != 1 {
		t.Fatalf("views: got %d, want 1", len(views))
	}
	if views[0].Name != "01a01bcd-9f2b-img.png" {
		t.Errorf("Name: got %q, want the filename fallback", views[0].Name)
	}
}

func TestAssetViews_describedImageKeepsBothNameAndDescription(t *testing.T) {
	// An image that arrived as a file has BOTH: the name it came under and the AI's
	// description of it. The description must not displace the name — a description
	// says what a thing is, never which one it is.
	views := toAssetViews(
		testAssetDoc,
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-273b.png", blkID: "01a01bcd-273b"}},
		labelled(map[string]assetLabel{"01a01bcd-273b": {Name: "diagram.png", Detail: "A dark-themed editor screenshot"}}),
	)
	if views[0].Name != "diagram.png" {
		t.Errorf("Name: got %q, want the filename it arrived under", views[0].Name)
	}
	if views[0].Detail != "A dark-themed editor screenshot" {
		t.Errorf("Detail: got %q, want the description", views[0].Detail)
	}
}

func TestAssetViews_pastedImageFallsBackToItsDescription(t *testing.T) {
	// A clipboard paste has no filename, so there is nothing to name it but the
	// description — which still beats showing a uuid.
	views := toAssetViews(
		testAssetDoc,
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-9f2b.png", blkID: "01a01bcd-9f2b"}},
		labelled(map[string]assetLabel{"01a01bcd-9f2b": {Detail: "A dark-themed editor screenshot"}}),
	)
	if views[0].Name != "A dark-themed editor screenshot" {
		t.Errorf("Name: got %q, want the description as the fallback", views[0].Name)
	}
	if views[0].Detail != "" {
		t.Errorf("Detail: got %q, want it empty rather than repeating the name", views[0].Detail)
	}
}

func TestAssetViews_unreadableBlocksAreSafe(t *testing.T) {
	// A document whose blocks cannot be read yields an empty index. A label is a
	// nicety, so the panel still renders; whether a block holds the asset is not
	// known, so it is never offered as unused.
	views := toAssetViews(
		testAssetDoc,
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-273b.png", blkID: "01a01bcd-273b"}},
		assetIndex{},
	)
	if len(views) != 1 || views[0].Name != "01a01bcd-273b.png" {
		t.Fatalf("got %+v, want the filename fallback", views)
	}
	if !views[0].InUse {
		t.Error("an unread document's asset must not be deletable")
	}
}

func TestAssetViews_labelledByOpaqueAssetKeyOrStem(t *testing.T) {
	assets := []store.Storable{
		fakeAsset{ref: "store/doc/0194820a-81c2-7d34.png", blkID: "0194820a-81c2-7d34"},
		fakeAsset{ref: "store/doc/0194820a-9999-7d34.svg", blkID: "0194820a-9999-7d34"},
	}
	labels := map[string]assetLabel{
		"0194820a-81c2-7d34.png": {Name: "Architecture Diagram"},
		"0194820a-9999-7d34":     {Name: "Flowchart"},
	}

	views := toAssetViews(testAssetDoc, assets, labelled(labels))
	if len(views) != 2 {
		t.Fatalf("views: got %d, want 2", len(views))
	}
	if views[0].Name != "Architecture Diagram" {
		t.Errorf("views[0].Name: got %q, want %q", views[0].Name, "Architecture Diagram")
	}
	if views[1].Name != "Flowchart" {
		t.Errorf("views[1].Name: got %q, want %q", views[1].Name, "Flowchart")
	}
}

// testAssetDoc is the document the view tests' assets belong to.
const testAssetDoc = "0194820a-0000-7d34-8000-00000000d0c0"

// labelled is an index of a readable document holding no asset, carrying labels.
func labelled(labels map[string]assetLabel) assetIndex {
	return assetIndex{labels: labels, known: true}
}

// One walk of the blocks answers both questions: what each asset is called, and
// which block holds it. Only a holder whose kind places its held assets (a
// smart-image, a reference) is named for a placement to carry its view.
func TestIndexBlocks_labelsAndHoldersFromOneWalk(t *testing.T) {
	block.RegisterProcessor(processors.NewSmartImageProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewReferenceProcessor(block.BlockServices{}))

	const doc = "0194820a-0000-7d34-8000-00000000d0c1"
	const other = "0194820a-0000-7d34-8000-00000000d0c2"
	docBody := "```smart-image\nid: img-blk-1\nsrc: sieve://" + doc + "/0194820a-81c2-7d34.png\ntitle: Architecture\n```\n\n" +
		"```diagram\nid: diag-blk-1\nsvgAsset: /0194820a-9999-7d34.svg\nsummary: Flowchart\n```\n\n" +
		"```reference\nid: ref-blk-1\nuri: sieve://" + doc + "/日本.pdf\ncache:\n  title: Plan.pdf\n```\n\n" +
		"```reference\nid: ref-blk-3\nuri: sieve://" + doc + "/caf%C3%A9.pdf\ncache:\n  title: Menu.pdf\n```\n\n" +
		"```reference\nid: ref-blk-2\nuri: sieve://" + other + "/foreign.pdf\ncache:\n  title: Foreign\n```\n"
	blocks, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(docBody)
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	idx := (&MetaHandler{}).indexBlocks(doc, blocks)
	for _, tc := range []struct {
		key, name, detail string
	}{
		{"img-blk-1", "Architecture", ""},
		{"0194820a-81c2-7d34.png", "Architecture", ""},
		{"0194820a-81c2-7d34", "Architecture", ""},
		{"0194820a-9999-7d34.svg", "", "Flowchart"},
		{"0194820a-9999-7d34", "", "Flowchart"},
		{"日本.pdf", "Plan.pdf", ""},
		{"café.pdf", "Menu.pdf", ""},
		{"foreign.pdf", "", ""},
	} {
		if got := idx.labels[tc.key]; got.Name != tc.name || got.Detail != tc.detail {
			t.Errorf("labels[%q] = %+v, want Name %q Detail %q", tc.key, got, tc.name, tc.detail)
		}
	}

	file := func(name string) store.Storable { return fakeAsset{ref: "/ui/assets/" + doc + "/" + name, blkID: name} }
	views := toAssetViews(doc, []store.Storable{
		file("0194820a-81c2-7d34.png"), file("0194820a-9999-7d34.svg"), file("café.pdf"), file("foreign.pdf"), file("loose.png"),
	}, idx)
	for i, want := range []struct {
		inUse  bool
		holder string
	}{
		{true, "img-blk-1"},
		{true, ""},
		{true, "ref-blk-3"},
		{false, ""},
		{false, ""},
	} {
		v := views[i]
		if v.InUse != want.inUse || v.HolderID != want.holder {
			t.Errorf("%s: InUse %v HolderID %q; want %v %q", v.FileName, v.InUse, v.HolderID, want.inUse, want.holder)
		}
		if wantAddr := domain.NewLeafAddress(doc, v.FileName).String(); v.Address != wantAddr {
			t.Errorf("%s: Address %q, want %q", v.FileName, v.Address, wantAddr)
		}
	}
}

// The delete endpoint removes only an asset no block holds, judged against the
// blocks the editor holds now, and announces the removal so open panels re-render.
func TestDeleteAsset_refusesHeldRemovesUnused(t *testing.T) {
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	assets := services.NewAssetService(fs, "")
	block.RegisterProcessor(processors.NewSmartImageProcessor(block.BlockServices{}))
	es := editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	t.Cleanup(es.CloseAll)
	announced := 0
	r := chi.NewRouter()
	(&MetaHandler{
		ServiceProvider:  &sieve.ServiceProvider{Documents: ds, Assets: assets, Editor: es},
		EmitNotesChanged: func() { announced++ },
	}).RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	doc, _ := ds.New()
	uuid := doc.UUID()
	for _, key := range []string{"held.png", "café.png", "placed.png"} {
		if _, err := assets.Save(domain.WorkingCopy, uuid, key, []byte{0x89, 0x50, 0x4E, 0x47}); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
	doc, _ = ds.LoadByUUID(uuid)
	doc.SetBody([]byte("```smart-image\nid: img-1\nsrc: sieve://" + uuid + "/held.png\nstatus: COMPLETE\n```\n"))
	if _, err := ds.Save(doc); err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	var sharing []string
	for range 2 {
		id, _, err := es.CreateBlock(uuid, "smart-image", map[string]interface{}{"src": "sieve://" + uuid + "/placed.png", "summary": "s"}, block.AppendIndex)
		if err != nil {
			t.Fatalf("place: %v", err)
		}
		sharing = append(sharing, id)
	}
	removeBlock := func(id string) func(t *testing.T) {
		return func(t *testing.T) {
			if err := es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: id}); err != nil {
				t.Fatalf("delete block: %v", err)
			}
		}
	}

	for _, tc := range []struct {
		name, key  string
		first      func(t *testing.T)
		wantStatus int
		wantGone   bool
	}{
		{"saved holder", "held.png", nil, http.StatusConflict, false},
		{"two holders not yet saved", "placed.png", nil, http.StatusConflict, false},
		{"one of two sharing blocks deleted", "placed.png", removeBlock(sharing[0]), http.StatusConflict, false},
		{"both sharing blocks deleted", "placed.png", removeBlock(sharing[1]), http.StatusNoContent, true},
		{"unused, path-escaped", url.PathEscape("café.png"), nil, http.StatusNoContent, true},
		{"no such asset", "missing.png", nil, http.StatusNotFound, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.first != nil {
				tc.first(t)
			}
			before := announced
			status, body := do(t, http.MethodDelete, srv.URL+"/api/document/"+uuid+"/asset/"+tc.key, "", "")
			if status != tc.wantStatus {
				t.Fatalf("status = %d (%s), want %d", status, body, tc.wantStatus)
			}
			key, _ := url.PathUnescape(tc.key)
			_, err := assets.ServeAssetData(uuid, key)
			if gone := err != nil; gone != tc.wantGone && key != "missing.png" {
				t.Errorf("asset gone = %v, want %v", gone, tc.wantGone)
			}
			if wantAnnounce := tc.wantGone; (announced > before) != wantAnnounce {
				t.Errorf("announced = %v, want %v", announced > before, wantAnnounce)
			}
		})
	}
}
