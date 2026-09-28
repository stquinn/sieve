package editor

import (
	"flag"
	"os"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
)

// Export takes the CALLER's BlockFilter (a closure): the exclusion policy
// belongs to the call site (the export handler drops ai-blocks; another caller may
// not), NOT to EditorService — which only resolves the shadow and delegates. A nil
// filter exports everything; an unopened document is an error.
func TestEditorService_Export_CallerOwnsFilter(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	doc.SetBody([]byte("prose stays\n\n```code\nid: co-1\nlanguage: go\nsource: x := 1\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer es.Close(uuid)

	// Caller's closure drops code blocks.
	noCode, err := es.Export(uuid, func(b block.SieveBlock) bool { return b.Kind != "code" }, block.MarkdownGenerator{})
	if err != nil {
		t.Fatalf("Export(filter): %v", err)
	}
	if strings.Contains(noCode, "x := 1") {
		t.Errorf("filter must drop code blocks, got %q", noCode)
	}
	if !strings.Contains(noCode, "prose stays") {
		t.Errorf("filter must keep prose, got %q", noCode)
	}

	// Nil filter exports everything.
	all, err := es.Export(uuid, nil, block.MarkdownGenerator{})
	if err != nil {
		t.Fatalf("Export(nil): %v", err)
	}
	if !strings.Contains(all, "x := 1") || !strings.Contains(all, "prose stays") {
		t.Errorf("nil filter must export every block, got %q", all)
	}

	// Unopened document is an error.
	if _, err := es.Export("no-such-doc", nil, block.MarkdownGenerator{}); err == nil {
		t.Error("Export must error for a document that is not open")
	}
}

var updateGolden = flag.Bool("update", false, "rewrite golden files from the current output")

// The Confluence UAT document is the corpus: loaded through the real codec (its
// section 9 becomes code, log and diagram blocks; the rest is prose), exported
// through ConfluenceGenerator, it must match its golden storage format exactly —
// so the text pasted at work is what the suite pins. Run with -update to rewrite
// the golden.
func TestEditorService_Export_ConfluenceUATCorpus(t *testing.T) {
	resetRegistry()
	for _, p := range []block.BlockProcessor{
		processors.NewCodeBlockProcessor(block.BlockServices{}),
		processors.NewLogProcessor(block.BlockServices{}),
		processors.NewDiagramProcessor(block.BlockServices{}),
	} {
		block.RegisterProcessor(p)
	}
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	const corpus, golden = "../block/testdata/confluence-uat.md", "../block/testdata/confluence-uat.storage"
	raw, err := os.ReadFile(corpus)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	doc, _ := ds.New()
	doc.SetBody(raw)
	doc, _ = ds.Save(doc)
	if err := es.Open(doc.UUID()); err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer es.Close(doc.UUID())

	var kinds []string
	for _, b := range es.shadows[doc.UUID()].SnapshotBlocks() {
		kinds = append(kinds, b.Kind)
	}
	if want := "prose code log diagram diagram prose"; strings.Join(kinds, " ") != want {
		t.Fatalf("corpus deserialized as %v, want %s", kinds, want)
	}

	got, err := es.Export(doc.UUID(), nil, block.NewConfluenceGenerator())
	if err != nil {
		t.Fatalf("Export: %v", err)
	}
	if *updateGolden {
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if got != string(want) {
		t.Errorf("Confluence export drifted from %s:\n%s", golden, got)
	}
}
