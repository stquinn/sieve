package editor

import (
	"errors"
	"strings"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// seedFiledNote creates a buffer, stamps metadata, and files it into the library.
// Deliberately a second copy of the services-package fixture: an unexported test
// helper cannot cross a package boundary, and exporting one so tests can share it
// would put fixture code in the production API.
func seedFiledNote(t *testing.T, ds *services.DocumentService, title, folder string, tags []string, summary, body string) domain.Document {
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
	fn := domain.ToKebab(title) // distinct filenames; the fallback is a shared timestamp
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
	return filed
}

func newTestNotesSource(t *testing.T) (*NotesSource, *services.DocumentService) {
	t.Helper()
	ds, _ := newTestDocumentService(t)
	return NewNotesSource(ds), ds
}

func TestNotesSource_ResolvesALiveAddress(t *testing.T) {
	src, ds := newTestNotesSource(t)
	note := seedFiledNote(t, ds, "Auth Design", "design", []string{"auth"},
		"Token exchange and refresh rules.", "# Auth Design\n\nBearer tokens.")

	uri := domain.NewContainerAddress(note.UUID()).String()
	node, err := src.Resolve(uri)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if node.URI != uri {
		t.Errorf("uri = %q, want %q", node.URI, uri)
	}
	if node.UUID != note.UUID() {
		t.Errorf("uuid = %q, want %q", node.UUID, note.UUID())
	}
	if node.Kind != "note" {
		t.Errorf("kind = %q, want note", node.Kind)
	}
	if node.Title != "Auth Design" {
		t.Errorf("title = %q, want Auth Design", node.Title)
	}
	if node.Summary != "Token exchange and refresh rules." {
		t.Errorf("summary = %q", node.Summary)
	}
	if !strings.Contains(node.Body, "Bearer tokens.") {
		t.Errorf("body not resolved: %q", node.Body)
	}
}

// A deleted target is dangling — a typed error the caller can render as a stale
// chip, never a panic.
func TestNotesSource_DeletedAddressDangles(t *testing.T) {
	src, ds := newTestNotesSource(t)
	note := seedFiledNote(t, ds, "Doomed", "", nil, "", "gone soon")
	uri := domain.NewContainerAddress(note.UUID()).String()

	if err := ds.Delete(note); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, err := src.Resolve(uri); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

// THE source invariant: a source may only offer what the AI can dereference, and
// this source answers for filed library documents only. An unfiled buffer is
// neither offered nor resolved — even though DocumentService.LoadByUUID finds it.
func TestNotesSource_RefusesBuffers(t *testing.T) {
	src, ds := newTestNotesSource(t)
	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	buf.Meta().SetDisplayName("Scratch Auth Notes")
	if buf, err = ds.SaveMeta(buf); err != nil {
		t.Fatalf("SaveMeta: %v", err)
	}

	// Sanity: the document service itself does resolve the buffer.
	if _, err := ds.LoadByUUID(buf.UUID()); err != nil {
		t.Fatalf("precondition: buffer should be loadable: %v", err)
	}

	uri := domain.NewContainerAddress(buf.UUID()).String()
	if _, err := src.Resolve(uri); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("Resolve(buffer) err = %v, want ErrNodeNotFound", err)
	}
	for _, c := range src.Search("auth", 10) {
		if c.URI == uri {
			t.Fatalf("the notes source offered a buffer: %+v", c)
		}
	}
}

// A block: address is perfectly well formed — the notes source simply does not
// answer that address space, which the Router must read as "ask the next source"
// rather than as a failure.
func TestNotesSource_DoesNotAnswerForeignSchemes(t *testing.T) {
	src, _ := newTestNotesSource(t)
	blockURI := "block:" + testContainerUUID + "/" + testBlockUUID
	if _, err := src.Resolve(blockURI); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound (this source does not answer block:)", err)
	}
}

func TestNotesSource_SearchOffersTitleSummaryAndTagMatches(t *testing.T) {
	src, ds := newTestNotesSource(t)
	auth := seedFiledNote(t, ds, "Auth Design", "design", []string{"security"},
		"Token exchange rules.", "# Auth Design\n\nNothing else says the word.")
	seedFiledNote(t, ds, "Grocery List", "", []string{"personal"}, "weekly shop", "milk, eggs")

	// Title match — the gap this phase closes: "Auth Design" appears nowhere but
	// the display name.
	got := src.Search("auth design", 8)
	if len(got) != 1 {
		t.Fatalf("title query returned %+v, want the Auth note", got)
	}
	want := domain.NewContainerAddress(auth.UUID()).String()
	if got[0].URI != want {
		t.Errorf("uri = %q, want %q", got[0].URI, want)
	}
	if got[0].Title != "Auth Design" || got[0].Kind != "note" {
		t.Errorf("candidate = %+v", got[0])
	}
	if !strings.Contains(got[0].Detail, "design") {
		t.Errorf("detail = %q, want the folder in it (it is what disambiguates duplicate titles)", got[0].Detail)
	}

	// Summary match.
	if got := src.Search("token exchange", 8); len(got) != 1 || got[0].Title != "Auth Design" {
		t.Errorf("summary query returned %+v", got)
	}

	// Tag match.
	if got := src.Search("security", 8); len(got) != 1 || got[0].Title != "Auth Design" {
		t.Errorf("tag query returned %+v", got)
	}
}

func TestNotesSource_SearchHonoursLimitAndEmptyQuery(t *testing.T) {
	src, ds := newTestNotesSource(t)
	seedFiledNote(t, ds, "Alpha Note", "", nil, "", "alpha")
	seedFiledNote(t, ds, "Beta Note", "", nil, "", "beta")

	if got := src.Search("note", 1); len(got) != 1 {
		t.Errorf("limit ignored: %+v", got)
	}
	if got := src.Search("", 8); len(got) != 0 {
		t.Errorf("empty query returned %+v, want nothing", got)
	}
}
