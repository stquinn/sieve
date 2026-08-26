package block

import (
	"fmt"
	"testing"
)

// testRefDocUUID is the document a reference block lives in for these fixtures —
// distinct from testAssetUUID, which plays the CONTAINER a legacy address
// points at.
const testRefDocUUID = "0197b1f4-9999-7aaa-8bbb-ccccddddeeee"

func referenceBlock(id string, attrs map[string]interface{}) SieveBlock {
	full := map[string]interface{}{"id": id}
	for k, v := range attrs {
		full[k] = v
	}
	return SieveBlock{ID: id, Kind: "reference", Attrs: full}
}

func TestReferenceURIMigrator_ContainerMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "container:" + testAssetUUID})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceURIMigrator_PinnedContainerMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "container:" + testAssetUUID + "@v3"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID+"?version=3"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceURIMigrator_BlockLeafMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "block:" + testAssetUUID + "/my-handle"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID+"/my-handle"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceURIMigrator_PinnedBlockLeafMapping(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "block:" + testAssetUUID + "@v7/my-handle"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testAssetUUID+"/my-handle?version=7"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

// A bare block:{uuid} — no handle — has no sieve:// spelling, so it is left
// untouched rather than guessed at, and goes on resolving dangling.
func TestReferenceURIMigrator_BareBlockUUIDLeftUntouched(t *testing.T) {
	legacy := "block:" + testAssetUUID
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": legacy})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Fatal("changed = true for a bare block:{uuid}, which has no sieve:// spelling")
	}
	if got := out[0].Attrs["uri"]; got != legacy {
		t.Errorf("uri = %v, want untouched %q", got, legacy)
	}
}

func TestReferenceURIMigrator_SrcFold(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"src": "notes.txt"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testRefDocUUID+"/notes.txt"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
	if _, ok := out[0].Attrs["src"]; ok {
		t.Error("src survived the fold")
	}
}

func TestReferenceURIMigrator_RelativeURIAbsolutised(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "/notes.txt"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got, want := out[0].Attrs["uri"], "sieve://"+testRefDocUUID+"/notes.txt"; got != want {
		t.Errorf("uri = %v, want %q", got, want)
	}
}

func TestReferenceURIMigrator_BothSetURIWins(t *testing.T) {
	held := "sieve://" + testAssetUUID + "/held.txt"
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": held, "src": "stale.txt"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	if got := out[0].Attrs["uri"]; got != held {
		t.Errorf("uri = %v, want unchanged %q", got, held)
	}
	if _, ok := out[0].Attrs["src"]; ok {
		t.Error("src survived when both were set")
	}
}

// smart-image also carries a `src` attr, with an unrelated meaning (its own held
// asset route). The kind gate must keep this migrator off it.
func TestReferenceURIMigrator_IgnoresNonReferenceKinds(t *testing.T) {
	in := []SieveBlock{
		{ID: "im-1", Kind: "smart-image", Attrs: map[string]interface{}{"id": "im-1", "src": "im-1.png"}},
	}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Fatal("changed = true for a non-reference block")
	}
	if got := out[0].Attrs["src"]; got != "im-1.png" {
		t.Errorf("src disturbed on a non-reference kind: %v", got)
	}
	if _, ok := out[0].Attrs["uri"]; ok {
		t.Error("a uri attr was minted on a non-reference kind")
	}
}

func TestReferenceURIMigrator_CleanTreeAllocatesNothing(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"uri": "sieve://" + testAssetUUID + "/leaf"})}
	out, changed := ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if changed {
		t.Fatal("changed = true for an already-migrated tree")
	}
	// out shares its Attrs map with in — this is what "no allocation" means:
	// migrateAttrs returns the SAME map back rather than cloning it.
	got, want := fmt.Sprintf("%p", out[0].Attrs), fmt.Sprintf("%p", in[0].Attrs)
	if got != want {
		t.Errorf("Attrs map was cloned for a clean block: out=%s in=%s", got, want)
	}
}

func TestReferenceURIMigrator_DoesNotMutateInput(t *testing.T) {
	in := []SieveBlock{referenceBlock("rf-1", map[string]interface{}{"src": "notes.txt"})}
	ReferenceURIMigrator{}.Migrate(in, testRefDocUUID)
	if _, ok := in[0].Attrs["uri"]; ok {
		t.Fatal("Migrate mutated its input's Attrs map — undo and the caller's snapshot depend on it not doing that")
	}
	if got := in[0].Attrs["src"]; got != "notes.txt" {
		t.Fatalf("Migrate mutated its input's src: %v", got)
	}
}

func TestReferenceURIMigrator_EmptyAndNil(t *testing.T) {
	m := ReferenceURIMigrator{}
	if out, changed := m.Migrate(nil, testRefDocUUID); out != nil || changed {
		t.Fatalf("nil input: got %v, %v", out, changed)
	}
	if out, changed := m.Migrate([]SieveBlock{}, testRefDocUUID); len(out) != 0 || changed {
		t.Fatalf("empty input: got %v, %v", out, changed)
	}
}
