package requesthandlers

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// End-to-end over the REAL export route: /api/editor/export serves CLEAN markdown —
// the handler's own closure drops ai-blocks (prior Q&A is conversation, not document
// content), survivors render via MarkdownRepresentation (clean ```lang fence, no
// on-disk YAML, no prose sentinels, no frontmatter).
func TestEditorExportRoute_DropsAIBlocksServesCleanMarkdown(t *testing.T) {
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{}))

	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	es := editor.NewEditorService(ds, codec, 0)
	sp := &sieve.ServiceProvider{Documents: ds, Editor: es}

	h := &EditorHandler{ServiceProvider: sp}
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	t.Cleanup(es.CloseAll)

	const priorAnswer = "PRIOR-ANSWER-must-not-export"
	body, err := codec.Serialize([]block.SieveBlock{
		block.NewSieveBlock(block.KindProse, "pr-1", map[string]interface{}{"content": "user prose stays"}),
		block.NewSieveBlock("code", "co-1", map[string]interface{}{
			"id": "co-1", "language": "go", "source": "x := 1", "status": block.BlockStatusComplete,
		}),
		block.NewSieveBlock("ai-block", "ab-1", map[string]interface{}{
			"id": "ab-1", "ref": "doc", "type": "ASK", "status": block.BlockStatusComplete,
			"question": "what is x?", "response": priorAnswer,
		}),
	})
	if err != nil {
		t.Fatalf("seed serialize: %v", err)
	}
	doc, _ := ds.New()
	doc.SetBody([]byte(body))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid, nil); err != nil {
		t.Fatalf("Open: %v", err)
	}

	resp, err := http.Get(srv.URL + "/api/editor/export?uuid=" + uuid)
	if err != nil {
		t.Fatalf("GET export: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	got, _ := io.ReadAll(resp.Body)
	md := string(got)

	if strings.Contains(md, priorAnswer) || strings.Contains(md, "what is x?") {
		t.Errorf("export leaked the ai-block, got %q", md)
	}
	if !strings.Contains(md, "user prose stays") {
		t.Errorf("export lost prose, got %q", md)
	}
	if !strings.Contains(md, "x := 1") {
		t.Errorf("export lost code source, got %q", md)
	}
	if strings.Contains(md, "```code") || strings.Contains(md, "source:") {
		t.Errorf("export leaked on-disk YAML fence form, got %q", md)
	}
	if strings.Contains(md, "<!--s:") {
		t.Errorf("export leaked prose sentinels, got %q", md)
	}

	// Unknown format is rejected, not silently served.
	badResp, err := http.Get(srv.URL + "/api/editor/export?uuid=" + uuid + "&format=pdf")
	if err != nil {
		t.Fatalf("GET export bad format: %v", err)
	}
	badResp.Body.Close()
	if badResp.StatusCode != http.StatusBadRequest {
		t.Errorf("unknown format must 400, got %d", badResp.StatusCode)
	}
}
