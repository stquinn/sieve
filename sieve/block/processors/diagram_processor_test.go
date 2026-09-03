package processors

import (
	"context"
	"errors"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"strings"
	"testing"
	"time"
)

func TestDiagramProcessor_InitAttrs_defaults(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	attrs := p.InitAttrs("di-a1b2", nil)

	if attrs["id"] != "di-a1b2" {
		t.Errorf("id: got %v, want di-a1b2", attrs["id"])
	}
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
	if attrs["diagramType"] != "mermaid" {
		t.Errorf("diagramType: got %v, want mermaid", attrs["diagramType"])
	}
	// empty source → edit mode
	if attrs["mode"] != "edit" {
		t.Errorf("mode with empty source: got %v, want edit", attrs["mode"])
	}
	if attrs["supportsEmbedding"] != true {
		t.Errorf("supportsEmbedding: got %v, want true", attrs["supportsEmbedding"])
	}
	if attrs["createdAt"] == nil || attrs["createdAt"] == "" {
		t.Error("createdAt must be set")
	}
	for _, field := range []string{"source", "diagramType", "mode", "supportsEmbedding", "createdAt"} {
		if _, ok := attrs[field]; !ok {
			t.Errorf("InitAttrs must declare field %q", field)
		}
	}
}

func TestDiagramProcessor_InitAttrs_withSourceSetsRenderMode(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	attrs := p.InitAttrs("di-a1b2", map[string]interface{}{"source": "graph TD\n  A-->B"})
	if attrs["mode"] != "render" {
		t.Errorf("mode with source: got %v, want render", attrs["mode"])
	}
	if attrs["status"] != block.BlockStatusComplete {
		t.Errorf("status: got %v, want COMPLETE", attrs["status"])
	}
}

func TestDiagramProcessor_InitAttrs_idNotOverridable(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	attrs := p.InitAttrs("di-0001", map[string]interface{}{"id": "injected"})
	if attrs["id"] != "di-0001" {
		t.Error("id must not be overridable via overrides")
	}
}

func TestDiagramProcessor_Mode(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if p.Mode() != block.BlockModeBlock {
		t.Errorf("Mode: got %v, want block", p.Mode())
	}
}

func TestDiagramProcessor_IsBlock_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	if !p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}).Has(block.ActionPaste) {
		t.Fatal("IsSupportedContent must offer paste for a mermaid fenced block")
	}
}

func TestDiagramProcessor_Transform_mermaidFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	src := "graph TD\n  A[Start] --> B[End]"
	content := "```mermaid\n" + src + "\n```"
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: content}}, "", "", block.ActionPaste)
	if overrides == nil {
		t.Fatal("Transform must return non-nil for a mermaid fenced block")
	}
	if overrides["source"] != src {
		t.Errorf("source: got %v, want %q", overrides["source"], src)
	}
	// mode is not set by Transform — InitAttrs derives it from source presence
}

func TestDiagramProcessor_IsBlock_otherFence(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nfunc main() {}\n```"}}).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for non-mermaid fenced block")
	}
}

func TestDiagramProcessor_IsBlock_plainText(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello world"}}).Has(block.ActionPaste) {
		t.Error("IsSupportedContent must not offer paste for plain text")
	}
}

func TestDiagramProcessor_Transform_notIsBlock(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	overrides := p.Transform([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello world"}}, "", "", block.ActionPaste)
	if overrides != nil {
		t.Error("Transform must return nil when IsSupportedContent offers no paste")
	}
}

func TestDiagramProcessor_BuildContext_withSource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{
		ID:    "di-0001",
		Kind:  "diagram",
		Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"},
	}
	ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{})
	if ctx.IsEmpty() {
		t.Error("BuildContext must return non-empty string when source is set")
	}
	if !strings.Contains(ctx.String(), "```mermaid") {
		t.Error("BuildContext must include mermaid fence")
	}
	if !strings.Contains(ctx.String(), "di-0001") {
		t.Error("BuildContext must include NODE ID")
	}
}

func TestDiagramProcessor_BuildContext_emptySource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{ID: "di-0001", Kind: "diagram", Attrs: map[string]interface{}{"source": ""}}
	if ctx := p.BuildContext(blk, block.DocView{}, map[string]bool{}); !ctx.IsEmpty() {
		t.Errorf("BuildContext must return empty for empty source; got %q", ctx)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_withSource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"source": "graph TD\n  A-->B"}}
	got := p.MarkdownRepresentation(blk, "")
	want := "```mermaid\ngraph TD\n  A-->B\n```"
	if got != want {
		t.Errorf("MarkdownRepresentation: got %q, want %q", got, want)
	}
}

func TestDiagramProcessor_MarkdownRepresentation_emptySource(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"source": ""}}
	if got := p.MarkdownRepresentation(blk, ""); got != "" {
		t.Errorf("MarkdownRepresentation must return empty string for empty source; got %q", got)
	}
}

func TestDiagramProcessor_DescribeJob_noJob(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := &block.SieveBlock{
		ID:   "di-0001",
		Kind: "diagram",
		Attrs: map[string]interface{}{
			"status":    block.BlockStatusComplete,
			"createdAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	// A diagram has no async work: it renders client-side and is born COMPLETE by
	// InitAttrs, so DescribeJob returns nil (never dispatched, never submitted).
	if job := p.DescribeJob(block.JobContext{Ctx: context.Background(), UUID: "test", Block: blk}); job != nil {
		t.Errorf("diagram must return a nil job, got %+v", job)
	}
}

// What a diagram projects into the text substrate. Its script is CODE, so a
// reader that only reads prose leaves it alone; a title, when the block carries
// one, is a label beside it. Both are the stored bytes; the locator is minted
// (mintLocator), not the bare slot name — see
// TestDiagramProcessor_NormalisedTextLocatorIsMintedNotBare — so this table
// asserts Text and Class only.
func TestDiagramProcessor_NormalisedText(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	const source = "graph TD\n  A[recieve] --> B[teh end]\n"

	cases := []struct {
		name  string
		attrs map[string]interface{}
		want  []domain.TextSegment
	}{
		{
			name:  "the script alone",
			attrs: map[string]interface{}{"source": source},
			want:  []domain.TextSegment{{Text: source, Class: domain.TextClassCode}},
		},
		{
			name:  "a titled diagram adds the label",
			attrs: map[string]interface{}{"source": source, "title": "Recieving pipeline"},
			want: []domain.TextSegment{
				{Text: source, Class: domain.TextClassCode},
				{Text: "Recieving pipeline", Class: domain.TextClassLabel},
			},
		},
		{
			name:  "an empty title is no segment, not an empty one",
			attrs: map[string]interface{}{"source": source, "title": ""},
			want:  []domain.TextSegment{{Text: source, Class: domain.TextClassCode}},
		},
		{
			name:  "a sourceless diagram still bears its one segment",
			attrs: map[string]interface{}{},
			want:  []domain.TextSegment{{Text: "", Class: domain.TextClassCode}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			blk := block.SieveBlock{Kind: "diagram", Attrs: tc.attrs}
			got := p.NormalisedText(&blk)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d segments, want %d: %#v", len(got), len(tc.want), got)
			}
			for i := range got {
				if got[i].Text != tc.want[i].Text || got[i].Class != tc.want[i].Class {
					t.Errorf("segment %d = %#v, want text %q class %q", i, got[i], tc.want[i].Text, tc.want[i].Class)
				}
				if got[i].Locator == "" {
					t.Errorf("segment %d has no locator", i)
				}
			}
		})
	}
}

// The locator is minted from the slot AND the bytes read out of it, exactly
// as prose's and code's are (prose_processor_test.go, code_processor_test.go):
// it is never the bare slot name, source and title never share one, and
// different content mints a different one.
func TestDiagramProcessor_NormalisedTextLocatorIsMintedNotBare(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	blk := block.SieveBlock{Kind: "diagram", Attrs: map[string]interface{}{"source": "a", "title": "t"}}
	segs := p.NormalisedText(&blk)
	if segs[0].Locator == DiagramSourceLocator || segs[1].Locator == DiagramTitleLocator {
		t.Errorf("locator must not be the bare slot name: %q, %q", segs[0].Locator, segs[1].Locator)
	}
	if segs[0].Locator == segs[1].Locator {
		t.Errorf("source and title minted the same locator %q", segs[0].Locator)
	}
	other := block.SieveBlock{Kind: "diagram", Attrs: map[string]interface{}{"source": "b", "title": "t"}}
	if p.NormalisedText(&other)[0].Locator == segs[0].Locator {
		t.Error("different source content minted the same locator")
	}
}

// diagramBlockFrom builds a diagram over exactly the two slots UpdateText can
// write: source, and title when non-empty.
func diagramBlockFrom(source, title string) block.SieveBlock {
	attrs := map[string]interface{}{"source": source}
	if title != "" {
		attrs["title"] = title
	}
	return block.SieveBlock{Kind: "diagram", ID: "di-1", Attrs: attrs}
}

// diagramAnchoredEdit mints an anchor the way the substrate does — read
// slot's current text, mint its locator, name a quote at an occurrence in
// that reading.
func diagramAnchoredEdit(t *testing.T, source, title, slot, quote string, occurrence int, grain, replacement string) domain.TextEdit {
	t.Helper()
	p := NewDiagramProcessor(block.BlockServices{})
	text := source
	if slot == DiagramTitleLocator {
		text = title
	}
	return domain.TextEdit{
		BlockID: "di-1", Locator: p.mintLocator(slot, text), Quote: quote, Occurrence: occurrence,
		Grain: grain, Replacement: replacement,
	}
}

// diagramSpend applies edits to a fresh block built from source/title and
// reports what the block now holds.
func diagramSpend(t *testing.T, source, title string, edits ...domain.TextEdit) (block.SieveBlock, error) {
	t.Helper()
	p := NewDiagramProcessor(block.BlockServices{})
	blk := diagramBlockFrom(source, title)
	err := p.UpdateText(&blk, edits)
	return blk, err
}

// A diagram has no parse, so a resolved run addresses the stored slot bytes
// directly — a splice, not a map back through markup. Both grains land on
// those same bytes, and a title slot splices independently of the script.
func TestDiagramProcessor_UpdateTextSplicesTheNamedSlot(t *testing.T) {
	cases := []struct {
		name                  string
		slot                  string
		source, title         string
		quote                 string
		occurrence            int
		grain, replacement    string
		wantSource, wantTitle string
	}{
		{
			name: "word grain replaces a whole word run in the script",
			slot: DiagramSourceLocator, source: "graph TD\n  A[recieve] --> B",
			quote: "recieve", occurrence: 0, grain: domain.GrainWord, replacement: "receive",
			wantSource: "graph TD\n  A[receive] --> B",
		},
		{
			name: "literal grain replaces a non-word-aligned run",
			slot: DiagramSourceLocator, source: "aaaa",
			quote: "aa", occurrence: 1, grain: domain.GrainLiteral, replacement: "B",
			wantSource: "aaB",
		},
		{
			name: "a title slot splices independently of the script",
			slot: DiagramTitleLocator, source: "x", title: "Recieving pipeline",
			quote: "Recieving", occurrence: 0, grain: domain.GrainWord, replacement: "Receiving",
			wantSource: "x", wantTitle: "Receiving pipeline",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			edit := diagramAnchoredEdit(t, tc.source, tc.title, tc.slot, tc.quote, tc.occurrence, tc.grain, tc.replacement)
			got, err := diagramSpend(t, tc.source, tc.title, edit)
			if err != nil {
				t.Fatalf("UpdateText: %v", err)
			}
			if s, _ := got.Attrs["source"].(string); s != tc.wantSource {
				t.Errorf("source = %q, want %q", s, tc.wantSource)
			}
			if title, _ := got.Attrs["title"].(string); tc.wantTitle != "" && title != tc.wantTitle {
				t.Errorf("title = %q, want %q", title, tc.wantTitle)
			}
		})
	}
}

// A batch is resolved against every named slot's CURRENT text and only then
// spliced, back to front within a slot — so two edits made at the same
// moment both land where they were read, and one edit's failure leaves every
// slot (not just its own) untouched.
func TestDiagramProcessor_UpdateTextBatchIsAllOrNothingAndBackToFront(t *testing.T) {
	const source = "teh cat sat on teh mat"
	first := diagramAnchoredEdit(t, source, "", DiagramSourceLocator, "teh", 0, domain.GrainWord, "the")
	second := diagramAnchoredEdit(t, source, "", DiagramSourceLocator, "teh", 1, domain.GrainWord, "THE")

	got, err := diagramSpend(t, source, "", first, second)
	if err != nil {
		t.Fatalf("UpdateText: %v", err)
	}
	if want := "the cat sat on THE mat"; got.Attrs["source"] != want {
		t.Errorf("source = %q, want %q", got.Attrs["source"], want)
	}

	stale := diagramAnchoredEdit(t, source, "", DiagramSourceLocator, "wolrd", 0, domain.GrainWord, "world")
	got2, err := diagramSpend(t, source, "", first, stale)
	if !errors.Is(err, block.ErrTextStale) {
		t.Fatalf("err = %v, want ErrTextStale", err)
	}
	if s, _ := got2.Attrs["source"].(string); s != source {
		t.Errorf("a failed batch must leave source untouched: %q", s)
	}
}

// What UpdateText refuses as STALE (the payload moved on) versus MALFORMED
// (no text could ever make the request resolve) — mirroring
// code_processor_test.go's TestCodeBlockProcessor_UpdateTextStaleAndMalformed
// for a diagram's slotted, parse-free shape.
func TestDiagramProcessor_UpdateTextStaleAndMalformed(t *testing.T) {
	const source = "teh cat"
	edit := diagramAnchoredEdit(t, source, "", DiagramSourceLocator, "teh", 0, domain.GrainWord, "the")

	t.Run("the payload moved on since the anchor was read", func(t *testing.T) {
		const changed = "the cat, already fixed"
		got, err := diagramSpend(t, changed, "", edit)
		if !errors.Is(err, block.ErrTextStale) {
			t.Errorf("err = %v, want ErrTextStale", err)
		}
		if s, _ := got.Attrs["source"].(string); s != changed {
			t.Errorf("content changed: %q", s)
		}
	})

	cases := []struct {
		name string
		edit domain.TextEdit
	}{
		{
			name: "a locator naming only the slot",
			edit: domain.TextEdit{Locator: DiagramSourceLocator, Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "no locator at all",
			edit: domain.TextEdit{Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "a locator naming a slot this diagram does not bear",
			edit: domain.TextEdit{Locator: `{"slot":"nonsense","hash":"abc"}`, Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "the diagram's own locator, but the anchor declares no grain",
			edit: domain.TextEdit{Locator: edit.Locator, Quote: "teh", Replacement: "the"},
		},
		{
			name: "the diagram's own locator, but a grain nothing counts in",
			edit: domain.TextEdit{Locator: edit.Locator, Quote: "teh", Grain: "sentence", Replacement: "the"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := diagramSpend(t, source, "", tc.edit)
			if !errors.Is(err, block.ErrTextMalformed) {
				t.Errorf("err = %v, want ErrTextMalformed", err)
			}
			if errors.Is(err, block.ErrTextStale) {
				t.Error("a malformed request reported as stale")
			}
			if s, _ := got.Attrs["source"].(string); s != source {
				t.Errorf("content changed: %q", s)
			}
		})
	}
}

// A block with nothing to write to, and a batch with nothing to write.
func TestDiagramProcessor_UpdateTextNoBlockIsMalformedAndAnEmptyBatchIsANoOp(t *testing.T) {
	p := NewDiagramProcessor(block.BlockServices{})
	if err := p.UpdateText(nil, []domain.TextEdit{{Grain: domain.GrainWord}}); !errors.Is(err, block.ErrTextMalformed) {
		t.Errorf("err = %v, want ErrTextMalformed", err)
	}
	blk := diagramBlockFrom("untouched", "")
	if err := p.UpdateText(&blk, nil); err != nil {
		t.Errorf("an empty batch: %v", err)
	}
	if s, _ := blk.Attrs["source"].(string); s != "untouched" {
		t.Errorf("empty batch changed content: %q", s)
	}
}

// INNER-FENCE SAFETY: the write lands on the SCRIPT attr, never on the
// block's serialized YAML — so a replacement that itself contains a ```
// fence must round-trip through Serialize/Deserialize without tearing the
// block in two (the #52 defect diagram_roundtrip_test.go pins for ordinary
// content).
func TestDiagramProcessor_UpdateTextReplacementContainingAFenceRoundTrips(t *testing.T) {
	registerDiagram(t)
	p := NewDiagramProcessor(block.BlockServices{})
	const source = "flowchart TD\n  a[recieve] --> b\n"
	const fencedReplacement = "a label\n```\nnode[x]\n```\nend"

	blk := block.NewSieveBlock("diagram", "019ff758-7aaf-79b1-a2e3-4221af4bb71b", map[string]interface{}{
		"diagramType": "mermaid", "mode": "edit", "status": block.BlockStatusComplete, "source": source,
	})
	edit := diagramAnchoredEdit(t, source, "", DiagramSourceLocator, "recieve", 0, domain.GrainWord, fencedReplacement)
	if err := p.UpdateText(&blk, []domain.TextEdit{edit}); err != nil {
		t.Fatalf("UpdateText: %v", err)
	}
	updated, _ := blk.Attrs["source"].(string)
	if !strings.Contains(updated, fencedReplacement) {
		t.Fatalf("the edit itself did not land: %q", updated)
	}

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	md, err := codec.Serialize([]block.SieveBlock{blk})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	blocks, err := codec.Deserialize(md)
	if err != nil {
		t.Fatalf("deserialize: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("the inner fence split the document into %d blocks:\n%s", len(blocks), md)
	}
	if got, _ := blocks[0].Attrs["source"].(string); got != updated {
		t.Errorf("source did not round-trip:\n want %q\n  got %q", updated, got)
	}
}
