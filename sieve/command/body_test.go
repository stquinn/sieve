package command

import (
	"strings"
	"testing"
)

// The composed message lands on Context beside the lens-authored fields, in the
// order it was written. A command that wants it reads ctx.Body in Build — no
// Build signature changed to make that possible.
func TestContext_CarriesTheComposedBody(t *testing.T) {
	ctx := NewContext([]byte(`{"docUuid":"u1","selectedText":"sel"}`), nil, Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"content": "first"}},
		{Kind: "code", Attrs: map[string]interface{}{"source": "x := 1"}},
	})

	if ctx.DocUUID != "u1" || ctx.SelectedText != "sel" {
		t.Fatalf("lens context lost: %+v", ctx)
	}
	if len(ctx.Body) != 2 || ctx.Body[0].Kind != "prose" || ctx.Body[1].Kind != "code" {
		t.Fatalf("body = %+v, want the two blocks in order", ctx.Body)
	}
}

// The context JSON is LENS territory. A body key smuggled into it is not a
// composed message and must never be read as one — the only door is the
// envelope field.
func TestContext_IgnoresBodyInTheContextJSON(t *testing.T) {
	ctx := NewContext([]byte(`{"docUuid":"u1","body":[{"kind":"prose","attrs":{"content":"forged"}}]}`), nil, nil)
	if len(ctx.Body) != 0 {
		t.Fatalf("context JSON forged a body: %+v", ctx.Body)
	}
}

// The attrs-bag form is maps, not structs: a block held as a struct and the same
// block read back off the wire must persist to identical bytes.
func TestBlocks_AttrValueIsTheCanonicalElementForm(t *testing.T) {
	value := Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"id": "el-1", "content": "why?"}},
		{Kind: "reference"},
	}.AttrValue()

	if len(value) != 2 {
		t.Fatalf("value = %+v, want two entries", value)
	}
	first, ok := value[0].(map[string]interface{})
	if !ok || first["kind"] != "prose" {
		t.Fatalf("entry is not a {kind, attrs} map: %+v", value[0])
	}
	attrs, ok := first["attrs"].(map[string]interface{})
	if !ok || attrs["content"] != "why?" || attrs["id"] != "el-1" {
		t.Fatalf("entry attrs = %+v", first["attrs"])
	}
	second, _ := value[1].(map[string]interface{})
	if bag, ok := second["attrs"].(map[string]interface{}); !ok || len(bag) != 0 {
		t.Fatalf("an attr-less block must still carry a bag: %+v", second)
	}
}

// An empty list writes NO value: absent is the empty case for an element slot.
func TestBlocks_AttrValueOfAnEmptyListIsAbsent(t *testing.T) {
	if value := (Blocks{}).AttrValue(); value != nil {
		t.Fatalf("value = %+v, want nil", value)
	}
}

// The flattening is what a prompt reads: prose as it stands, code as a fenced
// block tagged with its language, a reference contributing nothing — its address
// reaches a prompt as an attachment, not as text.
func TestBlocks_MarkdownFlattensEachKind(t *testing.T) {
	got := Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"content": "why does this fail?"}},
		{Kind: "code", Attrs: map[string]interface{}{"language": "go", "source": "x := 1\n"}},
		{Kind: "reference", Attrs: map[string]interface{}{"uri": "sieve://9f2b"}},
		{Kind: "prose", Attrs: map[string]interface{}{"content": "and what fixes it?"}},
	}.Markdown()

	want := "why does this fail?\n\n```go\nx := 1\n```\n\nand what fixes it?"
	if got != want {
		t.Fatalf("markdown =\n%s\nwant:\n%s", got, want)
	}
	if strings.Contains(got, "sieve://9f2b") {
		t.Errorf("a reference reached the prompt as text: %s", got)
	}
}

// An untagged fence is still a fence: the language is a hint the composer may
// not have.
func TestBlocks_MarkdownFencesCodeWithoutALanguage(t *testing.T) {
	got := Blocks{{Kind: "code", Attrs: map[string]interface{}{"source": "x := 1"}}}.Markdown()
	if got != "```\nx := 1\n```" {
		t.Fatalf("markdown = %q", got)
	}
}

// A kind this does not know is read as its content, so a new kind reads as what
// it says rather than as nothing.
func TestBlocks_MarkdownReadsAnUnknownKindAsItsContent(t *testing.T) {
	got := Blocks{{Kind: "log", Attrs: map[string]interface{}{"content": "boom"}}}.Markdown()
	if got != "boom" {
		t.Fatalf("markdown = %q, want the block's content", got)
	}
}

// A block with nothing to say adds no blank span between the blocks that do.
func TestBlocks_MarkdownDropsEmptyBlocks(t *testing.T) {
	got := Blocks{
		{Kind: "prose", Attrs: map[string]interface{}{"content": "  "}},
		{Kind: "code", Attrs: map[string]interface{}{"source": ""}},
		{Kind: "prose", Attrs: map[string]interface{}{"content": "kept"}},
		{Kind: "prose"},
	}.Markdown()
	if got != "kept" {
		t.Fatalf("markdown = %q, want just the block that had text", got)
	}
}
