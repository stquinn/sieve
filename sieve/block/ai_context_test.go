package block

import "testing"

func TestMergeContexts_concatAppendUnion(t *testing.T) {
	a := AIContext{NodeIDs: []string{"pr-1"}, Content: "alpha", Tags: []Tag{{Label: "Specifically regarding", Values: []string{"is some text"}}}}
	b := AIContext{NodeIDs: []string{"pr-2"}, Content: "beta", Tags: []Tag{{Label: "Specifically regarding", Values: []string{"some"}}}}

	m := MergeContexts([]AIContext{a, b})

	if got := join(m.NodeIDs); got != "pr-1,pr-2" {
		t.Errorf("NodeIDs concat = %q", got)
	}
	if m.Content != "alpha\n\nbeta" {
		t.Errorf("Content append = %q", m.Content)
	}
	if len(m.Tags) != 1 || m.Tags[0].Label != "Specifically regarding" || join(m.Tags[0].Values) != "is some text,some" {
		t.Errorf("Tags union = %#v", m.Tags)
	}
}

func TestMergeContexts_dedupesTagValuesAndDropsEmptyContent(t *testing.T) {
	a := AIContext{NodeIDs: []string{"pr-1"}, Content: "alpha", Tags: []Tag{{Label: "F", Values: []string{"x"}}}}
	empty := AIContext{NodeIDs: []string{"pr-2"}, Content: "   ", Tags: nil}
	c := AIContext{NodeIDs: []string{"pr-3"}, Content: "gamma", Tags: []Tag{{Label: "F", Values: []string{"x", "y"}}}}

	m := MergeContexts([]AIContext{a, empty, c})

	if join(m.NodeIDs) != "pr-1,pr-2,pr-3" {
		t.Errorf("NodeIDs = %v", m.NodeIDs)
	}
	if m.Content != "alpha\n\ngamma" { // empty/whitespace content dropped
		t.Errorf("Content = %q", m.Content)
	}
	if len(m.Tags) != 1 || join(m.Tags[0].Values) != "x,y" { // dedup x
		t.Errorf("Tags dedup = %#v", m.Tags)
	}
}

func TestMergeContexts_ofOneIsIdentity(t *testing.T) {
	a := AIContext{NodeIDs: []string{"pr-1"}, Content: "alpha", Tags: []Tag{{Label: "F", Values: []string{"x"}}}}
	m := MergeContexts([]AIContext{a})
	if m.String() != a.String() {
		t.Errorf("merge-of-one not identity:\n got %q\nwant %q", m.String(), a.String())
	}
}

func TestAIContext_String_headerContentTrailer(t *testing.T) {
	c := AIContext{
		NodeIDs: []string{"pr-c2dc", "pr-f405"},
		Content: "This ==is some text==\n\n==Some== more text",
		Tags:    []Tag{{Label: "Specifically regarding", Values: []string{"is some text", "some"}}},
	}
	want := "NODE ID: pr-c2dc,pr-f405\n" +
		"This ==is some text==\n\n==Some== more text\n\n" +
		`Specifically regarding: "is some text", "some"`
	if got := c.String(); got != want {
		t.Errorf("String():\n got %q\nwant %q", got, want)
	}
}

func TestAIContext_String_docHasNoHeader(t *testing.T) {
	c := AIContext{Content: "whole doc markdown"}
	if got := c.String(); got != "whole doc markdown" {
		t.Errorf("doc context String = %q", got)
	}
}

func TestAIContext_String_skipsEmptyTagValuesAndTags(t *testing.T) {
	// A renderer may add tags unconditionally (e.g. smart-image ALT/Summary); empty
	// values must not render as `Label: ""`. A tag with NO non-empty value drops.
	c := AIContext{
		NodeIDs: []string{"img-1"},
		Content: "Image: x.png",
		Tags: []Tag{
			{Label: "ALT", Values: []string{""}},                 // all empty → dropped
			{Label: "Summary", Values: []string{"", "a real one"}}, // empty filtered, keep the real
		},
	}
	want := "NODE ID: img-1\nImage: x.png\n\n" + `Summary: "a real one"`
	if got := c.String(); got != want {
		t.Errorf("String():\n got %q\nwant %q", got, want)
	}
}

func TestAIContext_String_taglessBlock(t *testing.T) {
	c := AIContext{NodeIDs: []string{"co-1"}, Content: "source: x"}
	if got := c.String(); got != "NODE ID: co-1\nsource: x" {
		t.Errorf("tagless String = %q", got)
	}
}

func join(s []string) string {
	out := ""
	for i, x := range s {
		if i > 0 {
			out += ","
		}
		out += x
	}
	return out
}
