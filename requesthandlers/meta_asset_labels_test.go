package requesthandlers

import (
	"testing"

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
	labels := map[string]string{
		"01a01bcd-273b": "swagger.yml",
		"01a01bcd-3ec8": "payments-fixture.json",
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
		map[string]string{"01a01bcd-9f2b": "Auth Design"},
	)
	if len(views) != 1 {
		t.Fatalf("views: got %d, want 1", len(views))
	}
	if views[0].Name != "01a01bcd-9f2b-img.png" {
		t.Errorf("Name: got %q, want the filename fallback", views[0].Name)
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
