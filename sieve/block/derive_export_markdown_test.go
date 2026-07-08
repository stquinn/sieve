package block

import (
	"strings"
	"testing"
)

// exportCodeProc is a fenced fake whose MarkdownRepresentation is a clean ```lang
// fence while its inherited Serialize is the on-disk YAML fence — the split lets a
// test prove clean export renders via MarkdownRepresentation, NOT Serialize.
type exportCodeProc struct{ fakeProc }

func newExportCodeProc() *exportCodeProc { return &exportCodeProc{fakeProc: *newFakeProc("exp-code")} }

func (exportCodeProc) MarkdownRepresentation(b SieveBlock, _ string) string {
	lang, _ := b.Attrs["lang"].(string)
	src, _ := b.Attrs["source"].(string)
	return "```" + lang + "\n" + src + "\n```"
}

// exportProseProc is a terminal prose fake: MarkdownRepresentation is content
// verbatim, but Serialize wraps it in a <!--s:ID--> sentinel — so export (which uses
// MarkdownRepresentation) must NOT show the sentinel, while Serialize would.
type exportProseProc struct{ fakeProc }

func newExportProseProc() *exportProseProc {
	return &exportProseProc{fakeProc: *newFakeProc("exp-prose")}
}

func (exportProseProc) Mode() BlockMode     { return BlockModeProse }
func (exportProseProc) Accepts(Region) bool { return true }
func (exportProseProc) Shape() RegionShape  { return RegionShape{} }
func (exportProseProc) Deserialize(r Region) ([]SieveBlock, error) {
	return []SieveBlock{NewSieveBlock("exp-prose", "", map[string]interface{}{"content": r.Raw})}, nil
}
func (exportProseProc) Serialize(b SieveBlock) (string, error) {
	return "<!--s:" + b.ID + "-->\n" + b.Content() + "\n<!--/s:" + b.ID + "-->", nil
}
func (exportProseProc) MarkdownRepresentation(b SieveBlock, _ string) string { return b.Content() }

// exportAIProc is an ai-block-shaped fake whose MarkdownRepresentation would render
// a recognisable Q&A — so a test can prove the filter removed it.
type exportAIProc struct{ fakeProc }

func newExportAIProc() *exportAIProc { return &exportAIProc{fakeProc: *newFakeProc("exp-ai")} }

func (exportAIProc) MarkdownRepresentation(b SieveBlock, _ string) string {
	q, _ := b.Attrs["question"].(string)
	r, _ := b.Attrs["response"].(string)
	return "### " + q + "\n\n" + r
}

// Clean export filters ai-blocks OUT, then renders each survivor via its
// MarkdownRepresentation (not the on-disk Serialize): prose keeps no sentinel, code
// is a plain ```lang fence, and the ai-block is gone.
func TestDeriveExportMarkdown_FiltersAIBlockAndUsesMarkdownRep(t *testing.T) {
	RegisterProcessor(newExportProseProc())
	RegisterProcessor(newExportCodeProc())
	RegisterProcessor(newExportAIProc())
	defer UnregisterProcessor("exp-prose")
	defer UnregisterProcessor("exp-code")
	defer UnregisterProcessor("exp-ai")

	codec := NewDocumentCodec(GlobalRegistry())
	blocks := []SieveBlock{
		{ID: "pr-1", Kind: "exp-prose", Attrs: map[string]interface{}{"content": "Hello ==world=="}},
		{ID: "co-1", Kind: "exp-code", Attrs: map[string]interface{}{"id": "co-1", "lang": "go", "source": "x := 1"}},
		{ID: "ab-1", Kind: "exp-ai", Attrs: map[string]interface{}{"id": "ab-1", "question": "what is x?", "response": "stale answer"}},
	}
	doc := DocView{Mode: "wysiwyg", Blocks: blocks, codec: codec}

	got := doc.deriveExportMarkdown(acceptAllBut{drop: "exp-ai"})

	// ai-block filtered out entirely.
	if strings.Contains(got, "stale answer") || strings.Contains(got, "what is x?") {
		t.Fatalf("export must drop the ai-block, got %q", got)
	}
	// prose rendered verbatim, WITHOUT the <!--s:--> sentinel Serialize adds.
	if !strings.Contains(got, "Hello ==world==") {
		t.Fatalf("export lost prose content, got %q", got)
	}
	if strings.Contains(got, "<!--s:") {
		t.Fatalf("export must strip prose sentinels (MarkdownRepresentation, not Serialize), got %q", got)
	}
	// code as a clean ```lang fence, NOT the on-disk ```exp-code YAML fence.
	if !strings.Contains(got, "```go\nx := 1\n```") {
		t.Fatalf("export must render code as a clean ```lang fence, got %q", got)
	}
	if strings.Contains(got, "```exp-code") || strings.Contains(got, "source:") {
		t.Fatalf("export must not use the on-disk Serialize form, got %q", got)
	}
	// And the whole export must differ from the on-disk whole-doc serialize.
	if onDisk, _ := codec.Serialize(blocks); got == onDisk {
		t.Fatalf("export must differ from on-disk Serialize, both were %q", got)
	}
}

// In markdown mode there is no live tree; unlike deriveMarkdownFiltered (which
// returns the raw buffer verbatim), clean export RE-PARSES the raw buffer through the
// codec and renders the resulting tree — so the on-disk YAML never leaks into export.
func TestDeriveExportMarkdown_MarkdownModeReparsesNotPassthrough(t *testing.T) {
	RegisterProcessor(newExportProseProc())
	RegisterProcessor(newExportCodeProc())
	defer UnregisterProcessor("exp-prose")
	defer UnregisterProcessor("exp-code")

	codec := NewDocumentCodec(GlobalRegistry())
	// The raw markdown-mode buffer holds the ON-DISK YAML fence form plus gap prose.
	raw := "intro para\n\n```exp-code\nlang: go\nsource: y := 2\n```"
	doc := DocView{Mode: "markdown", mdModeBuffer: raw, codec: codec}

	got := doc.deriveExportMarkdown(nil)

	if got == raw {
		t.Fatalf("markdown-mode export must re-parse, not return the raw buffer verbatim")
	}
	if strings.Contains(got, "source:") || strings.Contains(got, "```exp-code") {
		t.Fatalf("export must render the re-parsed tree, not the on-disk YAML, got %q", got)
	}
	if !strings.Contains(got, "```go\ny := 2\n```") {
		t.Fatalf("export must render re-parsed code as a clean fence, got %q", got)
	}
	if !strings.Contains(got, "intro para") {
		t.Fatalf("export must keep the prose gap text, got %q", got)
	}
}
