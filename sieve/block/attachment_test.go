package block

import (
	"reflect"
	"testing"
)

// The YAML parse hands back []interface{} of map[string]interface{}; the JSON
// wire hands back the same shape. Both must decode.
func TestDecodeAttachments_ReadsTheParsedShape(t *testing.T) {
	got := DecodeAttachments([]interface{}{
		map[string]interface{}{"uri": "container:9f2b", "title": "Auth Design"},
		map[string]interface{}{"uri": "container:7a1c", "title": "Retry RFC"},
	})
	want := Attachments{
		{URI: "container:9f2b", Title: "Auth Design"},
		{URI: "container:7a1c", Title: "Retry RFC"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}

// title is a render cache; kind and summary are resolved fresh through the Router
// at job time. The decode is the door where a chip's transient fields are
// dropped, so they can never be persisted and read back as truth.
func TestDecodeAttachments_KeepsOnlyURIAndTitle(t *testing.T) {
	got := DecodeAttachments([]interface{}{
		map[string]interface{}{
			"uri": "container:9f2b", "title": "Auth Design",
			"kind": "note", "summary": "stale summary",
		},
	})
	want := Attachments{{URI: "container:9f2b", Title: "Auth Design"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}

func TestDecodeAttachments_DropsEntriesWithNoURI(t *testing.T) {
	got := DecodeAttachments([]interface{}{
		map[string]interface{}{"title": "Nameless"},
		map[string]interface{}{"uri": "  ", "title": "Blank"},
		map[string]interface{}{"uri": "container:9f2b"},
		"container:not-a-map",
	})
	want := Attachments{{URI: "container:9f2b"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}

func TestDecodeAttachments_AbsentOrEmptyIsNothing(t *testing.T) {
	for name, v := range map[string]any{
		"absent":     nil,
		"empty list": []interface{}{},
		"wrong type": "container:9f2b",
	} {
		if got := DecodeAttachments(v); len(got) != 0 {
			t.Errorf("%s decoded to %+v, want nothing", name, got)
		}
	}
}

// ONE canonical attrs-bag form on the way in and out: a []interface{} of
// map[string]interface{}. A []Attachment would marshal in struct-field order and
// a map in sorted-key order — two YAML spellings of the same data, which is what
// breaks byte-stability.
func TestAttachments_AttrValueIsTheCanonicalForm(t *testing.T) {
	got := Attachments{{URI: "container:9f2b", Title: "Auth Design"}}.AttrValue()
	want := []interface{}{map[string]interface{}{"uri": "container:9f2b", "title": "Auth Design"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AttrValue = %#v, want %#v", got, want)
	}
	titleless := Attachments{{URI: "container:9f2b"}}.AttrValue()
	if !reflect.DeepEqual(titleless, []interface{}{map[string]interface{}{"uri": "container:9f2b"}}) {
		t.Errorf("a title-less attachment must not persist an empty title: %#v", titleless)
	}
}

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
