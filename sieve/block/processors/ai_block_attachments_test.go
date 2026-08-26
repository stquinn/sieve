package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// serializeThroughProductionCodec round-trips blocks through the real codec and
// returns both spellings, so a test can assert the fixpoint rather than a
// hand-rolled YAML expectation.
func serializeReparseSerialize(t *testing.T, blocks []block.SieveBlock) (first, second string, back []block.SieveBlock) {
	t.Helper()
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	first, err := codec.Serialize(blocks)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	back, err = codec.Deserialize(first)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	second, err = codec.Serialize(back)
	if err != nil {
		t.Fatalf("re-serialize: %v", err)
	}
	return first, second, back
}

func TestAIBlock_AttachmentsRoundTripByteStable(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	blk := block.NewSieveBlock("ai-block", "ai-c71e", map[string]interface{}{
		"question": "How does @Auth Design handle this?",
		"ref":      "blk-3",
		"type":     "ASK",
		"status":   block.BlockStatusPending,
	})
	blk.SetAttachments(block.Attachments{
		{URI: "sieve://9f2b3c4d-1a2b-4c5d-8e9f-a1b2c3d4e5f6", Title: "Auth Design"},
		{URI: "sieve://7a1c9b2e-3d4f-4a5b-9c8d-0e1f2a3b4c5d", Title: "Retry RFC"},
	})

	first, second, back := serializeReparseSerialize(t, []block.SieveBlock{blk})

	// The persisted shape, pinned: a YAML sequence of uri (+ cached title) under
	// `attachments`, indented — a sequence at column zero would put "- " where the
	// shape scanner looks for a closing fence.
	wantYAML := "attachments:\n" +
		"    - title: Auth Design\n" +
		"      uri: sieve://9f2b3c4d-1a2b-4c5d-8e9f-a1b2c3d4e5f6\n" +
		"    - title: Retry RFC\n" +
		"      uri: sieve://7a1c9b2e-3d4f-4a5b-9c8d-0e1f2a3b4c5d\n"
	if !strings.Contains(first, wantYAML) {
		t.Fatalf("attachments not persisted in the canonical form:\n--- want ---\n%s\n--- got ---\n%s", wantYAML, first)
	}
	if first != second {
		t.Fatalf("serialize is not a fixpoint:\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}

	if len(back) != 1 {
		t.Fatalf("want 1 block back, got %d:\n%s", len(back), first)
	}
	got := back[0].Attachments()
	if len(got) != 2 {
		t.Fatalf("attachments = %+v, want 2", got)
	}
	if got[0].URI != "sieve://9f2b3c4d-1a2b-4c5d-8e9f-a1b2c3d4e5f6" || got[0].Title != "Auth Design" {
		t.Errorf("attachment[0] = %+v", got[0])
	}
	if got[1].URI != "sieve://7a1c9b2e-3d4f-4a5b-9c8d-0e1f2a3b4c5d" || got[1].Title != "Retry RFC" {
		t.Errorf("attachment[1] = %+v", got[1])
	}
	// `ref` is untouched: the local chain and the coordinates never mix.
	if back[0].Ref() != "blk-3" {
		t.Errorf("ref = %q, want blk-3", back[0].Ref())
	}
}

// The empty case: a block that attached nothing carries no attr, so it persists
// byte-for-byte as it did before the attr existed.
func TestAIBlock_NoAttachmentsPersistsNoAttr(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	blk := block.NewSieveBlock("ai-block", "ai-c71e", map[string]interface{}{
		"question": "Plain question?",
		"ref":      "doc",
		"type":     "ASK",
	})

	first, second, back := serializeReparseSerialize(t, []block.SieveBlock{blk})

	if strings.Contains(first, "attachments") {
		t.Fatalf("an attachment-less block must carry no attr:\n%s", first)
	}
	if first != second {
		t.Fatalf("serialize is not a fixpoint:\n--- first ---\n%s\n--- second ---\n%s", first, second)
	}
	if got := back[0].Attachments(); len(got) != 0 {
		t.Errorf("Attachments() = %+v, want nothing", got)
	}
}

// Attachments arrive from the composer as a loose wire list. InitAttrs is the
// door: only uri + title persist (a chip's decoration is transient), and an
// empty list is no attr.
func TestAIBlockInitAttrs_NormalisesAttachments(t *testing.T) {
	p := &AIBlockProcessor{}

	attrs := p.InitAttrs("ai-c71e", map[string]interface{}{
		"question": "How does @Auth Design handle this?",
		"attachments": []interface{}{
			map[string]interface{}{
				"uri": "sieve://9f2b", "title": "Auth Design",
				"kind": "note", "summary": "decoration, never persisted",
			},
			map[string]interface{}{"title": "no address"},
		},
	})

	got := block.SieveBlock{Attrs: attrs}.Attachments()
	if len(got) != 1 {
		t.Fatalf("attachments = %+v, want just the addressable one", got)
	}
	if got[0].URI != "sieve://9f2b" || got[0].Title != "Auth Design" {
		t.Errorf("attachment = %+v", got[0])
	}
	entry, ok := attrs["attachments"].([]interface{})[0].(map[string]interface{})
	if !ok {
		t.Fatalf("attr is not the canonical form: %#v", attrs["attachments"])
	}
	if len(entry) != 2 {
		t.Errorf("transient chip fields persisted: %#v", entry)
	}
}

func TestAIBlockInitAttrs_EmptyAttachmentsCarryNoAttr(t *testing.T) {
	p := &AIBlockProcessor{}
	attrs := p.InitAttrs("ai-c71e", map[string]interface{}{
		"question":    "Plain question?",
		"attachments": []interface{}{},
	})
	if _, present := attrs["attachments"]; present {
		t.Fatalf("empty attachments left an attr behind: %#v", attrs)
	}
}
