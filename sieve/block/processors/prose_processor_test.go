package processors

import (
	"bytes"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"strconv"
	"strings"
	"testing"

	"github.com/yuin/goldmark"
)

// Embed in Document (ActionTransform) is faithful markdown: a code source becomes a fence.
func TestProseProcessor_Transform_embedReturnsFence(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor
	entries := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"language":"java","source":"class A {}"}`}}

	content, _ := p.Transform(entries, "", "", block.ActionTransform)["content"].(string)
	if !strings.Contains(content, "```") || !strings.Contains(content, "class A {}") {
		t.Errorf("ActionTransform must embed as a fence, got:\n%s", content)
	}
}

// Embed in Document on a markdown-language code block UNWRAPS: the source already
// IS document markdown (block.MarkdownContenter), so it embeds directly — no
// ```markdown fence. The escape hatch for markdown captured as a code block.
func TestProseProcessor_Transform_embedMarkdownCodeUnwraps(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor
	src := "# Notes\n\n- item one\n- item two"
	entries := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"language":"markdown","source":` + strconv.Quote(src) + `}`}}

	content, _ := p.Transform(entries, "", "", block.ActionTransform)["content"].(string)
	if content != src {
		t.Errorf("markdown-language code must embed its source directly, got:\n%s", content)
	}
}

// Undo Smart Paste (ActionUndoSmartPaste) is the escape hatch: raw text, no stray fence.
func TestProseProcessor_Transform_undoReturnsSafePlainText(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	defer block.UnregisterProcessor("code")
	var p ProseProcessor
	src := "public class Greeter {\n    private final String name;\n\n    public Greeter(String name) {\n        this.name = name;\n    }\n}"
	entries := []block.ContentEntry{{MIMEType: "sieve/code", Content: `{"language":"java","source":` + strconv.Quote(src) + `}`}}

	content, _ := p.Transform(entries, "", "", block.ActionUndoSmartPaste)["content"].(string)
	if strings.TrimSpace(content) == "" {
		t.Fatal("expected content, got empty")
	}
	var buf bytes.Buffer
	if err := goldmark.New().Convert([]byte(content), &buf); err != nil {
		t.Fatal(err)
	}
	html := buf.String()
	if strings.Contains(html, "<pre") {
		t.Errorf("undo rendered as a code block (stray fence):\n%s", html)
	}
	if !strings.Contains(html, "<br") {
		t.Errorf("undo lines soft-joined (no hard break):\n%s", html)
	}
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

// Which kinds take part in the text substrate, asked the only way anything may
// ask: the registry, never a kind list. READING and WRITING are separate
// answers, and the gap between them is the point — log hands out its
// captured text so a reader can index it, and accepts no writes back.
func TestProcessors_TextCapabilitiesAnswerThroughTheRegistry(t *testing.T) {
	block.ResetRegistry()
	block.RegisterProcessor(&ProseProcessor{})
	block.RegisterProcessor(&CodeBlockProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "code"}})
	block.RegisterProcessor(&DiagramProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "diagram"}})
	block.RegisterProcessor(&LogProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "log"}})
	t.Cleanup(func() {
		block.ResetRegistry()
		block.RegisterProcessor(&ProseProcessor{})
	})

	cases := []struct {
		kind      string
		bears     bool
		updatable bool
	}{
		{kind: block.KindProse, bears: true, updatable: true},
		// Code and diagram have no parse: their reading IS the raw slot text, so
		// their locators are self-sufficient (slot + hash) and both join prose
		// in the write lane.
		{kind: "code", bears: true, updatable: true},
		{kind: "diagram", bears: true, updatable: true},
		// A captured log is a record: it bears text (find can search it,
		// TestLogProcessor_NormalisedText in log_processor_test.go) but never
		// accepts a write (TestLogProcessor_IsNotATextUpdater, same file) —
		// reading and writing are separate predicates, and log answers yes to
		// the first and no to the second.
		{kind: "log", bears: true},
		{kind: "no-such-kind"},
	}
	for _, tc := range cases {
		t.Run(tc.kind, func(t *testing.T) {
			if _, ok := block.TextBearerFor(tc.kind); ok != tc.bears {
				t.Errorf("TextBearerFor(%q) = %v, want %v", tc.kind, ok, tc.bears)
			}
			if _, ok := block.TextUpdaterFor(tc.kind); ok != tc.updatable {
				t.Errorf("TextUpdaterFor(%q) = %v, want %v", tc.kind, ok, tc.updatable)
			}
		})
	}
}

// The ONE segment prose bears: its whole content, read as prose reads it. This
// pins the ENVELOPE — how many segments, what names them, what class they carry
// — and states just enough of the reading to show it is not the stored bytes.
// What that reading is derived from, case by case, is
// prose_reading_test.go's table.
func TestProseProcessor_NormalisedTextBearsOneSegmentOfProsesOwnReading(t *testing.T) {
	var p ProseProcessor
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"plain content reads as itself", "Hello world", "Hello world"},
		{"markdown syntax is read past, not handed out", "# Title\n\n- *one*\n- two", "Title\none\ntwo"},
		{"a url is not text a reader can be asked about", "see [docs](http://x.example/teh)", "see docs"},
		{"empty content is still one segment", "", ""},
	}
	otherBlk := p.newProseBlock("pr-2", "nothing like any case below")
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			blk := p.newProseBlock("pr-1", tc.content)
			segments := p.NormalisedText(&blk)
			if len(segments) != 1 {
				t.Fatalf("want exactly one segment, got %d: %#v", len(segments), segments)
			}
			if segments[0].Text != tc.want {
				t.Errorf("segment text = %q, want prose's reading %q", segments[0].Text, tc.want)
			}
			// The locator is minted, not a constant: it names the slot AND vouches
			// for the bytes read out of it, so two readings of different content
			// never carry the same one.
			if segments[0].Locator == "" || segments[0].Locator == ProseContentSlot {
				t.Errorf("locator = %q, want the minted record naming the slot and its bytes", segments[0].Locator)
			}
			if other := p.NormalisedText(&otherBlk)[0].Locator; other == segments[0].Locator {
				t.Errorf("different content minted the same locator %q", other)
			}
			if segments[0].Class != domain.TextClassProse {
				t.Errorf("class = %q, want %q", segments[0].Class, domain.TextClassProse)
			}
		})
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

// fakeSmartImage stands in for the real smart-image processor so prose's image-embed
// DELEGATION can be tested without a real AssetService: it reports the src + served
// markdown the real one would produce. The actual saveSVG is smart-image's concern.
type fakeSmartImage struct {
	block.FencedSerializer
	block.FencedDeserializer
}

func (f *fakeSmartImage) Kind() string          { return "smart-image" }
func (f *fakeSmartImage) Mode() block.BlockMode { return block.BlockModeBlock }
func (f *fakeSmartImage) InitAttrs(_ string, o map[string]interface{}) map[string]interface{} {
	return o
}
func (f *fakeSmartImage) IsSupportedContent(_ []block.ContentEntry) block.SupportedActions {
	return block.SupportedActions{Kind: "smart-image"}
}
func (f *fakeSmartImage) Transform(entries []block.ContentEntry, _ string, _ string, _ block.Action) map[string]interface{} {
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") {
			return map[string]interface{}{"src": "diagram-x.svg"}
		}
	}
	return nil
}
func (f *fakeSmartImage) MarkdownRepresentation(blk block.SieveBlock, uuid string) string {
	src, _ := blk.Attrs["src"].(string)
	if src == "" {
		return ""
	}
	return "![](/sieve/" + uuid + "/" + src + ")"
}
func (f *fakeSmartImage) BuildContext(_ block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	return block.AIContext{}
}
func (f *fakeSmartImage) DescribeJob(_ block.JobContext) *block.ProcessorJob {
	return nil
}
func (f *fakeSmartImage) OnChange(_ *block.SieveBlock) {}

// "Embed in Document" of a diagram: prose's resolveEntries renders the mermaid to an
// SVG and inserts an image/svg+xml entry. prose.Transform must embed THAT as served
// image markdown — delegating the asset-save AND the ![](url) to smart-image — not fall
// through to the diagram's mermaid-fence MarkdownRepresentation.
func TestProseProcessor_Transform_embedImageDelegatesToSmartImage(t *testing.T) {
	block.ResetRegistry()
	t.Cleanup(func() { block.RegisterProcessor(&ProseProcessor{}) })
	block.RegisterProcessor(&fakeSmartImage{FencedDeserializer: block.FencedDeserializer{Kind: "smart-image"}})
	var p ProseProcessor

	// Entries as prose's resolveEntries hands them: the diagram source text PLUS the
	// rendered SVG image entry it inserted.
	entries := []block.ContentEntry{
		{MIMEType: "sieve/diagram", Content: `{"diagramType":"mermaid","source":"graph TD;A-->B"}`},
		{MIMEType: "image/svg+xml", Content: "<svg>...</svg>"},
	}
	content, _ := p.Transform(entries, "uuid-1", "pr-1", block.ActionTransform)["content"].(string)
	if content != "![](/sieve/uuid-1/diagram-x.svg)" {
		t.Errorf("embed of an image source must produce served image markdown via smart-image, got %q", content)
	}
}
