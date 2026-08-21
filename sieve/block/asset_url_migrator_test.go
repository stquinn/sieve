package block

import (
	"testing"
)

// A real minted-shape uuid: the migrator only rewrites a route whose segment
// passes ident.Valid, so every fixture route must carry one.
const testAssetUUID = "0197b1f4-2c3d-7a8b-9c0d-1e2f3a4b5c6d"

func TestAssetURLMigrator_RewritesSrcAttr(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": "/sieve/" + testAssetUUID + "/im-1.png"}},
	}
	out, changed := AssetURLMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("changed = false for a legacy-route src")
	}
	if got, want := out[0].Attrs["src"], "/ui/assets/"+testAssetUUID+"/im-1.png"; got != want {
		t.Errorf("src = %v, want %q", got, want)
	}
}

func TestAssetURLMigrator_RewritesEmbeddedProseMarkdown(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{
			"id":      "pr-1",
			"content": "see ![alt](/sieve/" + testAssetUUID + "/im-1.png) inline",
		}},
	}
	out, changed := AssetURLMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("changed = false for prose content carrying a legacy-route image")
	}
	want := "see ![alt](/ui/assets/" + testAssetUUID + "/im-1.png) inline"
	if got := out[0].Content(); got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
}

func TestAssetURLMigrator_RewritesAnyAttrKeyUniformly(t *testing.T) {
	// diagram blocks carry the served route under svgAsset, not src — the
	// migrator must not be a per-kind field list.
	in := []SieveBlock{
		{ID: "di-1", Kind: "diagram", Attrs: map[string]interface{}{"id": "di-1", "svgAsset": "/sieve/" + testAssetUUID + "/di-1.svg"}},
	}
	out, changed := AssetURLMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("changed = false for a legacy-route svgAsset")
	}
	if got, want := out[0].Attrs["svgAsset"], "/ui/assets/"+testAssetUUID+"/di-1.svg"; got != want {
		t.Errorf("svgAsset = %v, want %q", got, want)
	}
}

// The corruption-regression cases (Go import paths, repo URLs, filesystem
// paths, mixed prose) and the "already migrated" no-op case exercise the
// string-rewrite RULE itself and live with it in store/asset_url_test.go.
// These tests stay here because they are Attrs-WALK behaviour: which keys get
// visited, non-string values, mutation safety, empty input — none of that is
// specific to what a route looks like.

func TestAssetURLMigrator_NonStringAttrsIgnored(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{
			"id":            "im-1",
			"showSummary":   false,
			"supportsEmbed": true,
		}},
	}
	out, changed := AssetURLMigrator{}.Migrate(in)
	if changed {
		t.Fatal("a block with no legacy URL anywhere reported changed = true")
	}
	if out[0].Attrs["showSummary"] != false {
		t.Errorf("non-string attr disturbed: %v", out[0].Attrs["showSummary"])
	}
}

func TestAssetURLMigrator_DoesNotMutateInput(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": "/sieve/" + testAssetUUID + "/im-1.png"}},
	}
	AssetURLMigrator{}.Migrate(in)
	if in[0].Attrs["src"] != "/sieve/"+testAssetUUID+"/im-1.png" {
		t.Fatal("Migrate mutated its input — undo and the caller's snapshot depend on it not doing that")
	}
}

func TestAssetURLMigrator_EmptyAndNil(t *testing.T) {
	m := AssetURLMigrator{}
	if out, changed := m.Migrate(nil); out != nil || changed {
		t.Fatalf("nil input: got %v, %v", out, changed)
	}
	if out, changed := m.Migrate([]SieveBlock{}); len(out) != 0 || changed {
		t.Fatalf("empty input: got %v, %v", out, changed)
	}
}
