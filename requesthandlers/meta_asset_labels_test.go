package requesthandlers

import (
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/store"
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

	views := toAssetViews(assets, labels)
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
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-9f2b-img.png", blkID: "01a01bcd-9f2b-img"}},
		map[string]assetLabel{"01a01bcd-9f2b": {Name: "Auth Design"}},
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
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-273b.png", blkID: "01a01bcd-273b"}},
		map[string]assetLabel{"01a01bcd-273b": {Name: "diagram.png", Detail: "A dark-themed editor screenshot"}},
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
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-9f2b.png", blkID: "01a01bcd-9f2b"}},
		map[string]assetLabel{"01a01bcd-9f2b": {Detail: "A dark-themed editor screenshot"}},
	)
	if views[0].Name != "A dark-themed editor screenshot" {
		t.Errorf("Name: got %q, want the description as the fallback", views[0].Name)
	}
	if views[0].Detail != "" {
		t.Errorf("Detail: got %q, want it empty rather than repeating the name", views[0].Detail)
	}
}

func TestAssetViews_nilLabelsAreSafe(t *testing.T) {
	// assetLabels returns nil for a document that will not parse. A label is a
	// nicety; the panel must still render.
	views := toAssetViews(
		[]store.Storable{fakeAsset{ref: "store/doc/01a01bcd-273b.png", blkID: "01a01bcd-273b"}},
		nil,
	)
	if len(views) != 1 || views[0].Name != "01a01bcd-273b.png" {
		t.Fatalf("got %+v, want the filename fallback", views)
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

	views := toAssetViews(assets, labels)
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

type fakeDoc struct {
	domain.Document
	uuid string
	body []byte
}

func (f fakeDoc) UUID() string { return f.uuid }
func (f fakeDoc) Body() []byte { return f.body }

func TestAssetLabels_mapsOpaqueKeysFromBlockAttrs(t *testing.T) {
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
	labels := (&MetaHandler{}).assetLabels(fakeDoc{uuid: doc, body: []byte(docBody)})
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
		if got := labels[tc.key]; got.Name != tc.name || got.Detail != tc.detail {
			t.Errorf("labels[%q] = %+v, want Name %q Detail %q", tc.key, got, tc.name, tc.detail)
		}
	}
}
