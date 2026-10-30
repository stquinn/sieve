package block

import (
	"fmt"
	"testing"

	"sieve/ident"
)

var (
	testAssetDocUUID   = ident.New()
	testForeignDocUUID = ident.New()
)

func TestAssetURIMigrator_RewritesToAbsoluteAddress(t *testing.T) {
	self := "sieve://" + testAssetDocUUID + "/"
	foreign := "sieve://" + testForeignDocUUID + "/"
	for _, tc := range []struct {
		name    string
		kind    string
		attrKey string
		input   string
		want    string
	}{
		{"smart-image current route", "smart-image", "src", "/ui/assets/" + testAssetDocUUID + "/shot.png", self + "shot.png"},
		{"smart-image legacy route", "smart-image", "src", "/sieve/" + testAssetDocUUID + "/shot.png", self + "shot.png"},
		{"smart-image bare filename", "smart-image", "src", "shot.png", self + "shot.png"},
		{"smart-image dot-assets prefix", "smart-image", "src", ".assets/shot.png", self + "shot.png"},
		{"smart-image relative reference lifts to absolute", "smart-image", "src", "/shot.png", self + "shot.png"},
		{"smart-image foreign current route", "smart-image", "src", "/ui/assets/" + testForeignDocUUID + "/shared.png", foreign + "shared.png"},
		{"smart-image foreign legacy route", "smart-image", "src", "/sieve/" + testForeignDocUUID + "/shared.png", foreign + "shared.png"},
		{"diagram current route", "diagram", "svgAsset", "/ui/assets/" + testAssetDocUUID + "/di-1.svg", self + "di-1.svg"},
		{"diagram legacy route", "diagram", "svgAsset", "/sieve/" + testAssetDocUUID + "/di-1.svg", self + "di-1.svg"},
		{"diagram bare filename", "diagram", "svgAsset", "di-1.svg", self + "di-1.svg"},
		{"diagram dot-assets prefix", "diagram", "svgAsset", ".assets/di-1.svg", self + "di-1.svg"},
		{"diagram relative reference lifts to absolute", "diagram", "svgAsset", "/di-1.svg", self + "di-1.svg"},
		{"diagram foreign current route", "diagram", "svgAsset", "/ui/assets/" + testForeignDocUUID + "/shared.svg", foreign + "shared.svg"},
		{"web-clip bare filename", "web-clip", "page", "page-bbc-123456.md", self + "page-bbc-123456.md"},
		{"web-clip relative reference lifts to absolute", "web-clip", "page", "/page-bbc-123456.md", self + "page-bbc-123456.md"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := []SieveBlock{
				{ID: "b-1", Kind: tc.kind, Attrs: map[string]interface{}{"id": "b-1", tc.attrKey: tc.input}},
			}
			out, changed := AssetURIMigrator{}.Migrate(in, testAssetDocUUID)
			if !changed {
				t.Fatalf("expected changed = true for %s", tc.name)
			}
			if got := out[0].Attrs[tc.attrKey]; got != tc.want {
				t.Errorf("%s = %v, want %q", tc.attrKey, got, tc.want)
			}
		})
	}
}

func TestAssetURIMigrator_AlreadyMigrated_AllocatesNothing(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": "sieve://" + testAssetDocUUID + "/photo.png"}},
		{ID: "im-2", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-2", "src": "sieve://" + testForeignDocUUID + "/photo.png"}},
		{ID: "im-3", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-3", "src": "https://example.com/photo.png"}},
		{ID: "di-1", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-1", "svgAsset": "sieve://" + testAssetDocUUID + "/flow.svg"}},
		{ID: "di-2", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-2", "svgAsset": "sieve://" + testForeignDocUUID + "/flow.svg"}},
		{ID: "di-3", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-3", "svgAsset": ""}},
		{ID: "wc-1", Kind: "web-clip", Attrs: map[string]interface{}{"id": "wc-1", "page": "sieve://" + testAssetDocUUID + "/page-1.md"}},
		{ID: "wc-2", Kind: "web-clip", Attrs: map[string]interface{}{"id": "wc-2", "page": ""}},
	}

	out, changed := AssetURIMigrator{}.Migrate(in, testAssetDocUUID)
	if changed {
		t.Fatal("changed = true for already-migrated blocks")
	}
	for i := range in {
		got, want := fmt.Sprintf("%p", out[i].Attrs), fmt.Sprintf("%p", in[i].Attrs)
		if got != want {
			t.Errorf("block %d Attrs re-allocated: %s != %s", i, got, want)
		}
	}
}

func TestAssetURIMigrator_IgnoresOtherKinds(t *testing.T) {
	in := []SieveBlock{
		{ID: "rf-1", Kind: "reference", Attrs: map[string]interface{}{"id": "rf-1", "src": "im-1.png", "uri": ""}},
		{ID: "pr-1", Kind: "prose", Attrs: map[string]interface{}{"content": "some text /ui/assets/whatever"}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"source": "fmt.Println(/ui/assets/)"}},
	}
	out, changed := AssetURIMigrator{}.Migrate(in, testAssetDocUUID)
	if changed {
		t.Fatal("changed = true for non-asset kinds")
	}
	if got := out[0].Attrs["src"]; got != "im-1.png" {
		t.Errorf("reference src disturbed: %v", got)
	}
}
