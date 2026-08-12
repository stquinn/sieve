package block

import "testing"

// The list type, its attrs-bag translation and its prompt renderer are
// domain.Attachments' (see attachment.go). What block owns — and what these
// tests cover — is the pair of accessors that know which attr key a SieveBlock
// keeps the list under.

func TestSieveBlock_AttachmentsRoundTripThroughTheAttrsBag(t *testing.T) {
	b := NewSieveBlock("ai-block", "ai-c71e", nil)
	b.SetAttachments(Attachments{
		{URI: "container:9f2b", Title: "Auth Design"},
		{URI: "container:7a1c", Title: "Retry RFC"},
	})

	got := b.Attachments()
	if len(got) != 2 || got[0].URI != "container:9f2b" || got[1].Title != "Retry RFC" {
		t.Fatalf("Attachments() = %+v", got)
	}
	if _, ok := b.Attrs[AttachmentsAttr].([]interface{}); !ok {
		t.Errorf("the attr must hold the canonical wire form, got %#v", b.Attrs[AttachmentsAttr])
	}
}

// Absent IS the empty case: a block that attached nothing must carry no attr at
// all, so it serializes exactly as it did before the attr existed.
func TestSieveBlock_SetAttachmentsEmptyRemovesTheAttr(t *testing.T) {
	b := NewSieveBlock("ai-block", "ai-c71e", nil)
	b.SetAttachments(Attachments{{URI: "container:9f2b"}})
	b.SetAttachments(nil)

	if _, present := b.Attrs[AttachmentsAttr]; present {
		t.Fatalf("empty list left the attr behind: %#v", b.Attrs)
	}
	if got := b.Attachments(); len(got) != 0 {
		t.Errorf("Attachments() = %+v, want nothing", got)
	}
}
