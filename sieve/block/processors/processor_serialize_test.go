package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

// The core tenet of the block-document model (brainstorm-block-document-model.md
// §42): serialization is a per-BlockProcessor concern. The save spine WALKS the
// blocks and asks EACH flavour to serialize itself — no `if KindProse`, no free
// serializer functions. Prose owns its markers; structured kinds share the fence.
func TestSerialize_IsProcessorOwned_NoKindSwitch(t *testing.T) {
	resetRegistry() // restores the built-in prose flavour
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	blocks := []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Hello **world**."}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
	}

	got, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(blocks)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	// Prose serialized BY ProseProcessor — content wrapped in handle markers.
	wantProse := "<!--s:pr-1-->\nHello **world**.\n<!--/s:pr-1-->"
	if !strings.Contains(got, wantProse) {
		t.Fatalf("prose not serialized by its flavour (markers):\n%s", got)
	}
	// Structured serialized BY the shared FencedSerializer — a fence.
	if !strings.Contains(got, "```code\nid: co-1\nsource: x = 1\n```") {
		t.Fatalf("code not serialized via the shared fenced flavour:\n%s", got)
	}
}

// THE meaningful serialization test: a document serialized via the production
// (processor-owned) spine must parse back via the PRODUCTION codec to the same
// blocks — a real defect in the codec actually fails here.
func TestSerialize_RoundTripsThroughProductionParser(t *testing.T) {
	resetRegistry() // restores the built-in prose flavour
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { resetRegistry() })

	blocks := []block.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Intro **prose**."}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "Tail."}},
	}

	md, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(blocks) // production serialize (processor-owned)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	back, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md) // production parse — the real thing
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	if len(back) != 3 {
		t.Fatalf("want 3 blocks round-tripped, got %d:\n%s", len(back), md)
	}
	if back[0].Kind != block.KindProse || back[0].Content() != "Intro **prose**." {
		t.Errorf("prose[0] did not round-trip: %+v", back[0])
	}
	if back[1].Kind != "code" || back[1].ID != "co-1" || back[1].Attrs["source"] != "x = 1" {
		t.Errorf("code did not round-trip: %+v", back[1])
	}
	if back[2].Kind != block.KindProse || back[2].Content() != "Tail." {
		t.Errorf("prose[2] did not round-trip: %+v", back[2])
	}
}

// ProseProcessor owns prose serialization directly — the delimiters live ON the
// flavour, not in the spine.
func TestProseProcessor_Serialize_InjectsHandleDelimiters(t *testing.T) {
	p := &ProseProcessor{}
	got, err := p.Serialize(block.SieveBlock{
		ID:      "pr-aaaa",
		Kind:    block.KindProse,
		Attrs:   map[string]interface{}{"content": "Merged block."},
		Aliases: []string{"pr-bbbb"},
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-aaaa pr-bbbb-->\nMerged block.\n<!--/s:pr-aaaa-->"
	if got != want {
		t.Fatalf("prose serialize:\n got: %q\nwant: %q", got, want)
	}
}

// Prose extract seam: Transform turns entries (e.g. an AI block's table) into a
// prose block's content — so "extract into the document as prose" has a path.
func TestProseProcessor_Transform_ExtractsEntriesToContent(t *testing.T) {
	p := &ProseProcessor{}
	attrs := p.Transform([]block.ContentEntry{
		{MIMEType: "text/markdown", Content: "| a | b |\n|---|---|\n| 1 | 2 |"},
	}, "uuid", "pr-1", block.ActionExtract)
	if attrs["content"] != "| a | b |\n|---|---|\n| 1 | 2 |" {
		t.Fatalf("extract to prose content failed: %+v", attrs)
	}
}

// Aliases live on the SieveBlock struct, not in Attrs — so the fenced serializer
// (which writes Attrs as YAML) dropped them on every save. Only prose survived,
// via its <!--s:ID a1 a2--> marker. Nothing writes aliases today, so this guards
// the gap rather than a live loss: the alias UI must not inherit a silent
// drop-on-save.
func TestFencedBlock_AliasesRoundTrip(t *testing.T) {
	const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	original := block.SieveBlock{
		ID:      id,
		Kind:    "code",
		Attrs:   map[string]interface{}{"id": id, "source": "x := 1"},
		Aliases: []string{"cd-1a2b", "the-retry-loop"},
	}

	md, err := block.FencedSerializer{}.Serialize(original)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if !strings.Contains(md, "aliases:") {
		t.Fatalf("serialized fence carries no aliases key:\n%s", md)
	}

	got, err := block.FencedDeserializer{Kind: "code"}.Deserialize(
		block.Region{Kind: "code", Raw: md, Body: md})
	if err != nil {
		t.Fatalf("deserialize: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 block, got %d", len(got))
	}
	if strings.Join(got[0].Aliases, ",") != "cd-1a2b,the-retry-loop" {
		t.Fatalf("aliases lost: %v", got[0].Aliases)
	}
	if _, leaked := got[0].Attrs["aliases"]; leaked {
		t.Fatal("aliases leaked into Attrs — Merge replaces Aliases, so a mirrored copy goes stale")
	}
}

func TestFencedBlock_NoAliasesEmitsNoKey(t *testing.T) {
	const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	md, err := block.FencedSerializer{}.Serialize(block.SieveBlock{
		ID: id, Kind: "code", Attrs: map[string]interface{}{"id": id},
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if strings.Contains(md, "aliases") {
		t.Fatalf("alias-free block emitted an aliases key:\n%s", md)
	}
}

// The serializer must not mutate the caller's live Attrs map — processors build
// throwaway blocks over live maps.
func TestFencedBlock_SerializeDoesNotMutateCallerAttrs(t *testing.T) {
	const id = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	attrs := map[string]interface{}{"id": id}
	_, err := block.FencedSerializer{}.Serialize(block.SieveBlock{
		ID: id, Kind: "code", Attrs: attrs, Aliases: []string{"cd-1a2b"},
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	if _, mutated := attrs["aliases"]; mutated {
		t.Fatal("Serialize wrote aliases into the caller's live Attrs map")
	}
}
