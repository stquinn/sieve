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

func TestParseBlockDoc_ProseAndFence(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nWorld."
	doc, err := ParseBlockDoc(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc.Blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc.Blocks), doc.Blocks)
	}
	if doc.Blocks[0].Kind != KindProse || doc.Blocks[0].Content != "Hello." {
		t.Fatalf("block 0: %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].Kind != "code" || doc.Blocks[1].ID != "co-1" {
		t.Fatalf("block 1: %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Kind != KindProse || doc.Blocks[2].Content != "World." {
		t.Fatalf("block 2: %+v", doc.Blocks[2])
	}
}

func TestSplitProseRun(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"single", "Just one paragraph.", []string{"Just one paragraph."}},
		{"two paras", "First.\n\nSecond.", []string{"First.", "Second."}},
		{"heading then para", "# Title\n\nBody.", []string{"# Title", "Body."}},
		{"multiline para stays", "Line one\nline two.", []string{"Line one\nline two."}},
		{"tight list stays one", "- a\n- b\n- c", []string{"- a\n- b\n- c"}},
		{"fence with blank line is atomic", "```python\nx = 1\n\ny = 2\n```", []string{"```python\nx = 1\n\ny = 2\n```"}},
		{"para then fenced code", "Intro.\n\n```js\na\n\nb\n```\n\nOutro.", []string{"Intro.", "```js\na\n\nb\n```", "Outro."}},
		{"collapses extra blanks", "A.\n\n\n\nB.", []string{"A.", "B."}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := splitProseRun(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("len: want %d got %d: %q", len(c.want), len(got), got)
			}
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("block %d: want %q got %q", i, c.want[i], got[i])
				}
			}
		})
	}
}

func TestParseBlockDoc_PerParagraph(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "# Title\n\nIntro prose.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nFirst tail.\n\nSecond tail."
	doc, err := ParseBlockDoc(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	wantKinds := []struct {
		kind    string
		content string
	}{
		{KindProse, "# Title"},
		{KindProse, "Intro prose."},
		{"code", ""},
		{KindProse, "First tail."},
		{KindProse, "Second tail."},
	}
	if len(doc.Blocks) != len(wantKinds) {
		t.Fatalf("want %d blocks, got %d: %+v", len(wantKinds), len(doc.Blocks), doc.Blocks)
	}
	for i, w := range wantKinds {
		if doc.Blocks[i].Kind != w.kind {
			t.Fatalf("block %d kind: want %q got %q", i, w.kind, doc.Blocks[i].Kind)
		}
		if w.kind == KindProse && doc.Blocks[i].Content != w.content {
			t.Fatalf("block %d content: want %q got %q", i, w.content, doc.Blocks[i].Content)
		}
	}
}

func TestBlockDoc_RoundTripStable(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })
	RegisterProcessor("column-row", &CodeBlockProcessor{}) // any block-mode processor suffices for the parse gate
	t.Cleanup(func() { UnregisterProcessor("column-row") })

	// Each prose block is a single paragraph so per-paragraph segmentation
	// (Stage B.1) preserves the block count through the round-trip.
	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "# Title"},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Content: "Between."},
		{ID: "cr-1", Kind: KindColumnRow, Attrs: map[string]interface{}{"id": "cr-1", "widths": []interface{}{0.5, 0.5}}},
		{Kind: KindProse, Content: "Tail."},
	}}

	md1, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize 1: %v", err)
	}
	parsed, err := ParseBlockDoc(md1)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed.Blocks) != len(doc.Blocks) {
		t.Fatalf("block count drift: want %d got %d", len(doc.Blocks), len(parsed.Blocks))
	}
	md2, err := SerializeBlockDoc(parsed)
	if err != nil {
		t.Fatalf("serialize 2: %v", err)
	}
	if md1 != md2 {
		t.Fatalf("round-trip not stable:\n md1: %q\n md2: %q", md1, md2)
	}
}
