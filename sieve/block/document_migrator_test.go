package block

import "testing"

// DocumentCodec.Deserialize stays a PURE parse: the migration is a side effect
// only a load-that-can-save path (DocumentMigrator's callers) may take, so a
// read-only re-parse — findBlockByID's markdown fallback, AI context building, a
// snapshot — must hand back exactly what is on disk.
func TestDeserialize_DoesNotMigrateAssetURLs(t *testing.T) {
	RegisterProcessor(newFakeProc("smart-image"))
	defer UnregisterProcessor("smart-image")
	legacy := "/sieve/" + testAssetUUID + "/im.png"

	blocks, err := NewDocumentCodec(GlobalRegistry()).Deserialize(
		"```smart-image\nid: im-1\nsrc: " + legacy + "\n```")
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	if got := blocks[0].Attrs["src"]; got != legacy {
		t.Errorf("Deserialize rewrote src to %v; it must stay %q", got, legacy)
	}
}

// The pipeline runs BOTH steps in one pass, which is the point of it existing:
// every call site (NewShadow, the /migrate-ids sweep) gets every migration, and a
// document carrying a legacy handle AND a legacy asset route converges on one load.
func TestDocumentMigrator_RunsIdentityAndAssetURLSteps(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{
			"id":  "pr-aaaa",
			"src": "/sieve/" + testAssetUUID + "/im.png",
		}},
	}
	out, changed := DocumentMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("changed = false for a tree needing both migrations")
	}
	if out[0].ID == "pr-aaaa" {
		t.Error("identity step did not run: legacy handle survived")
	}
	if got, want := out[0].Attrs["src"], "/ui/assets/"+testAssetUUID+"/im.png"; got != want {
		t.Errorf("asset-url step did not run: src = %v, want %q", got, want)
	}
}

// Each step reports independently: a URL-only document must still come back
// changed, or the opener would never flush the rewrite to disk.
func TestDocumentMigrator_AssetURLOnlyStillReportsChanged(t *testing.T) {
	const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	in := []SieveBlock{
		{ID: id, Kind: "smart-image", Attrs: map[string]interface{}{
			"id":  id,
			"src": "/sieve/" + testAssetUUID + "/im.png",
		}},
	}
	out, changed := DocumentMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("changed = false for a document whose only debt is a legacy asset route")
	}
	if out[0].ID != id {
		t.Errorf("canonical id disturbed: %q", out[0].ID)
	}
}

func TestDocumentMigrator_CleanTreeIsUnchanged(t *testing.T) {
	const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	in := []SieveBlock{
		{ID: id, Kind: "smart-image", Attrs: map[string]interface{}{
			"id":  id,
			"src": "/ui/assets/" + testAssetUUID + "/im.png",
		}},
	}
	if _, changed := (DocumentMigrator{}).Migrate(in); changed {
		t.Fatal("a fully migrated tree reported changed = true")
	}
}
