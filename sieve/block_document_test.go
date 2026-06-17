package sieve

import "testing"

func TestSerializeBlockDoc_ProseAndFence(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "Hello."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{
			"id":     "co-1",
			"source": "x = 1",
		}},
	}}
	got, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	if got != want {
		t.Fatalf("serialize mismatch:\n got: %q\nwant: %q", got, want)
	}
}
