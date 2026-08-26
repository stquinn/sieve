package domain

import (
	"reflect"
	"testing"
)

// The YAML parse hands back []interface{} of map[string]interface{}; the JSON
// wire hands back the same shape. Both must decode.
func TestDecodeAttachments_ReadsTheParsedShape(t *testing.T) {
	got := DecodeAttachments([]interface{}{
		map[string]interface{}{"uri": "sieve://9f2b", "title": "Auth Design"},
		map[string]interface{}{"uri": "sieve://7a1c", "title": "Retry RFC"},
	})
	want := Attachments{
		{URI: "sieve://9f2b", Title: "Auth Design"},
		{URI: "sieve://7a1c", Title: "Retry RFC"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}

// uri and title are the whole of an attachment. The decode is the door where a
// chip's transient fields are dropped, so nothing else can be persisted and read
// back as truth.
func TestDecodeAttachments_KeepsOnlyURIAndTitle(t *testing.T) {
	got := DecodeAttachments([]interface{}{
		map[string]interface{}{
			"uri": "sieve://9f2b", "title": "Auth Design",
			"kind": "note", "summary": "stale summary",
		},
	})
	want := Attachments{{URI: "sieve://9f2b", Title: "Auth Design"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}

func TestDecodeAttachments_DropsEntriesWithNoURI(t *testing.T) {
	got := DecodeAttachments([]interface{}{
		map[string]interface{}{"title": "Nameless"},
		map[string]interface{}{"uri": "  ", "title": "Blank"},
		map[string]interface{}{"uri": "sieve://9f2b"},
		"sieve://not-a-map",
	})
	want := Attachments{{URI: "sieve://9f2b"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("decoded %+v, want %+v", got, want)
	}
}

func TestDecodeAttachments_AbsentOrEmptyIsNothing(t *testing.T) {
	for name, v := range map[string]any{
		"absent":     nil,
		"empty list": []interface{}{},
		"wrong type": "sieve://9f2b",
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
	got := Attachments{{URI: "sieve://9f2b", Title: "Auth Design"}}.AttrValue()
	want := []interface{}{map[string]interface{}{"uri": "sieve://9f2b", "title": "Auth Design"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AttrValue = %#v, want %#v", got, want)
	}
	titleless := Attachments{{URI: "sieve://9f2b"}}.AttrValue()
	if !reflect.DeepEqual(titleless, []interface{}{map[string]interface{}{"uri": "sieve://9f2b"}}) {
		t.Errorf("a title-less attachment must not persist an empty title: %#v", titleless)
	}
}

// StampAttrs is how a result block records what it was given: the canonical
// form under the one key, and NO key at all when nothing was attached.
func TestAttachments_StampAttrs(t *testing.T) {
	attrs := map[string]interface{}{"status": "COMPLETE"}
	Attachments{{URI: "sieve://9f2b", Title: "Auth Design"}}.StampAttrs(attrs)

	list, ok := attrs[AttachmentsAttr].([]interface{})
	if !ok || len(list) != 1 {
		t.Fatalf("attrs[%s] = %#v", AttachmentsAttr, attrs[AttachmentsAttr])
	}
	if entry := list[0].(map[string]interface{}); entry["uri"] != "sieve://9f2b" || entry["title"] != "Auth Design" {
		t.Errorf("entry = %#v", list[0])
	}

	Attachments(nil).StampAttrs(attrs)
	if _, present := attrs[AttachmentsAttr]; present {
		t.Errorf("an empty list left the attr behind: %#v", attrs)
	}
	if attrs["status"] != "COMPLETE" {
		t.Errorf("stamping trampled the rest of the bag: %#v", attrs)
	}
	Attachments{{URI: "sieve://9f2b"}}.StampAttrs(nil) // must not panic
}
