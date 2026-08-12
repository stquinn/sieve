package block

import (
	"testing"

	"sieve/ident"
)

func TestMigrate_UpgradesLegacyIDs(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-aaaa", "content": "one"}},
		{ID: "pr-bbbb", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-bbbb", "content": "two"}},
	}
	out, changed := BlockIdentityMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("changed = false for a legacy tree")
	}
	for i, b := range out {
		if !ident.Valid(b.ID) {
			t.Fatalf("block %d id %q not upgraded", i, b.ID)
		}
		if b.Attrs["id"] != b.ID {
			t.Fatalf("block %d two-sided invariant broken: ID=%q Attrs[id]=%v", i, b.ID, b.Attrs["id"])
		}
	}
	if out[0].ID == out[1].ID {
		t.Fatal("both blocks got the same uuid")
	}
	if in[0].ID != "pr-aaaa" || in[0].Attrs["id"] != "pr-aaaa" {
		t.Fatal("Migrate mutated its input — undo and the caller's snapshot depend on it not doing that")
	}
	if out[0].Content() != "one" || out[1].Content() != "two" {
		t.Fatal("payload lost during re-identification")
	}
}

func TestMigrate_CreatesNoAliases(t *testing.T) {
	out, _ := BlockIdentityMigrator{}.Migrate([]SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-aaaa"}},
	})
	if len(out[0].Aliases) != 0 {
		t.Fatalf("migration invented aliases: %v", out[0].Aliases)
	}
}

func TestMigrate_PreservesExistingAliases(t *testing.T) {
	out, _ := BlockIdentityMigrator{}.Migrate([]SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-aaaa"},
			Aliases: []string{"the-opening-para"}},
	})
	if len(out[0].Aliases) != 1 || out[0].Aliases[0] != "the-opening-para" {
		t.Fatalf("declared alias lost: %v", out[0].Aliases)
	}
}

func TestMigrate_RewritesRefs(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-aaaa", "content": "target"}},
		{ID: "ai-bbbb", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-bbbb", "ref": "pr-aaaa"}},
	}
	out, _ := BlockIdentityMigrator{}.Migrate(in)
	if got := out[1].Ref(); got != out[0].ID {
		t.Fatalf("ref = %q, want the target's new id %q", got, out[0].ID)
	}
}

func TestMigrate_RewritesMultiRefsAndLeavesUnknownAlone(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-aaaa"}},
		{ID: "ai-bbbb", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-bbbb", "ref": "pr-aaaa, pr-gone"}},
	}
	out, _ := BlockIdentityMigrator{}.Migrate(in)
	want := out[0].ID + ",pr-gone"
	if got := out[1].Ref(); got != want {
		t.Fatalf("ref = %q, want %q (unresolved token preserved verbatim)", got, want)
	}
}

func TestMigrate_IsIdempotent(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-aaaa", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-aaaa"}},
		{ID: "ai-bbbb", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-bbbb", "ref": "pr-aaaa"}},
	}
	once, _ := BlockIdentityMigrator{}.Migrate(in)
	twice, changed := BlockIdentityMigrator{}.Migrate(once)
	if changed {
		t.Fatal("second pass reported changed = true")
	}
	for i := range once {
		if once[i].ID != twice[i].ID || once[i].Ref() != twice[i].Ref() {
			t.Fatalf("block %d not stable across passes: %+v vs %+v", i, once[i], twice[i])
		}
	}
}

// The 50%-collision case this issue exists for: two blocks minted the same short
// handle. Each must end up distinct, and refs must bind to the FIRST in document
// order — the pre-migration resolution order.
func TestMigrate_LegacyDuplicateHandleBindsFirstWins(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-dup", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-dup", "content": "first"}},
		{ID: "pr-dup", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-dup", "content": "second"}},
		{ID: "ai-cccc", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-cccc", "ref": "pr-dup"}},
	}
	out, _ := BlockIdentityMigrator{}.Migrate(in)
	if out[0].ID == out[1].ID {
		t.Fatal("duplicate handles collapsed to one uuid")
	}
	if got := out[2].Ref(); got != out[0].ID {
		t.Fatalf("ref = %q, want first holder %q", got, out[0].ID)
	}
}

// A duplicate UUID means corruption or a hand-edit. Repair and log — never refuse
// to load. Refs naming it belong to the first, legitimate holder.
func TestMigrate_RepairsDuplicateUUIDAndKeepsRefsWithFirstHolder(t *testing.T) {
	const dup = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	const other = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99"
	in := []SieveBlock{
		{ID: dup, Kind: KindProse, Attrs: map[string]interface{}{"id": dup, "content": "first"}},
		{ID: dup, Kind: KindProse, Attrs: map[string]interface{}{"id": dup, "content": "second"}},
		{ID: other, Kind: "ai-block", Attrs: map[string]interface{}{"id": other, "ref": dup}},
	}
	out, changed := BlockIdentityMigrator{}.Migrate(in)
	if !changed {
		t.Fatal("duplicate uuid not repaired")
	}
	if out[0].ID != dup {
		t.Fatalf("first holder lost its id: %q", out[0].ID)
	}
	if out[1].ID == dup || !ident.Valid(out[1].ID) {
		t.Fatalf("duplicate not re-minted: %q", out[1].ID)
	}
	if got := out[2].Ref(); got != dup {
		t.Fatalf("ref = %q, want the untouched first holder %q", got, dup)
	}
}

func TestMigrate_CleanTreeIsUnchanged(t *testing.T) {
	const a = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	const b = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99"
	out, changed := BlockIdentityMigrator{}.Migrate([]SieveBlock{
		{ID: a, Kind: KindProse, Attrs: map[string]interface{}{"id": a}},
		{ID: b, Kind: "ai-block", Attrs: map[string]interface{}{"id": b, "ref": a}},
	})
	if changed {
		t.Fatal("an already-migrated tree reported changed = true")
	}
	if out[0].ID != a || out[1].Ref() != a {
		t.Fatalf("clean tree disturbed: %+v", out)
	}
}

func TestMigrate_EmptyAndNil(t *testing.T) {
	m := BlockIdentityMigrator{}
	if out, changed := m.Migrate(nil); out != nil || changed {
		t.Fatalf("nil input: got %v, %v", out, changed)
	}
	if out, changed := m.Migrate([]SieveBlock{}); len(out) != 0 || changed {
		t.Fatalf("empty input: got %v, %v", out, changed)
	}
}
