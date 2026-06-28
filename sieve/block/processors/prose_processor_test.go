package processors

import (
	"bytes"
	"sieve/sieve/block"
	"strconv"
	"strings"
	"testing"

	"github.com/yuin/goldmark"
)

// Embedding a code/diagram/log block into prose is the "this was wrongly detected as
// code — give me the TEXT" escape hatch. The raw source can't be stored verbatim as
// prose markdown: 4-space indents render as an indented code block (a stray fence) and
// bare newlines soft-join lines (the split header/tail the user saw). The embed must
// neutralise both so the source renders as plain text.
func TestProseProcessor_Transform_codeSourceEmbedsAsSafePlainText(t *testing.T) {
	var p ProseProcessor
	// The exact structure that mangled: 0-indent braces, 4-space-indented bodies,
	// a blank line between members.
	src := "public class Greeter {\n    private final String name;\n\n    public Greeter(String name) {\n        this.name = name;\n    }\n}"
	entries := []block.ContentEntry{{
		MIMEType: "sieve/code",
		Content:  `{"language":"java","source":` + strconv.Quote(src) + `}`,
	}}

	overrides := p.Transform(entries, "", "", block.ActionTransform)
	content, _ := overrides["content"].(string)
	if strings.TrimSpace(content) == "" {
		t.Fatal("expected embedded content, got empty")
	}

	var buf bytes.Buffer
	if err := goldmark.New().Convert([]byte(content), &buf); err != nil {
		t.Fatal(err)
	}
	html := buf.String()

	// Must NOT render as a code block — that is the stray fence with the header/tail
	// lines pushed outside it.
	if strings.Contains(html, "<pre") {
		t.Errorf("embedded source rendered as a code block (stray fence):\n%s", html)
	}
	// Lines must stay distinct (hard breaks), not soft-join into one paragraph line.
	if !strings.Contains(html, "<br") {
		t.Errorf("source lines soft-joined (no hard break) — would merge in markdown:\n%s", html)
	}
	// The source text survives (de-indented).
	for _, want := range []string{"public class Greeter {", "private final String name;", "this.name = name;"} {
		if !strings.Contains(html, want) {
			t.Errorf("expected source line %q preserved, got:\n%s", want, html)
		}
	}
}

// TestProseProcessor_BuildContextEmitsHighlightTargets: the retired block-anchor's
// "Specifically regarding" targets feature is replicated on prose — derived from
// the ==highlighted== words that live in the block's content.
func TestProseProcessor_BuildContextEmitsHighlightTargets(t *testing.T) {
	var p ProseProcessor
	blk := p.newProseBlock("pr-1", "The patient showed ==acute== and ==rapid onset== symptoms.")
	ctx := p.BuildContext(blk, block.DocView{}, nil).String()
	if !strings.Contains(ctx, "Specifically regarding") {
		t.Errorf("expected targets hint, got %q", ctx)
	}
	if !strings.Contains(ctx, `"acute"`) || !strings.Contains(ctx, `"rapid onset"`) {
		t.Errorf("expected both targets quoted, got %q", ctx)
	}
	if !strings.Contains(ctx, "==acute==") {
		t.Errorf("expected highlight content preserved verbatim, got %q", ctx)
	}
}

func TestProseProcessor_BuildContextNoHighlightsNoHint(t *testing.T) {
	var p ProseProcessor
	blk := p.newProseBlock("pr-1", "Plain prose, no highlights.")
	ctx := p.BuildContext(blk, block.DocView{}, nil).String()
	if strings.Contains(ctx, "Specifically regarding") {
		t.Errorf("expected no hint without highlights, got %q", ctx)
	}
}

func TestProseProcessor_DeserializeSplitsAtMarkers(t *testing.T) {
	var p ProseProcessor
	raw := "<!--s:pr-1-->\nHello world\n<!--/s:pr-1-->\n\n<!--s:pr-2 pr-old-->\nSecond\n<!--/s:pr-2-->"
	blocks, err := p.Deserialize(block.Region{Raw: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 prose blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].ID != "pr-1" || blocks[0].Content() != "Hello world" {
		t.Errorf("block0 = %q/%q", blocks[0].ID, blocks[0].Content())
	}
	if blocks[1].ID != "pr-2" || len(blocks[1].Aliases) != 1 || blocks[1].Aliases[0] != "pr-old" {
		t.Errorf("block1 id/aliases = %q/%v", blocks[1].ID, blocks[1].Aliases)
	}
}

func TestProseProcessor_DeserializeUndelimitedMintsOneBlock(t *testing.T) {
	var p ProseProcessor
	blocks, err := p.Deserialize(block.Region{Raw: "just some prose\nover two lines"})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].ID == "" {
		t.Fatalf("want one minted prose block, got %#v", blocks)
	}
	if blocks[0].Content() != "just some prose\nover two lines" {
		t.Errorf("content = %q", blocks[0].Content())
	}
}

func TestProseProcessor_DeserializeKeepsUnclaimedFenceAsContent(t *testing.T) {
	var p ProseProcessor
	raw := "text before\n```python\nprint(1)\n```\ntext after"
	blocks, err := p.Deserialize(block.Region{Raw: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want one prose block holding the fence verbatim, got %d", len(blocks))
	}
	if blocks[0].Content() != raw {
		t.Errorf("content = %q, want verbatim %q", blocks[0].Content(), raw)
	}
}

func TestProseProcessor_AcceptsIsTerminal(t *testing.T) {
	var p ProseProcessor
	if !p.Accepts(block.Region{Kind: "anything", Raw: "x"}) {
		t.Error("prose must accept everything (terminal mop-up)")
	}
}

func TestProseProcessor_IsSupportedContent_offersUndoForTaggedSource(t *testing.T) {
	block.ResetRegistry()
	// Restore prose registration after the test so other tests that rely on the
	// prose processor (registered via init()) are not left with an empty registry.
	t.Cleanup(func() { block.RegisterProcessor(&ProseProcessor{}) })
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor

	tagged := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2","smartPaste":true}`}}
	if !p.IsSupportedContent(tagged).Has(block.ActionUndoSmartPaste) {
		t.Error("tagged smart-pasted source must offer undo-smart-paste")
	}

	plain := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2"}`}}
	if p.IsSupportedContent(plain).Has(block.ActionUndoSmartPaste) {
		t.Error("a hand-made (untagged) source must NOT offer undo-smart-paste")
	}
	if !p.IsSupportedContent(plain).Has(block.ActionTransform) {
		t.Error("prose must still offer transform (embed) for any sieve source")
	}
}
