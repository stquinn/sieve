package services

import (
	"strings"
	"testing"

	"sieve/sieve/domain"
	"sieve/store/filestore"
)

func newTestDocumentService(t *testing.T) (*DocumentService, *filestore.FileStore) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	ds, err := NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}

	return ds, fs
}

// seedFiledNote creates a buffer, stamps metadata, and files it into the library.
func seedFiledNote(t *testing.T, ds *DocumentService, title, folder string, tags []string, summary, body string) domain.Document {
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

func TestDocumentService_FilePromotesBufferAndAssets(t *testing.T) {
	ds, fs := newTestDocumentService(t)

	// 1. Create a new buffer
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("Failed to create new buffer: %v", err)
	}

	// 2. Attach an asset to the buffer via the FileStore
	// We need to simulate what AssetService does
	asset, err := fs.CreateAsset(domain.WorkingCopy, doc.Storable().Meta()["uuid"], "img1", []byte("fake-png"))
	if err != nil {
		t.Fatalf("Failed to create asset: %v", err)
	}

	// 3. Attach it to the document
	doc.Storable().AttachAsset(asset)

	oldExtRef := asset.ExternalRef()

	// Add markdown containing the external ref to the body
	doc.Storable().SetBody([]byte("Image: ![](" + oldExtRef + ")"))

	// Save document to persist it
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Failed to save document: %v", err)
	}

	// Set display name so that when it's filed, it takes a specific name
	meta := doc.Storable().Meta()
	meta["display_name"] = "My Test Note"
	doc.Storable().SetMeta(meta)

	// 4. File the document (promotes to Library)
	filedDoc, err := ds.File(doc)
	if err != nil {
		t.Fatalf("Failed to file document: %v", err)
	}

	// 5. Verify the filed document
	if filedDoc.Kind() != domain.KindNote {
		t.Errorf("Expected filed document to be a Note, got %v", filedDoc.Kind())
	}

	// Read the new body
	newBody := string(filedDoc.Body())
	newOwns := filedDoc.Storable().Owns()

	if len(newOwns) == 0 {
		t.Fatal("Owned assets lost during File operation")
	}

	// In the document-as-directory model, asset URLs are UUID-stable:
	// /sieve/{uuid}/{filename} — the UUID doesn't change on Move/Rename, so
	// the asset reference in the body is preserved as-is. The old and new
	// ExternalRefs are identical.
	newExtRef := newOwns[0].ExternalRef()
	if !strings.Contains(newBody, oldExtRef) {
		t.Errorf("Expected body to still contain the stable asset ref %q, got: %s", oldExtRef, newBody)
	}
	_ = newExtRef
}

// Search matched tags, summary and body but NOT the display name, so a note
// called "Auth Design" was findable only if that string also appeared in its
// body — which a name-keyed @-picker cannot live with.
func TestDocumentService_SearchMatchesDisplayName(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	note := seedFiledNote(t, ds, "Auth Design", "", []string{"security"},
		"Token exchange rules.", "# Heading\n\nThe body never says the title.")

	results, err := ds.Search("auth design")
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want the Auth note: %+v", len(results), results)
	}
	got := results[0]
	if got.ID != note.UUID() {
		t.Errorf("id = %q, want %q", got.ID, note.UUID())
	}
	if !got.IsTitleMatch {
		t.Errorf("IsTitleMatch = false for a display-name hit: %+v", got)
	}
	if got.IsBodyMatch || got.IsSummaryMatch || got.IsTagMatch {
		t.Errorf("only the title matched, got %+v", got)
	}
}

// The existing match kinds keep their own flags — a title match is an addition,
// not a replacement.
func TestDocumentService_SearchKeepsBodySummaryAndTagMatches(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	seedFiledNote(t, ds, "Notes", "", []string{"security"}, "Token exchange rules.",
		"# Notes\n\nA sentence about goroutines.")

	for _, tc := range []struct {
		query string
		check func(SearchResult) bool
	}{
		{"goroutines", func(r SearchResult) bool { return r.IsBodyMatch }},
		{"token exchange", func(r SearchResult) bool { return r.IsSummaryMatch }},
		{"security", func(r SearchResult) bool { return r.IsTagMatch }},
	} {
		results, err := ds.Search(tc.query)
		if err != nil {
			t.Fatalf("Search(%q): %v", tc.query, err)
		}
		if len(results) != 1 || !tc.check(results[0]) {
			t.Errorf("Search(%q) = %+v, want the note flagged with its own match kind", tc.query, results)
		}
	}
}
