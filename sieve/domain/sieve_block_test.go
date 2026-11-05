package domain

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

// Typed attr accessors (spec #5): kind-agnostic storage, typed reads — so a
// typo or shape change is a compile error / empty string, not a silent panic.
// They front the single Attrs payload bag that every kind shares.
func TestSieveBlock_TypedAccessors(t *testing.T) {
	b := SieveBlock{
		ID:   "co-1",
		Kind: "code",
		Attrs: map[string]interface{}{
			"source":   "fmt.Println()",
			"status":   "complete",
			"ref":      "pr-1,pr-2",
			"language": "go",
		},
	}

	if got := b.Source(); got != "fmt.Println()" {
		t.Errorf("Source() = %q, want %q", got, "fmt.Println()")
	}
	if got := b.Status(); got != "complete" {
		t.Errorf("Status() = %q, want %q", got, "complete")
	}
	if got := b.Ref(); got != "pr-1,pr-2" {
		t.Errorf("Ref() = %q, want %q", got, "pr-1,pr-2")
	}
	if got := b.StringAttr("language"); got != "go" {
		t.Errorf("StringAttr(language) = %q, want %q", got, "go")
	}

	pr := SieveBlock{ID: "pr-1", Kind: "prose", Attrs: map[string]interface{}{"content": "verbatim prose body"}}
	if got := pr.Content(); got != "verbatim prose body" {
		t.Errorf("Content() = %q, want %q", got, "verbatim prose body")
	}
}

// Missing/nil/wrong-type attrs return "" rather than panicking — the whole point
// of the typed accessor over a raw b.Attrs["x"].(string) cast.
func TestSieveBlock_TypedAccessors_SafeOnMissing(t *testing.T) {
	var b SieveBlock // nil Attrs
	if got := b.Source(); got != "" {
		t.Errorf("Source() on nil attrs = %q, want empty", got)
	}

	b2 := SieveBlock{Attrs: map[string]interface{}{"status": 42}} // wrong type
	if got := b2.Status(); got != "" {
		t.Errorf("Status() on non-string = %q, want empty", got)
	}
	if got := b2.StringAttr("nope"); got != "" {
		t.Errorf("StringAttr(missing) = %q, want empty", got)
	}
}
