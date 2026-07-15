package block

import "testing"

// The identity invariant is TWO-SIDED: a block's minted/given id must live on the
// ID field AND be mirrored into Attrs["id"]. Both the WYSIWYG wire
// (buildSieveBlockHTML reads Attrs["id"] — a missing one makes the block vanish on
// load) and the fenced serializer (SerializeYaml(Attrs) writes `id:` FROM Attrs)
// read the id out of Attrs, never the ID field. A minted id that lived only on ID
// disappeared on both load and save — the id-less-code-block bug.

func TestNewSieveBlock_mirrorsMintedIDIntoAttrs(t *testing.T) {
	b := NewSieveBlock("code", "", map[string]interface{}{"source": "x := 1"})
	if b.ID == "" {
		t.Fatal("expected a minted id on the ID field")
	}
	if got, _ := b.Attrs["id"].(string); got != b.ID {
		t.Fatalf("Attrs[\"id\"] = %q, want it mirrored to ID %q", got, b.ID)
	}
}

func TestNewSieveBlock_mirrorsGivenIDIntoAttrs(t *testing.T) {
	b := NewSieveBlock("code", "co-abc", map[string]interface{}{"source": "x"})
	if got, _ := b.Attrs["id"].(string); got != "co-abc" {
		t.Fatalf("Attrs[\"id\"] = %q, want the given id co-abc", got)
	}
}

func TestNewSieveBlock_nilAttrsGetsID(t *testing.T) {
	b := NewSieveBlock("code", "co-1", nil)
	if got, _ := b.Attrs["id"].(string); got != "co-1" {
		t.Fatalf("Attrs[\"id\"] = %q, want co-1 (fresh map)", got)
	}
}

// Copy-on-write: the prose processor builds throwaway blocks from LIVE attrs maps
// (prose_processor.go), so writing the id must never mutate the caller's map.
func TestNewSieveBlock_doesNotMutateCallerAttrs(t *testing.T) {
	caller := map[string]interface{}{"source": "x"}
	NewSieveBlock("code", "", caller)
	if _, present := caller["id"]; present {
		t.Fatal("NewSieveBlock mutated the caller's attrs map (must copy-on-write)")
	}
}

// The wire projection the WYSIWYG load consumes must carry Attrs["id"] for a block
// whose id was minted (the end-to-end guard for the vanishing code block).
func TestBlockDocToFrontendBlocks_carriesID(t *testing.T) {
	b := NewSieveBlock("code", "", map[string]interface{}{"source": "x"})
	fb, err := BlockDocToFrontendBlocks([]SieveBlock{b})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := fb[0].Attrs["id"].(string); got != b.ID || got == "" {
		t.Fatalf("wire Attrs[\"id\"] = %q, want %q", got, b.ID)
	}
}
