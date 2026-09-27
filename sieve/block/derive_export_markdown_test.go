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

func (exportProseProc) Mode() BlockMode       { return BlockModeProse }
func (exportProseProc) Accepts(Region) bool   { return true }
func (exportProseProc) Shapes() []RegionShape { return nil }
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

// legacyExportProc carries an ExportMarkdown method whose output diverges from its
// MarkdownRepresentation — export must IGNORE it. There is no export-specific
// representation capability: a block has ONE markdown representation, and the only
// export policy hook is the caller's BlockFilter.
type legacyExportProc struct{ fakeProc }

func newLegacyExportProc() *legacyExportProc {
	return &legacyExportProc{fakeProc: *newFakeProc("exp-legacy")}
}

func (legacyExportProc) MarkdownRepresentation(b SieveBlock, _ string) string {
	return "THE-ONE-TRUE-REPRESENTATION"
}
func (legacyExportProc) ExportMarkdown(b SieveBlock, _ string) string {
	return "LEGACY-EXPORT-FORM-MUST-NOT-APPEAR"
}

// A processor exposing a legacy per-kind ExportMarkdown method gets no special
// treatment: export renders its MarkdownRepresentation like every other survivor.
func TestDeriveExportMarkdown_IgnoresLegacyExportRepresenter(t *testing.T) {
	RegisterProcessor(newLegacyExportProc())
	defer UnregisterProcessor("exp-legacy")

	codec := NewDocumentCodec(GlobalRegistry())
	doc := DocView{codec: codec, Blocks: []SieveBlock{
		{ID: "lg-1", Kind: "exp-legacy", Attrs: map[string]interface{}{}},
	}}

	got := doc.deriveExport(nil, MarkdownGenerator{})

	if !strings.Contains(got, "THE-ONE-TRUE-REPRESENTATION") {
		t.Fatalf("export must render MarkdownRepresentation, got %q", got)
	}
	if strings.Contains(got, "LEGACY-EXPORT-FORM-MUST-NOT-APPEAR") {
		t.Fatalf("export must ignore a processor's legacy ExportMarkdown method, got %q", got)
	}
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
	doc := DocView{Blocks: blocks, codec: codec}

	got := doc.deriveExport(dropKind("exp-ai"), MarkdownGenerator{})

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
	doc := DocView{rawAuthoritative: true, mdModeBuffer: raw, codec: codec}

	got := doc.deriveExport(nil, MarkdownGenerator{})

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

// exportSourceProc stands in for a sourced kind (code, log, diagram): its
// MarkdownRepresentation is non-empty exactly when the block has a source.
type exportSourceProc struct{ fakeProc }

func (exportSourceProc) MarkdownRepresentation(b SieveBlock, _ string) string {
	src, _ := b.Attrs["source"].(string)
	return src
}

// The Confluence generator on the export walk: each surviving block, one row per
// kind of the generator's kind switch, becomes its wiki markup; the filter and
// the empty-render skip apply exactly as for markdown.
func TestDeriveExport_Confluence(t *testing.T) {
	RegisterProcessor(newExportProseProc())
	defer UnregisterProcessor("exp-prose")
	for _, kind := range []string{"code", "log", "diagram"} {
		RegisterProcessor(&exportSourceProc{fakeProc: *newFakeProc(kind)})
		defer UnregisterProcessor(kind)
	}
	codec := NewDocumentCodec(GlobalRegistry())

	cases := []struct {
		name   string
		filter BlockFilter
		blocks []SieveBlock
		want   string
	}{
		{"code names its mapped language", nil, []SieveBlock{
			{Kind: "code", Attrs: map[string]interface{}{"language": "sh", "source": "ls"}},
		}, "{code:language=shell}\nls\n{code}"},
		{"code in an unlisted language", nil, []SieveBlock{
			{Kind: "code", Attrs: map[string]interface{}{"language": "cobolish", "source": "x"}},
		}, "{code}\nx\n{code}"},
		{"log", nil, []SieveBlock{
			{Kind: "log", Attrs: map[string]interface{}{"source": "ERROR x"}},
		}, "{code}\nERROR x\n{code}"},
		{"plantuml diagram", nil, []SieveBlock{
			{Kind: "diagram", Attrs: map[string]interface{}{"diagramType": "plantuml", "source": "A -> B"}},
		}, "{plantuml}\nA -> B\n{plantuml}"},
		{"mermaid diagram", nil, []SieveBlock{
			{Kind: "diagram", Attrs: map[string]interface{}{"diagramType": "mermaid", "source": "graph LR"}},
		}, "{code}\ngraph LR\n{code}"},
		{"prose is transpiled", nil, []SieveBlock{
			{Kind: "exp-prose", Attrs: map[string]interface{}{"content": "**Hello** [x](https://x.example)"}},
		}, "*Hello* [x|https://x.example]"},
		{"filtered and empty blocks are skipped", dropKind("log"), []SieveBlock{
			{Kind: "exp-prose", Attrs: map[string]interface{}{"content": "kept"}},
			{Kind: "log", Attrs: map[string]interface{}{"source": "dropped by the filter"}},
			{Kind: "code", Attrs: map[string]interface{}{"language": "go", "source": ""}},
			{Kind: "diagram", Attrs: map[string]interface{}{"diagramType": "plantuml", "source": "A -> B"}},
		}, "kept\n\n{plantuml}\nA -> B\n{plantuml}"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := DocView{Blocks: tc.blocks, codec: codec}
			if got := doc.deriveExport(tc.filter, NewConfluenceGenerator()); got != tc.want {
				t.Errorf("got\n%s\nwant\n%s", got, tc.want)
			}
		})
	}
}
