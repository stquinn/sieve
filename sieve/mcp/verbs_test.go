package mcp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/command"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store"
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
// the composition root does — the real editor.Router over the real notes and
// chats sources — so the address verb is exercised through the resolver it actually ships
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
	chats, err := services.NewChatService(fs, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	router := editor.NewRouter(editor.NewNotesSource(ds), editor.NewChatSource(chats))
	return NewServer(ds, services.NewAssetService(fs, ""), router, router, services.NewLinkPreviewService()), ds, fs
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

// search finds filed notes and buffers by name, summary and tags — never by body
// — in its folder and under its limit.
func TestSearch_FindsByNameSummaryAndTagsInAFolderUnderALimit(t *testing.T) {
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
	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	buf.Meta().SetDisplayName("Scratch Channels")
	buf.SetBody([]byte("unfiled thoughts about coordination"))
	if _, err := ds.Save(buf); err != nil {
		t.Fatalf("Save buffer: %v", err)
	}

	for _, tc := range []struct {
		name      string
		in        SearchInput
		want      []string
		truncated bool
	}{
		{"name", SearchInput{Query: "concurrency"}, []string{"Go Concurrency"}, false},
		{"summary", SearchInput{Query: "comprehensions"}, []string{"Python Tips"}, false},
		{"tags", SearchInput{Query: "personal"}, []string{"Grocery List"}, false},
		{"never a body", SearchInput{Query: "coordination"}, nil, false},
		{"a buffer by its name", SearchInput{Query: "channels"}, []string{"Go Concurrency", "Scratch Channels"}, false},
		{"empty lists everything", SearchInput{}, []string{"Go Concurrency", "Python Tips", "Grocery List", "Scratch Channels"}, false},
		{"folder", SearchInput{Folder: "programming"}, []string{"Go Concurrency", "Python Tips"}, false},
		{"folder leaves out buffers", SearchInput{Query: "channels", Folder: "programming"}, []string{"Go Concurrency"}, false},
		{"limit truncates", SearchInput{Limit: 1}, []string{"Go Concurrency"}, true},
		{"an exact fit is not truncated", SearchInput{Limit: 4}, []string{"Go Concurrency", "Python Tips", "Grocery List", "Scratch Channels"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, res, err := s.search(context.Background(), nil, tc.in)
			if err != nil {
				t.Fatalf("search: %v", err)
			}
			var got []string
			for _, r := range res.Results {
				got = append(got, r.Title)
			}
			if strings.Join(got, "|") != strings.Join(tc.want, "|") || res.Truncated != tc.truncated {
				t.Errorf("search(%+v) = %q truncated=%v, want %q truncated=%v", tc.in, got, res.Truncated, tc.want, tc.truncated)
			}
		})
	}
}

// A hit is metadata the model can act on: its address, the kind, and
// the note's own folder, tags, summary and modified time.
func TestSearch_AHitIsTheTargetsMetadata(t *testing.T) {
	s, ds := newTestServerWithDocs(t)
	uuid := seedNote(t, ds, "Go Concurrency", "programming", "go-concurrency",
		[]string{"go", "concurrency"}, "goroutines and channels", "# Go")
	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	buf.Meta().SetDisplayName("Go scratch")
	if _, err := ds.Save(buf); err != nil {
		t.Fatalf("Save buffer: %v", err)
	}

	_, res, err := s.search(context.Background(), nil, SearchInput{Query: "go"})
	if err != nil || len(res.Results) != 2 {
		t.Fatalf("search = %+v, %v; want the note and the buffer", res, err)
	}
	note, scratch := res.Results[0], res.Results[1]
	for _, hit := range res.Results {
		requireNoIdentityField(t, hit)
	}
	if note.URI != uriOf(uuid) || res.Results[1].URI != uriOf(buf.UUID()) {
		t.Errorf("hits carry no address: %+v", res.Results)
	}
	if note.Kind != "note" || note.Folder != "programming" ||
		strings.Join(note.Tags, ",") != "go,concurrency" || note.Summary != "goroutines and channels" || note.Modified == "" {
		t.Errorf("note hit = %+v", note)
	}
	if scratch.Kind != "buffer" || scratch.Folder != "" || scratch.Tags == nil || len(scratch.Tags) != 0 {
		t.Errorf("buffer hit = %+v, want kind buffer, no folder and an empty tag list", scratch)
	}
}

func TestGetMeta_NoBody(t *testing.T) {
	s := newTestServer(t)
	_, res, err := s.search(context.Background(), nil, SearchInput{Query: "grocery"})
	if err != nil || len(res.Results) != 1 {
		t.Fatalf("seed search: %v res=%+v", err, res)
	}
	uri := res.Results[0].URI

	_, meta, err := s.getMeta(context.Background(), nil, URIInput{URI: uri})
	if err != nil {
		t.Fatalf("get_meta: %v", err)
	}
	if meta.URI != uri {
		t.Errorf("meta names itself %q, want %q", meta.URI, uri)
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
	uri := res.Results[0].URI

	_, note, err := s.getNote(context.Background(), nil, URIInput{URI: uri})
	if err != nil {
		t.Fatalf("get_note: %v", err)
	}
	if note.Meta.URI != uri {
		t.Errorf("meta.uri = %q, want %q", note.Meta.URI, uri)
	}
	if note.Meta.Title != "Go Concurrency" {
		t.Errorf("meta.title = %q", note.Meta.Title)
	}
	if note.Body == "" || !strings.Contains(note.Body, "channels") {
		t.Errorf("body = %q, want the markdown body", note.Body)
	}
}

// An address that names no note — a block or an asset key, typically — is still
// an error, but one that points the model at the verb that reads those.
func TestNoteVerbs_PointAnAddressThatIsNoNoteAtGetByURI(t *testing.T) {
	s := newTestServer(t)
	const blockID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c02"
	uri := uriOf(blockID)
	verbs := map[string]func() error{
		"get_note": func() error {
			_, _, err := s.getNote(context.Background(), nil, URIInput{URI: uri})
			return err
		},
		"get_meta": func() error {
			_, _, err := s.getMeta(context.Background(), nil, URIInput{URI: uri})
			return err
		},
	}
	for verb, call := range verbs {
		t.Run(verb, func(t *testing.T) {
			err := call()
			if err == nil {
				t.Fatal("an address that names no note must be an error")
			}
			for _, want := range []string{verb, uri, "not a note", "get_by_uri"} {
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

// fetch_page keeps a fetched page in the folder of the container the run works
// on, a note or a chat alike, and a second fetch of the same URL reuses it.
func TestFetchPage_WritesHTMLAssetAndReusesOnSecondCall(t *testing.T) {
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

	for _, owner := range []struct {
		name string
		// create stores the container the run works on and answers its uuid, and
		// what the store now holds for it.
		create func(t *testing.T, ds *services.DocumentService, st *filestore.FileStore) (string, func() store.MetaStorable)
	}{
		{"a note", func(t *testing.T, ds *services.DocumentService, _ *filestore.FileStore) (string, func() store.MetaStorable) {
			buf, err := ds.New()
			if err != nil {
				t.Fatalf("New buffer: %v", err)
			}
			buf.SetBody([]byte("Initial notes.\n"))
			doc, err := ds.Save(buf)
			if err != nil {
				t.Fatalf("Save buffer: %v", err)
			}
			return doc.UUID(), func() store.MetaStorable {
				reloaded, err := ds.LoadByUUID(doc.UUID())
				if err != nil {
					t.Fatalf("LoadByUUID: %v", err)
				}
				return reloaded.Storable()
			}
		}},
		{"a chat", func(t *testing.T, _ *services.DocumentService, st *filestore.FileStore) (string, func() store.MetaStorable) {
			chats, err := services.NewChatService(st, block.NewChatCodec(block.GlobalRegistry()))
			if err != nil {
				t.Fatalf("NewChatService: %v", err)
			}
			c, err := chats.Create("")
			if err != nil {
				t.Fatalf("Create chat: %v", err)
			}
			return c.UUID(), func() store.MetaStorable {
				reloaded, err := chats.Load(c.UUID())
				if err != nil {
					t.Fatalf("Load chat: %v", err)
				}
				return reloaded.Storable()
			}
		}},
	} {
		t.Run(owner.name, func(t *testing.T) {
			hits.Store(0)
			s, ds, st := newTestServerWithStore(t)
			uuid, stored := owner.create(t, ds, st)

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
			key := s.assets.PageAssetKey(pageURL)
			if !strings.HasSuffix(key, ".html") {
				t.Errorf("page asset key = %q, want an .html key", key)
			}
			wantURI := domain.NewLeafAddress(uuid, key).String()
			if node.URI != wantURI {
				t.Errorf("URI = %q, want %q", node.URI, wantURI)
			}
			if node.Title != "Verstappen Wins in Suzuka" {
				t.Errorf("Title = %q, want %q", node.Title, "Verstappen Wins in Suzuka")
			}
			wantPath := path.Join(stored().ExternalRef(), key)
			if node.Path != wantPath {
				t.Errorf("Path = %q, want %q", node.Path, wantPath)
			}
			if node.Bytes == 0 {
				t.Error("Bytes = 0, want non-zero HTML asset size")
			}
			if node.Body != "" {
				t.Errorf("Body = %q, want empty (asset bytes live on disk at Path)", node.Body)
			}

			var savedBody string
			for _, owned := range stored().Owns() {
				if owned.Key() == key {
					savedBody = string(owned.Body())
					break
				}
			}
			if savedBody == "" {
				t.Fatalf("asset %q not found in what %s owns", key, uuid)
			}
			if !strings.HasPrefix(savedBody, `<!doctype html><html><head><meta charset="utf-8"><title>Verstappen Wins in Suzuka</title></head><body>`) ||
				!strings.Contains(savedBody, "Max Verstappen controlled the Japanese Grand Prix") {
				t.Errorf("saved asset is not the titled readable HTML document:\n%s", savedBody)
			}
			if strings.Contains(savedBody, "Skip to content") || strings.Contains(savedBody, "BBC Terms of Use") {
				t.Errorf("saved asset retained boilerplate:\n%s", savedBody)
			}

			// Second call for the same URL must reuse the existing asset without re-fetching.
			_, node2, err := s.fetchPage(ctx, nil, FetchPageInput{URL: pageURL})
			if err != nil {
				t.Fatalf("fetch_page second call: %v", err)
			}
			if hits.Load() != 1 {
				t.Errorf("HTTP hits after second call = %d, want 1 (existing asset should be reused)", hits.Load())
			}
			if node2.URI != node.URI || node2.Bytes != node.Bytes || node2.Title != node.Title {
				t.Errorf("second call descriptor = %+v, want %+v", node2, node)
			}
		})
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
			if s.fetchTimeout != pageFetchTimeout {
				t.Fatalf("fetchTimeout = %s, want pageFetchTimeout %s", s.fetchTimeout, pageFetchTimeout)
			}
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
	_, _, err := s.fetchPage(WithDocument(context.Background(), ""), nil, FetchPageInput{URL: "https://example.com"})
	if err == nil || !strings.HasPrefix(err.Error(), "cannot retrieve:") {
		t.Fatalf("unscoped fetch_page err = %v, want 'cannot retrieve:' refusal", err)
	}
}

// answerAppend is one call an AnswerWriter received.
type answerAppend struct {
	ex        domain.Exchange
	kind      string
	startOver bool
}

// stubAnswerWriter records every append it is asked for, refusing them all with
// refuse when it is set, and holds its answers as holding says.
type stubAnswerWriter struct {
	calls   []answerAppend
	refuse  error
	holding domain.AnswerHolding
}

func (w *stubAnswerWriter) AnswerHolding() domain.AnswerHolding { return w.holding }

func (w *stubAnswerWriter) AppendToAnswer(ex domain.Exchange, el domain.SieveBlock, startOver bool) error {
	if w.refuse != nil {
		return w.refuse
	}
	w.calls = append(w.calls, answerAppend{ex: ex, kind: el.Kind, startOver: startOver})
	return nil
}

// holdings are the real holdings of each holder an answer can live in, as their
// writers declare them.
var holdings = map[domain.AnswerHolder]domain.AnswerHolding{
	domain.HeldInContainer: (&editor.EditorService{}).AnswerHolding(),
	domain.HeldByCommand:   command.NewRegistry().AnswerHolding(),
}

// newAnswerServer is a server with answers opened over the real registry (prose
// and code registered) and a stub writer for ex's holder alone, holding as that
// holder's real writer does, and a token bound to ex for a run that may answer
// as writes says.
func newAnswerServer(t *testing.T, ex domain.Exchange, writes bool) (*Server, *stubAnswerWriter, string) {
	t.Helper()
	s, _ := newTestServerWithDocs(t)
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	w := &stubAnswerWriter{holding: holdings[ex.Holder]}
	s.OpenAnswers(block.GlobalRegistry(), map[domain.AnswerHolder]AnswerWriter{ex.Holder: w})
	s.SetBaseURL("http://127.0.0.1:34115")
	_, token, _ := s.EndpointFor(ex, writes)
	return s, w, token
}

// add_to_answer builds each block through the kind and appends it to the
// exchange its token is bound to, the run's first block replacing an earlier
// run's answer. A refusal — of the type, the map, the token or the write —
// writes nothing and leaves the run with no written answer, and a run whose
// task returns data may call no write verb. Once the run has ended, a call
// still holding its grant writes nothing.
func TestAddToAnswer_AppendsToTheTokensExchange(t *testing.T) {
	exchange := domain.Exchange{Container: "0198c1a0-0001-7000-8000-000000000001", Block: "0198c1a0-0001-7000-8000-000000000020"}
	held := domain.Exchange{Block: "0198c1a0-0001-7000-8000-000000000021", Holder: domain.HeldByCommand}
	prose := AddToAnswerInput{ContentType: "sieve/prose", Attrs: map[string]any{"content": "Go compiles."}}
	code := AddToAnswerInput{ContentType: "sieve/code", Attrs: map[string]any{"source": "func main() {}", "language": "go"}}

	for _, tc := range []struct {
		name      string
		bound     domain.Exchange
		data      bool // the run's task returns data, so it may not write
		refuse    error
		calls     []AddToAnswerInput
		wantErr   []string
		wantCalls []answerAppend
	}{
		{name: "blocks append in order", bound: exchange, calls: []AddToAnswerInput{prose, code},
			wantCalls: []answerAppend{{exchange, "prose", true}, {exchange, "code", false}}},
		{name: "an unknown content type answers with the catalogue", bound: exchange,
			calls: []AddToAnswerInput{{ContentType: "sieve/table", Attrs: map[string]any{"rows": 2}}}, wantErr: []string{"sieve/table", "sieve/prose", "sieve/code"}},
		{name: "a refused map answers with the kind's example", bound: exchange,
			calls: []AddToAnswerInput{{ContentType: "sieve/code", Attrs: map[string]any{"source": "x := 1"}}}, wantErr: []string{"language", "example"}},
		{name: "a deleted exchange is refused and the model told to stop", bound: exchange, refuse: errors.New(`block "x" is not in this document`),
			calls: []AddToAnswerInput{prose}, wantErr: []string{"not in this document", "stop"}},
		{name: "a running command's block is written by its holder's writer", bound: held, calls: []AddToAnswerInput{prose, code},
			wantCalls: []answerAppend{{held, "prose", true}, {held, "code", false}}},
		{name: "a token bound to a document alone answers nothing", bound: domain.Exchange{Container: exchange.Container},
			calls: []AddToAnswerInput{prose}, wantErr: []string{"not answering"}},
		{name: "a run whose task returns data writes no answer", bound: exchange, data: true,
			calls: []AddToAnswerInput{prose}, wantErr: []string{"add_to_answer", "writes nothing into a document"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, w, token := newAnswerServer(t, tc.bound, !tc.data)
			w.refuse = tc.refuse
			g, _ := s.grantOf(token)
			ctx := g.bind(context.Background())

			var err error
			for i, in := range tc.calls {
				var out AnswerAdded
				if _, out, err = s.addToAnswer(ctx, nil, in); err == nil && out.Blocks != i+1 {
					t.Errorf("call %d reports %d blocks, want %d", i, out.Blocks, i+1)
				}
			}
			if tc.wantErr == nil && err != nil {
				t.Fatalf("add_to_answer: %v", err)
			}
			for _, want := range tc.wantErr {
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Errorf("err = %v, want it to carry %q", err, want)
				}
			}
			if fmt.Sprint(w.calls) != fmt.Sprint(tc.wantCalls) {
				t.Errorf("appends = %+v, want %+v", w.calls, tc.wantCalls)
			}
			if _, _, err := s.describeAnswer(ctx, nil, struct{}{}); (err != nil) != tc.data {
				t.Errorf("describe_answer: %v, want it refused exactly when the run may not write", err)
			}
			if got := s.EndRun(token); got != len(tc.wantCalls) {
				t.Errorf("EndRun = %d written, want %d", got, len(tc.wantCalls))
			}
			if _, _, err := s.addToAnswer(ctx, nil, prose); err == nil || len(w.calls) != len(tc.wantCalls) {
				t.Errorf("an add_to_answer after the run ended was taken (err %v)", err)
			}
		})
	}
}

// newOwningDocument stores a new document in st and answers its uuid.
func newOwningDocument(t *testing.T, st *filestore.FileStore) string {
	t.Helper()
	docs, err := services.NewDocumentService(st)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	doc, err := docs.New()
	if err != nil {
		t.Fatalf("New document: %v", err)
	}
	return doc.UUID()
}

// newOwningChat stores a new chat in st and answers its uuid.
func newOwningChat(t *testing.T, st *filestore.FileStore) string {
	t.Helper()
	chats, err := services.NewChatService(st, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create chat: %v", err)
	}
	return c.UUID()
}

// The holder an answer lives in decides what a run may write into it: an answer
// held in an open container, a note or a chat, takes every kind, one held by a popup command refuses a
// block that lands waiting on work — every log, link card, web clip and image,
// a PlantUML diagram — with the reason and the types it takes, and describe_answer lists
// exactly what this run is offered. A type no kind offers is refused apart.
func TestAnswerHolders_DecideWhatARunMayWrite(t *testing.T) {
	kinds := []struct {
		name  string
		in    AddToAnswerInput
		waits bool // its every block waits on work, so the popup does not list it
	}{
		{"prose", AddToAnswerInput{ContentType: "sieve/prose", Attrs: map[string]any{"content": "Go compiles."}}, false},
		{"code", AddToAnswerInput{ContentType: "sieve/code", Attrs: map[string]any{"source": "x := 1", "language": "go"}}, false},
		{"mermaid", AddToAnswerInput{ContentType: "sieve/diagram", Attrs: map[string]any{"source": "graph TD\n  A --> B"}}, false},
		{"plantuml", AddToAnswerInput{ContentType: "sieve/diagram", Attrs: map[string]any{"source": "A -> B", "diagramType": "plantuml"}}, false},
		{"log", AddToAnswerInput{ContentType: "sieve/log", Attrs: map[string]any{"source": "2026-11-26T10:00:02Z ERROR pool exhausted"}}, true},
		{"link card", AddToAnswerInput{ContentType: "sieve/smart-card", Attrs: map[string]any{"href": "https://go.dev"}}, true},
		{"web clip", AddToAnswerInput{ContentType: "sieve/web-clip", Attrs: map[string]any{"source": "https://go.dev/blog/go1.22"}}, true},
		{"image", AddToAnswerInput{ContentType: "sieve/smart-image", Attrs: map[string]any{"url": "{web}/chart.png"}}, true},
	}
	for _, holder := range []struct {
		name string
		ex   domain.Exchange
		// owner stores the container the answer lands in and answers its uuid; nil
		// for a holder that is no container.
		owner   func(t *testing.T, st *filestore.FileStore) string
		refused map[string]string // kind → what its refusal says
	}{
		{name: "an answer in a document", ex: domain.Exchange{Block: "0198c1a0-0001-7000-8000-000000000020"}, owner: newOwningDocument},
		{name: "an answer in a chat", ex: domain.Exchange{Block: "0198c1a0-0001-7000-8000-000000000022"}, owner: newOwningChat},
		{name: "a popup command's answer", ex: domain.Exchange{Block: "0198c1a0-0001-7000-8000-000000000021", Holder: domain.HeldByCommand},
			refused: map[string]string{"plantuml": "a PlantUML diagram", "log": "every log", "link card": "every link card", "web clip": "every web clip", "image": "every image"}},
	} {
		t.Run(holder.name, func(t *testing.T) {
			images, err := filestore.NewFileStore(t.TempDir(), "testhost")
			if err != nil {
				t.Fatalf("NewFileStore: %v", err)
			}
			// A file is kept for an owner the store holds, so the container an answer
			// lands in is a real one in the store the image is kept in.
			ex := holder.ex
			if holder.owner != nil {
				ex.Container = holder.owner(t, images)
			}
			s, w, token := newAnswerServer(t, ex, true)
			block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
			block.RegisterProcessor(processors.NewLogProcessor(block.BlockServices{}))
			block.RegisterProcessor(processors.NewSmartCardProcessor(block.BlockServices{}))
			block.RegisterProcessor(processors.NewWebClipBlockProcessor(block.BlockServices{}))
			block.RegisterProcessor(processors.NewSmartImageProcessor(block.BlockServices{Assets: services.NewAssetService(images, "")}))
			var chart bytes.Buffer
			_ = png.Encode(&chart, image.NewRGBA(image.Rect(0, 0, 4, 3)))
			web := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(chart.Bytes()) }))
			defer web.Close()
			g, _ := s.grantOf(token)
			ctx := g.bind(context.Background())

			_, cat, err := s.describeAnswer(ctx, nil, struct{}{})
			if err != nil {
				t.Fatalf("describe_answer: %v", err)
			}
			listed := map[string]bool{}
			for _, card := range cat.ContentTypes {
				listed[card.ContentType] = true
			}
			if (cat.Note != "") != (holder.refused != nil) {
				t.Errorf("note = %q, want one exactly when the holder refuses blocks", cat.Note)
			}
			for _, k := range kinds {
				if want := !(k.waits && holder.refused != nil); listed[k.in.ContentType] != want {
					t.Errorf("%s: listed = %v, want %v", k.name, listed[k.in.ContentType], want)
				}
				if u, _ := k.in.Attrs["url"].(string); u != "" {
					k.in.Attrs = map[string]any{"url": strings.Replace(u, "{web}", web.URL, 1)}
				}
				_, _, err := s.addToAnswer(ctx, nil, k.in)
				reason, refused := holder.refused[k.name]
				switch {
				case !refused && err != nil:
					t.Errorf("%s: refused: %v", k.name, err)
				case refused && err == nil:
					t.Errorf("%s: taken, want it refused", k.name)
				case refused:
					for _, want := range []string{k.in.ContentType + " cannot be used in this answer", reason, "popup", "Available here: sieve/prose"} {
						if !strings.Contains(err.Error(), want) {
							t.Errorf("%s: refusal %q does not say %q", k.name, err, want)
						}
					}
				}
			}
			if want := len(kinds) - len(holder.refused); len(w.calls) != want {
				t.Errorf("%d blocks written, want %d", len(w.calls), want)
			}
			_, _, err = s.addToAnswer(ctx, nil, AddToAnswerInput{ContentType: "sieve/table", Attrs: map[string]any{"rows": 2}})
			if err == nil || !strings.Contains(err.Error(), "not a content type") || !strings.Contains(err.Error(), "Available here") {
				t.Errorf("an unknown type: %v, want it refused as no content type, naming what is available", err)
			}
		})
	}
}
