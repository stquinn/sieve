package block

import (
	"strings"
	"testing"
)

func TestFindBlockByIDSieveBlock(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "code"}})
	defer UnregisterProcessor("code")
	md := "```code\nid: co-abcd\nstatus: COMPLETE\nsource: fmt.Println()\n```\n"
	block, found := NewDocumentCodec(GlobalRegistry()).findBlockByID(md, "co-abcd")
	if !found {
		t.Fatal("expected to find co-abcd")
	}
	if block.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", block.Kind)
	}
}

func TestFindBlockByIDNotFound(t *testing.T) {
	_, found := NewDocumentCodec(GlobalRegistry()).findBlockByID("Just some plain markdown.\n", "co-9999")
	if found {
		t.Error("expected not found")
	}
}

// End-to-end through DocumentCodec: a fence tagged with an alias is scanned as a
// region, claimed by the flavour that declares the alias, and deserialises to
// the flavour's CANONICAL kind — the whole point of the alias mechanism (a
// fence written under an old kind name must not fall through to prose).
func TestDocumentCodec_Deserialize_aliasedFenceCanonicalises(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "reference-mock", Aliases: []string{"attachment-mock"}},
	})
	defer UnregisterProcessor("reference-mock")

	md := "```attachment-mock\nid: r-1\nuri: sieve://x\n```\n"
	blocks, err := NewDocumentCodec(GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d: %+v", len(blocks), blocks)
	}
	if blocks[0].Kind != "reference-mock" {
		t.Errorf("an aliased fence must load as the CANONICAL kind, got %q (would silently mangle to prose without the alias mechanism)", blocks[0].Kind)
	}
}

// The on-disk consequence of canonicalisation: an aliased fence must not only
// load correctly, it must SAVE back out under the canonical head and never echo
// the alias it matched. Echoing it would be silent document mangling on the next
// save.
func TestDocumentCodec_DeserializeThenSerialize_aliasedFenceRoundTripsToCanonicalHead(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{
		FencedDeserializer: FencedDeserializer{Kind: "reference-mock", Aliases: []string{"attachment-mock"}},
	})
	defer UnregisterProcessor("reference-mock")

	codec := NewDocumentCodec(GlobalRegistry())
	blocks, err := codec.Deserialize("```attachment-mock\nid: r-2\nuri: sieve://x\n```\n")
	if err != nil {
		t.Fatalf("Deserialize: %v", err)
	}
	out, err := codec.Serialize(blocks)
	if err != nil {
		t.Fatalf("Serialize: %v", err)
	}
	if !strings.HasPrefix(out, "```reference-mock\n") {
		t.Fatalf("a re-saved aliased fence must write the CANONICAL head, got %q", out)
	}
}

func TestBuildContextForIDDispatchesByKind(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "code"}, returnVal: "CODE CONTEXT"})
	defer UnregisterProcessor("code")
	md := "```code\nid: co-abc\nsource: x\n```\n"
	result := BuildContextForID("co-abc", DocView{rawAuthoritative: true, mdModeBuffer: md}, map[string]bool{}, nil)
	if !strings.Contains(result.String(), "CODE CONTEXT") {
		t.Errorf("expected dispatched processor context, got %q", result)
	}
}

func TestBuildContextForIDPreventsCycles(t *testing.T) {
	RegisterProcessor(&mockContextProcessor{FencedDeserializer: FencedDeserializer{Kind: "code"}, returnVal: "CODE CONTEXT"})
	defer UnregisterProcessor("code")
	// seen map already contains the ID — must return "" without recursing.
	md := "```code\nid: co-abc\nsource: x\n```\n"
	seen := map[string]bool{"co-abc": true}
	result := BuildContextForID("co-abc", DocView{rawAuthoritative: true, mdModeBuffer: md}, seen, nil)
	if !result.IsEmpty() {
		t.Errorf("expected empty for already-seen ID, got %q", result)
	}
}
