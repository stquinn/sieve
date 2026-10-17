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

func TestAssetURIMigrator_SmartImage_LocalRoutesFoldToRelative(t *testing.T) {
	for _, tc := range []struct {
		name string
		src  string
		want string
	}{
		{"current route", "/ui/assets/" + testAssetDocUUID + "/shot.png", "/shot.png"},
		{"legacy route", "/sieve/" + testAssetDocUUID + "/shot.png", "/shot.png"},
		{"bare filename", "shot.png", "/shot.png"},
		{"dot-assets prefix", ".assets/shot.png", "/shot.png"},
		{"self absolute address", "sieve://" + testAssetDocUUID + "/shot.png", "/shot.png"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := []SieveBlock{
				{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": tc.src}},
			}
			out, changed := AssetURIMigrator{}.Migrate(in, testAssetDocUUID)
			if !changed {
				t.Fatalf("expected changed = true for %s", tc.name)
			}
			if got := out[0].Attrs["src"]; got != tc.want {
				t.Errorf("src = %v, want %q", got, tc.want)
			}
		})
	}
}

func TestAssetURIMigrator_Diagram_LocalRoutesFoldToRelative(t *testing.T) {
	for _, tc := range []struct {
		name string
		svg  string
		want string
	}{
		{"current route", "/ui/assets/" + testAssetDocUUID + "/di-1.svg", "/di-1.svg"},
		{"legacy route", "/sieve/" + testAssetDocUUID + "/di-1.svg", "/di-1.svg"},
		{"bare filename", "di-1.svg", "/di-1.svg"},
		{"dot-assets prefix", ".assets/di-1.svg", "/di-1.svg"},
		{"self absolute address", "sieve://" + testAssetDocUUID + "/di-1.svg", "/di-1.svg"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := []SieveBlock{
				{ID: "di-1", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-1", "svgAsset": tc.svg}},
			}
			out, changed := AssetURIMigrator{}.Migrate(in, testAssetDocUUID)
			if !changed {
				t.Fatalf("expected changed = true for %s", tc.name)
			}
			if got := out[0].Attrs["svgAsset"]; got != tc.want {
				t.Errorf("svgAsset = %v, want %q", got, tc.want)
			}
		})
	}
}

func TestAssetURIMigrator_ForeignRoutesBecomeAbsolute(t *testing.T) {
	for _, tc := range []struct {
		name     string
		kind     string
		attrKey  string
		input    string
		expected string
	}{
		{
			name:     "smart-image foreign current route",
			kind:     "smart-image",
			attrKey:  "src",
			input:    "/ui/assets/" + testForeignDocUUID + "/shared.png",
			expected: "sieve://" + testForeignDocUUID + "/shared.png",
		},
		{
			name:     "smart-image foreign legacy route",
			kind:     "smart-image",
			attrKey:  "src",
			input:    "/sieve/" + testForeignDocUUID + "/shared.png",
			expected: "sieve://" + testForeignDocUUID + "/shared.png",
		},
		{
			name:     "diagram foreign current route",
			kind:     "diagram",
			attrKey:  "svgAsset",
			input:    "/ui/assets/" + testForeignDocUUID + "/shared.svg",
			expected: "sieve://" + testForeignDocUUID + "/shared.svg",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := []SieveBlock{
				{ID: "b-1", Kind: tc.kind, Attrs: map[string]interface{}{"id": "b-1", tc.attrKey: tc.input}},
			}
			out, changed := AssetURIMigrator{}.Migrate(in, testAssetDocUUID)
			if !changed {
				t.Fatalf("expected changed = true for %s", tc.name)
			}
			if got := out[0].Attrs[tc.attrKey]; got != tc.expected {
				t.Errorf("%s = %v, want %q", tc.attrKey, got, tc.expected)
			}
		})
	}
}

func TestAssetURIMigrator_AlreadyMigrated_AllocatesNothing(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": "/photo.png"}},
		{ID: "im-2", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-2", "src": "sieve://" + testForeignDocUUID + "/photo.png"}},
		{ID: "di-1", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-1", "svgAsset": "/flow.svg"}},
		{ID: "di-2", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-2", "svgAsset": "sieve://" + testForeignDocUUID + "/flow.svg"}},
		{ID: "di-3", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-3", "svgAsset": ""}},
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
