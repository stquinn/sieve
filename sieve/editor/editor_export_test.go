package editor

import (
	"flag"
	"fmt"
	"os"
	"regexp"
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

// An export writes an image's stored address, never the app URL the editor
// renders it through: Markdown as `sieve://` addresses — a smart-image's and one
// embedded in prose alike — and each Confluence edition as a `[image: name]`
// placeholder, since an attachment cannot travel on the clipboard.
func TestEditorService_Export_ImagesLeaveAsAddresses(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewSmartImageProcessor(block.BlockServices{}))
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	doc, _ := ds.New()
	uuid := doc.UUID()
	doc.SetBody([]byte("see ![](/ui/assets/" + uuid + "/inline.png)\n\n" +
		"```smart-image\nid: si-1\nsrc: sieve://" + uuid + "/chart.png\nalt: A chart\nstatus: COMPLETE\n```"))
	doc, _ = ds.Save(doc)
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer es.Close(uuid)

	for _, tc := range []struct {
		name      string
		generator block.ExportGenerator
		want      []string
	}{
		{"markdown", block.MarkdownGenerator{}, []string{
			"see ![](sieve://" + uuid + "/inline.png)", "![A chart](sieve://" + uuid + "/chart.png)"}},
		{"confluence", block.NewConfluenceGenerator(), []string{"<p>see [image: inline.png]</p>", "<p>[image: A chart]</p>"}},
		{"confluence cloud", block.NewConfluenceCloudGenerator(), []string{"<p>see [image: inline.png]</p>", "<p>[image: A chart]</p>"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := es.Export(uuid, nil, tc.generator)
			if err != nil {
				t.Fatalf("Export: %v", err)
			}
			for _, want := range tc.want {
				if !strings.Contains(got, want) {
					t.Errorf("export lacks %q:\n%s", want, got)
				}
			}
			for _, absent := range []string{"/ui/assets", "ac:image"} {
				if strings.Contains(got, absent) {
					t.Errorf("export carries %q:\n%s", absent, got)
				}
			}
		})
	}
}

var updateGolden = flag.Bool("update", false, "rewrite golden files from the current output")

// cloudLocalID matches a local id the Cloud generator minted, in either slot.
var cloudLocalID = regexp.MustCompile(`(key="local-id">)([0-9a-f-]{36})(<)`)

// numberLocalIDs replaces each distinct minted local id with local-1, local-2, …
// in the order they first appear, so a Cloud export compares against a golden.
func numberLocalIDs(storage string) string {
	seen := map[string]string{}
	return cloudLocalID.ReplaceAllStringFunc(storage, func(m string) string {
		parts := cloudLocalID.FindStringSubmatch(m)
		if _, ok := seen[parts[2]]; !ok {
			seen[parts[2]] = fmt.Sprintf("local-%d", len(seen)+1)
		}
		return parts[1] + seen[parts[2]] + parts[3]
	})
}

// The Confluence UAT document is the corpus: loaded through the real codec (its
// section 9 becomes code, log and diagram blocks; the rest is prose), exported
// through each edition's ConfluenceGenerator, it must match that edition's
// golden storage format exactly — so the text pasted at work is what the suite
// pins. Run with -update to rewrite the goldens.
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

	const corpus = "../block/testdata/confluence-uat.md"
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

	for _, edition := range []struct {
		generator *block.ConfluenceGenerator
		golden    string
	}{
		{block.NewConfluenceGenerator(), "../block/testdata/confluence-uat.storage"},
		{block.NewConfluenceCloudGenerator(), "../block/testdata/confluence-uat.cloud.storage"},
	} {
		got, err := es.Export(doc.UUID(), nil, edition.generator)
		if err != nil {
			t.Fatalf("Export: %v", err)
		}
		got = numberLocalIDs(got)
		if *updateGolden {
			if err := os.WriteFile(edition.golden, []byte(got), 0o644); err != nil {
				t.Fatalf("write golden: %v", err)
			}
		}
		want, err := os.ReadFile(edition.golden)
		if err != nil {
			t.Fatalf("read golden: %v", err)
		}
		if got != string(want) {
			t.Errorf("Confluence export drifted from %s:\n%s", edition.golden, got)
		}
	}
}
