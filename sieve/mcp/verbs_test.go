package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store/filestore"
)


// newTestServer builds a Server over a real FileStore + DocumentService in a
// temp library, seeded with a few filed notes across folders.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	s, ds := newTestServerWithDocs(t)
	seedNote(t, ds, "Go Concurrency", "programming", "go-concurrency",
		[]string{"go", "concurrency"}, "goroutines and channels",
		"# Go Concurrency\n\nUse channels for coordination.")
	seedNote(t, ds, "Python Tips", "programming", "python-tips",
		[]string{"python"}, "list comprehensions",
		"# Python Tips\n\nComprehensions are neat.")
	seedNote(t, ds, "Grocery List", "", "grocery-list",
		[]string{"personal"}, "weekly shop",
		"# Grocery List\n\nmilk, eggs")
	return s
}

// newTestServerWithDocs is newTestServerWithStore for the tests that never
// reach past the document service.
func newTestServerWithDocs(t *testing.T) (*Server, *services.DocumentService) {
	t.Helper()
	s, ds, _ := newTestServerWithStore(t)
	return s, ds
}

// newTestServerWithStore builds an EMPTY library and wires the server exactly as
// the composition root does — the real editor.Router over the real notes source
// — so the address verb is exercised through the resolver it actually ships
// with, refusals and all, rather than a fake that could agree with itself. The
// store comes back for the tests that seed what only it can create: an asset.
func newTestServerWithStore(t *testing.T) (*Server, *services.DocumentService, *filestore.FileStore) {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	// Resolving a leaf parses the container's body, so the terminal prose
	// flavour has to be registered here as it is in production — without it the
	// codec has nothing to accept a region with and every body fails to parse.
	block.ResetRegistry()
	block.RegisterProcessor(&processors.ProseProcessor{})
	t.Cleanup(block.ResetRegistry)
	return NewServer(ds, editor.NewRouter(editor.NewNotesSource(ds))), ds, fs
}

// seedNote creates a buffer, stamps metadata, and files it into folder.
func seedNote(t *testing.T, ds *services.DocumentService, title, folder, filename string, tags []string, summary, body string) string {
	t.Helper()
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	m := doc.Meta()
	m.SetDisplayName(title)
	s := summary
	m.SetSummary(&s)
	m.SetTags(tags)
	fn := filename
	m.SetFilename(&fn)
	if folder != "" {
		f := folder
		m.SetAiFolderSuggestion(&f)
	}
	doc.SetBody([]byte(body))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save buffer: %v", err)
	}
	filed, err := ds.File(doc)
	if err != nil {
		t.Fatalf("File note %q: %v", title, err)
	}
	return filed.UUID()
}

func TestSearch_MatchesMetadataNeverBodies(t *testing.T) {
	s := newTestServer(t)

	// Title match.
	_, res, err := s.search(context.Background(), nil, SearchInput{Query: "concurrency"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.Results) != 1 || res.Results[0].Title != "Go Concurrency" {
		t.Fatalf("query 'concurrency' = %+v, want the Go note", res.Results)
	}
	hit := res.Results[0]
	if hit.Folder != "programming" {
		t.Errorf("folder = %q, want programming", hit.Folder)
	}
	if hit.Summary != "goroutines and channels" {
		t.Errorf("summary = %q", hit.Summary)
	}
	if len(hit.Tags) != 2 {
		t.Errorf("tags = %v, want 2", hit.Tags)
	}

	// Tag match (query text appears only in a tag).
	_, res, err = s.search(context.Background(), nil, SearchInput{Query: "python"})
	if err != nil {
		t.Fatalf("search python: %v", err)
	}
	if len(res.Results) != 1 || res.Results[0].Title != "Python Tips" {
		t.Fatalf("query 'python' = %+v", res.Results)
	}

	// Body-only text must NOT match — search is metadata-only.
	_, res, err = s.search(context.Background(), nil, SearchInput{Query: "coordination"})
	if err != nil {
		t.Fatalf("search coordination: %v", err)
	}
	if len(res.Results) != 0 {
		t.Errorf("body word 'coordination' matched %+v; search must be metadata-only", res.Results)
	}
}

func TestSearch_FolderFilterAndLimit(t *testing.T) {
	s := newTestServer(t)

	_, res, err := s.search(context.Background(), nil, SearchInput{Folder: "programming"})
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(res.Results) != 2 {
		t.Fatalf("folder=programming empty query = %d results, want 2", len(res.Results))
	}

	_, res, err = s.search(context.Background(), nil, SearchInput{Limit: 1})
	if err != nil {
		t.Fatalf("search limit: %v", err)
	}
	if len(res.Results) != 1 || !res.Truncated {
		t.Errorf("limit=1 = %d results truncated=%v, want 1 truncated", len(res.Results), res.Truncated)
	}
}

func TestGetMeta_NoBody(t *testing.T) {
	s := newTestServer(t)
	_, res, err := s.search(context.Background(), nil, SearchInput{Query: "grocery"})
	if err != nil || len(res.Results) != 1 {
		t.Fatalf("seed search: %v res=%+v", err, res)
	}
	uuid := res.Results[0].UUID

	_, meta, err := s.getMeta(context.Background(), nil, UUIDInput{UUID: uuid})
	if err != nil {
		t.Fatalf("get_meta: %v", err)
	}
	if meta.Title != "Grocery List" {
		t.Errorf("title = %q", meta.Title)
	}
	if meta.Folder != "" {
		t.Errorf("root note folder = %q, want empty", meta.Folder)
	}
	if meta.Version < 1 {
		t.Errorf("version = %d, want >=1", meta.Version)
	}
	if meta.Filename != "grocery-list" {
		t.Errorf("filename = %q", meta.Filename)
	}
}

func TestGetNote_ReturnsBody(t *testing.T) {
	s := newTestServer(t)
	_, res, err := s.search(context.Background(), nil, SearchInput{Query: "go"})
	if err != nil || len(res.Results) == 0 {
		t.Fatalf("seed search: %v", err)
	}
	uuid := res.Results[0].UUID

	_, note, err := s.getNote(context.Background(), nil, UUIDInput{UUID: uuid})
	if err != nil {
		t.Fatalf("get_note: %v", err)
	}
	if note.Meta.Title != "Go Concurrency" {
		t.Errorf("meta.title = %q", note.Meta.Title)
	}
	if note.Body == "" || !strings.Contains(note.Body, "channels") {
		t.Errorf("body = %q, want the markdown body", note.Body)
	}
}

// An id that loads no document — typically a block id or an asset key — is still
// an error, but one that points the model at the verb that reads those.
func TestByUUIDVerbs_PointAWrongIDAtGetByURI(t *testing.T) {
	s := newTestServer(t)
	const blockID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02"
	verbs := map[string]func() error{
		"get_note": func() error {
			_, _, err := s.getNote(context.Background(), nil, UUIDInput{UUID: blockID})
			return err
		},
		"get_meta": func() error {
			_, _, err := s.getMeta(context.Background(), nil, UUIDInput{UUID: blockID})
			return err
		},
	}
	for verb, call := range verbs {
		t.Run(verb, func(t *testing.T) {
			err := call()
			if err == nil {
				t.Fatal("an id that names no document must be an error")
			}
			for _, want := range []string{verb, blockID, "not a document", "get_by_uri", "sieve://"} {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("err = %q, want it to contain %q", err, want)
				}
			}
		})
	}
}

func TestListFacets_FoldersAndTags(t *testing.T) {
	s := newTestServer(t)
	_, facets, err := s.listFacets(context.Background(), nil, struct{}{})
	if err != nil {
		t.Fatalf("list_facets: %v", err)
	}

	var progCount int
	for _, f := range facets.Folders {
		if f.Name == "programming" {
			progCount = f.NoteCount
		}
	}
	if progCount != 2 {
		t.Errorf("programming note_count = %d, want 2; folders=%+v", progCount, facets.Folders)
	}

	tagCounts := map[string]int{}
	for _, tg := range facets.Tags {
		tagCounts[tg.Name] = tg.Count
	}
	if tagCounts["go"] != 1 || tagCounts["python"] != 1 || tagCounts["personal"] != 1 {
		t.Errorf("tag counts = %+v, want go/python/personal each 1", facets.Tags)
	}
}

func TestFetchPage_WritesMarkdownAssetAndReusesOnSecondCall(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write([]byte(`<!DOCTYPE html><html><head>
<title>Noisy Title | BBC Sport</title>
<meta property="og:title" content="Verstappen Wins in Suzuka"/>
</head><body>
<nav>Skip to content | Live scores</nav>
<article>
  <h1>Verstappen Wins in Suzuka</h1>
  <p>Max Verstappen controlled the Japanese Grand Prix from pole position, leading every lap after the restart to secure victory.</p>
</article>
<footer>BBC Terms of Use</footer>
</body></html>`))
	}))
	defer srv.Close()

	s, ds := newTestServerWithDocs(t)
	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	buf.SetBody([]byte("Initial notes.\n"))
	doc, err := ds.Save(buf)
	if err != nil {
		t.Fatalf("Save buffer: %v", err)
	}
	uuid := doc.UUID()

	ctx := WithDocument(context.Background(), uuid)
	pageURL := srv.URL + "/sport/formula1/articles/cmvg9z1v33keo"
	_, node, err := s.fetchPage(ctx, nil, FetchPageInput{URL: pageURL})
	if err != nil {
		t.Fatalf("fetch_page first call: %v", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("HTTP hits after first call = %d, want 1", hits.Load())
	}
	if node.Kind != "asset" {
		t.Errorf("Kind = %q, want asset", node.Kind)
	}
	if !strings.HasSuffix(node.ID, ".md") {
		t.Errorf("ID = %q, want .md asset filename", node.ID)
	}
	wantURI := domain.NewLeafAddress(uuid, node.ID).String()
	if node.URI != wantURI {
		t.Errorf("URI = %q, want %q", node.URI, wantURI)
	}
	if node.Title != "Verstappen Wins in Suzuka" {
		t.Errorf("Title = %q, want %q", node.Title, "Verstappen Wins in Suzuka")
	}
	wantPath := path.Join(doc.Storable().ExternalRef(), node.ID)
	if node.Path != wantPath {
		t.Errorf("Path = %q, want %q", node.Path, wantPath)
	}
	if node.Bytes == 0 {
		t.Error("Bytes = 0, want non-zero markdown asset size")
	}
	if node.Body != "" {
		t.Errorf("Body = %q, want empty (asset bytes live on disk at Path)", node.Body)
	}

	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	var savedBody string
	for _, owned := range reloaded.Storable().Owns() {
		if owned.Key() == node.ID {
			savedBody = string(owned.Body())
			break
		}
	}
	if savedBody == "" {
		t.Fatalf("asset %q not found in document %s owns", node.ID, uuid)
	}
	if !strings.Contains(savedBody, "# Verstappen Wins in Suzuka") || !strings.Contains(savedBody, "Max Verstappen controlled the Japanese Grand Prix") {
		t.Errorf("saved markdown missing article text:\n%s", savedBody)
	}
	if strings.Contains(savedBody, "Skip to content") || strings.Contains(savedBody, "<article>") {
		t.Errorf("saved markdown retained boilerplate or raw HTML:\n%s", savedBody)
	}

	// Second call for the same URL must reuse the existing asset without re-fetching.
	_, node2, err := s.fetchPage(ctx, nil, FetchPageInput{URL: pageURL})
	if err != nil {
		t.Fatalf("fetch_page second call: %v", err)
	}
	if hits.Load() != 1 {
		t.Errorf("HTTP hits after second call = %d, want 1 (existing asset should be reused)", hits.Load())
	}
	if node2.URI != node.URI || node2.ID != node.ID || node2.Bytes != node.Bytes || node2.Title != node.Title {
		t.Errorf("second call descriptor = %+v, want %+v", node2, node)
	}
}

func TestFetchPage_RefusesOn403TimeoutNonHTMLAndEmpty(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		timeout time.Duration
		wantErr string
	}{
		{
			name: "403 status",
			handler: func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "forbidden", http.StatusForbidden)
			},
			timeout: 2 * time.Second,
			wantErr: "403",
		},
		{
			name: "timeout",
			handler: func(w http.ResponseWriter, r *http.Request) {
				time.Sleep(250 * time.Millisecond)
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(`<html><body><p>slow</p></body></html>`))
			},
			timeout: 30 * time.Millisecond,
			wantErr: "timeout",
		},
		{
			name: "non-HTML",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/pdf")
				w.Write([]byte("%PDF-1.4 binary"))
			},
			timeout: 2 * time.Second,
			wantErr: "non-HTML",
		},
		{
			name: "empty body",
			handler: func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				w.Write([]byte(`<html><body></body></html>`))
			},
			timeout: 2 * time.Second,
			wantErr: "empty",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(tt.handler)
			defer srv.Close()

			s, ds := newTestServerWithDocs(t)
			s.fetchTimeout = tt.timeout
			buf, err := ds.New()
			if err != nil {
				t.Fatalf("New buffer: %v", err)
			}
			doc, err := ds.Save(buf)
			if err != nil {
				t.Fatalf("Save buffer: %v", err)
			}

			ctx := WithDocument(context.Background(), doc.UUID())
			_, _, err = s.fetchPage(ctx, nil, FetchPageInput{URL: srv.URL + "/page"})
			if err == nil {
				t.Fatalf("fetch_page(%s) succeeded, want refusal", tt.name)
			}
			if !strings.HasPrefix(err.Error(), "cannot retrieve:") {
				t.Errorf("err = %q, want 'cannot retrieve: {reason}' prefix", err.Error())
			}
			if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(tt.wantErr)) {
				t.Errorf("err = %q, want it to contain %q", err.Error(), tt.wantErr)
			}
			reloaded, _ := ds.LoadByUUID(doc.UUID())
			if len(reloaded.Storable().Owns()) != 0 {
				t.Errorf("refused fetch_page must not write any asset; owns = %d", len(reloaded.Storable().Owns()))
			}
		})
	}
}

func TestFetchPage_RefusesWhenSessionHasNoDocument(t *testing.T) {
	s := newTestServer(t)
	_, _, err := s.fetchPage(context.Background(), nil, FetchPageInput{URL: "https://example.com"})
	if err == nil || !strings.HasPrefix(err.Error(), "cannot retrieve:") {
		t.Fatalf("unscoped fetch_page err = %v, want 'cannot retrieve:' refusal", err)
	}
}

