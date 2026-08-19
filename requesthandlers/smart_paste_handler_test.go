package requesthandlers

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// fakePreview stands in for the network on the paste path — a committed test never
// makes a real request.
type fakePreview struct{ title string }

func (f fakePreview) FetchTitle(string, time.Duration) string { return f.title }
func (f fakePreview) FetchFull(string) domain.LinkPreviewResult {
	return domain.LinkPreviewResult{}
}

// End-to-end over the REAL /api/editor/smart-paste route: the response is the paste
// RESULT UNION — a discriminated "what happened", not "did some kind match". These
// bytes are the frontend's contract.
func TestSmartPasteRoute_ResultUnion(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	es := editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetServices(block.BlockServices{LinkPreview: fakePreview{title: "Example Domain"}})
	t.Cleanup(es.CloseAll)

	h := &EditorHandler{ServiceProvider: &sieve.ServiceProvider{Documents: ds, Editor: es}}
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	doc, _ := ds.New()
	doc, _ = ds.Save(doc)
	if err := es.Open(doc.UUID(), nil); err != nil {
		t.Fatalf("Open: %v", err)
	}

	post := func(t *testing.T, entriesJSON string) map[string]string {
		t.Helper()
		body := `{"uuid":"` + doc.UUID() + `","index":0,"entries":` + entriesJSON + `}`
		resp, err := http.Post(srv.URL+"/api/editor/smart-paste", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST smart-paste: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("status %d", resp.StatusCode)
		}
		var got map[string]string
		if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return got
	}

	t.Run("URL becomes content", func(t *testing.T) {
		got := post(t, `[{"mimeType":"text/plain","content":"https://example.com"}]`)
		if got["outcome"] != "content" {
			t.Fatalf("outcome: got %q, want content (%v)", got["outcome"], got)
		}
		if want := `<a href="https://example.com">Example Domain</a>`; got["html"] != want {
			t.Errorf("html: got %q, want %q", got["html"], want)
		}
		if got["id"] != "" || got["kind"] != "" {
			t.Errorf("content result must carry no block identity: %v", got)
		}
	})

	t.Run("claimed content becomes a block", func(t *testing.T) {
		got := post(t, `[{"mimeType":"text/plain","content":"`+"```"+`go\nx := 1\n`+"```"+`"}]`)
		if got["outcome"] != "block" {
			t.Fatalf("outcome: got %q, want block (%v)", got["outcome"], got)
		}
		if got["kind"] != "code" {
			t.Errorf("kind: got %q, want code", got["kind"])
		}
		if got["id"] == "" || got["rawYaml"] == "" {
			t.Errorf("block result must carry id and rawYaml: %v", got)
		}
		if got["html"] != "" {
			t.Errorf("block result must carry no content fragment: %v", got)
		}
	})

	// #38: a DROPPED FILE takes the same route a paste does — the surface reads it
	// as a data URI, stamps the filename in the entry's context, and the registry
	// routes it. This exercises the whole creation path end to end, over the real
	// bytes the frontend sends.
	t.Run("a dropped file becomes an attachment", func(t *testing.T) {
		block.RegisterProcessor(processors.NewAttachmentProcessor(block.BlockServices{
			Documents: ds, Assets: services.NewAssetService(fs),
		}))
		t.Cleanup(func() { block.UnregisterProcessor("attachment") })

		payload := base64.StdEncoding.EncodeToString([]byte("openapi: 3.0.0\n"))
		got := post(t, `[{"mimeType":"text/yaml","content":"data:text/yaml;base64,`+payload+`","context":{"filename":"swagger.yml"}}]`)
		if got["outcome"] != "block" {
			t.Fatalf("outcome: got %q, want block (%v)", got["outcome"], got)
		}
		if got["kind"] != "attachment" {
			t.Errorf("kind: got %q, want attachment", got["kind"])
		}
		// The chip's label rides in the serialized block, so the drop is only
		// complete if the original filename survived the whole round trip.
		if !strings.Contains(got["rawYaml"], "swagger.yml") {
			t.Errorf("rawYaml must carry the dropped filename as the title: %q", got["rawYaml"])
		}
	})

	t.Run("unclaimed text is nothing", func(t *testing.T) {
		got := post(t, `[{"mimeType":"text/plain","content":"just plain text"}]`)
		if got["outcome"] != "none" {
			t.Fatalf("outcome: got %q, want none (%v)", got["outcome"], got)
		}
		if len(got) != 1 {
			t.Errorf("the nothing result must carry nothing else: %v", got)
		}
	})
}
