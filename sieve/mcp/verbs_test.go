package mcp

import (
	"context"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
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

// newTestServerWithDocs builds an EMPTY library and wires the server exactly as
// the composition root does — the real editor.Router over the real notes source
// — so the address verb is exercised through the resolver it actually ships
// with, refusals and all, rather than a fake that could agree with itself.
func newTestServerWithDocs(t *testing.T) (*Server, *services.DocumentService) {
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
	return NewServer(ds, editor.NewRouter(editor.NewNotesSource(ds))), ds
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
