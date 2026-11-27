package block

import "testing"

const addrDoc = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a00"

// addr is the absolute address of block id in the fixture document.
func addr(id string) string { return "sieve://" + addrDoc + "/" + id }

func TestMergeContexts_concatAppendUnion(t *testing.T) {
	a := AIContext{Addresses: []string{addr("pr-1")}, Content: "alpha", Tags: []Tag{{Label: "Specifically regarding", Values: []string{"is some text"}}}}
	b := AIContext{Addresses: []string{addr("pr-2")}, Content: "beta", Tags: []Tag{{Label: "Specifically regarding", Values: []string{"some"}}}}

	m := MergeContexts([]AIContext{a, b})

	if got := join(m.Addresses); got != addr("pr-1")+","+addr("pr-2") {
		t.Errorf("Addresses concat = %q", got)
	}
	if m.Content != "alpha\n\nbeta" {
		t.Errorf("Content append = %q", m.Content)
	}
	if len(m.Tags) != 1 || m.Tags[0].Label != "Specifically regarding" || join(m.Tags[0].Values) != "is some text,some" {
		t.Errorf("Tags union = %#v", m.Tags)
	}
}

func TestMergeContexts_dedupesTagValuesAndDropsEmptyContent(t *testing.T) {
	a := AIContext{Addresses: []string{addr("pr-1")}, Content: "alpha", Tags: []Tag{{Label: "F", Values: []string{"x"}}}}
	empty := AIContext{Addresses: []string{addr("pr-2")}, Content: "   ", Tags: nil}
	c := AIContext{Addresses: []string{addr("pr-3")}, Content: "gamma", Tags: []Tag{{Label: "F", Values: []string{"x", "y"}}}}

	m := MergeContexts([]AIContext{a, empty, c})

	if join(m.Addresses) != addr("pr-1")+","+addr("pr-2")+","+addr("pr-3") {
		t.Errorf("Addresses = %v", m.Addresses)
	}
	if m.Content != "alpha\n\ngamma" { // empty/whitespace content dropped
		t.Errorf("Content = %q", m.Content)
	}
	if len(m.Tags) != 1 || join(m.Tags[0].Values) != "x,y" { // dedup x
		t.Errorf("Tags dedup = %#v", m.Tags)
	}
}

func TestMergeContexts_ofOneIsIdentity(t *testing.T) {
	a := AIContext{Addresses: []string{addr("pr-1")}, Content: "alpha", Tags: []Tag{{Label: "F", Values: []string{"x"}}}}
	m := MergeContexts([]AIContext{a})
	if m.String() != a.String() {
		t.Errorf("merge-of-one not identity:\n got %q\nwant %q", m.String(), a.String())
	}
}

func TestAIContext_String_headerContentTrailer(t *testing.T) {
	c := AIContext{
		Addresses: []string{addr("pr-c2dc"), addr("pr-f405")},
		Content:   "This ==is some text==\n\n==Some== more text",
		Tags:      []Tag{{Label: "Specifically regarding", Values: []string{"is some text", "some"}}},
	}
	want := "ADDRESS: " + addr("pr-c2dc") + "," + addr("pr-f405") + "\n" +
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
		Addresses: []string{addr("img-1")},
		Content:   "Image: x.png",
		Tags: []Tag{
			{Label: "ALT", Values: []string{""}},                   // all empty → dropped
			{Label: "Summary", Values: []string{"", "a real one"}}, // empty filtered, keep the real
		},
	}
	want := "ADDRESS: " + addr("img-1") + "\nImage: x.png\n\n" + `Summary: "a real one"`
	if got := c.String(); got != want {
		t.Errorf("String():\n got %q\nwant %q", got, want)
	}
}

func TestAIContext_String_taglessBlock(t *testing.T) {
	c := AIContext{Addresses: []string{addr("co-1")}, Content: "source: x"}
	if got := c.String(); got != "ADDRESS: "+addr("co-1")+"\nsource: x" {
		t.Errorf("tagless String = %q", got)
	}
}

// A context built with no container to address against has no header, and the
// block's bare id is never printed in its place. The whole document is headed
// by the container's own address.
func TestDocView_Contexts_addressTheirNodeOrPrintNoHeader(t *testing.T) {
	cases := []struct {
		name            string
		doc             DocView
		want, wantWhole string
	}{
		{"a container", DocView{UUID: addrDoc}, "ADDRESS: " + addr("pr-1") + "\nalpha", "ADDRESS: sieve://" + addrDoc + "\nalpha"},
		{"no container", DocView{}, "alpha", "alpha"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.doc.NodeContext("pr-1", "alpha").String(); got != tc.want {
				t.Errorf("String() = %q, want %q", got, tc.want)
			}
			if got := tc.doc.DocumentContext("alpha").String(); got != tc.wantWhole {
				t.Errorf("DocumentContext String() = %q, want %q", got, tc.wantWhole)
			}
		})
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

func TestContextSeries_Blocks_entriesAreNumberedTypedAndShareOneTrailer(t *testing.T) {
	focus := func(v string) []Tag { return []Tag{{Label: "Specifically regarding", Values: []string{v}}} }
	s := ContextSeries{
		{Kind: "prose", Addresses: []string{addr("pr-1")}, Content: "alpha", Tags: focus("a")},
		{},
		{Kind: "reference", Content: "Reference: x", Tags: focus("b")},
	}
	got := s.Blocks()
	wantExact := "===== BLOCK 1 of 2 · prose =====\nADDRESS: " + addr("pr-1") + "\nalpha\n\n" +
		"===== BLOCK 2 of 2 · reference =====\nReference: x\n\n" + `Specifically regarding: "a", "b"`
	if got != wantExact {
		t.Errorf("Blocks():\n got %q\nwant %q", got, wantExact)
	}
	if (ContextSeries{{}, {}}).Blocks() != "" {
		t.Error("a series of empty members must render as nothing")
	}
}

func TestContextSeries_Turns_keepEachEntrysOwnTrailer(t *testing.T) {
	focus := []Tag{{Label: "Specifically regarding", Values: []string{"a"}}}
	s := ContextSeries{{Addresses: []string{addr("ai-1")}, Content: "q1", Tags: focus}, {}, {Content: "q2"}}
	want := "===== TURN 1 of 2 =====\nADDRESS: " + addr("ai-1") + "\nq1\n\n" + `Specifically regarding: "a"` +
		"\n\n===== TURN 2 of 2 =====\nq2"
	if got := s.Turns(); got != want {
		t.Errorf("Turns():\n got %q\nwant %q", got, want)
	}
}
