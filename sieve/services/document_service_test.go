package services

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"sieve/sieve/domain"
	"sieve/store"
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

// seedBlockIn creates a type: block storable whose name and body carry the word
// the search assertions look for.
func seedBlockIn(t *testing.T, fs *filestore.FileStore, cat store.Category, key string) store.MetaStorable {
	t.Helper()
	ms, err := fs.CreateTyped(cat, key, store.TypeBlock,
		map[string]string{store.MetaKeyKind: "test-kind", "display_name": "Untitled 41 quarantined"},
		[]byte("title: quarantined\n"))
	if err != nil {
		t.Fatalf("CreateTyped: %v", err)
	}
	return ms
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

	// Set display name and folder so that filing moves, reparents and renames it.
	meta := doc.Storable().Meta()
	meta["display_name"] = "My Test Note"
	doc.Storable().SetMeta(meta)
	folder := "projects"
	doc.Meta().SetAiFolderSuggestion(&folder)
	uuid := doc.UUID()

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

	// A block stores its asset as sieve://{uuid}/{key}, so filing must keep the
	// uuid and leave the asset reachable under it.
	if filedDoc.UUID() != uuid {
		t.Fatalf("filing changed the uuid: %q -> %q", uuid, filedDoc.UUID())
	}
	reloaded, err := ds.LoadByUUID(uuid)
	if err != nil || reloaded.Kind() != domain.KindNote {
		t.Fatalf("LoadByUUID(%s) after filing = %v, %v; want the filed note", uuid, reloaded, err)
	}
	key := newOwns[0].Key()
	if data, err := NewAssetService(fs, "").ServeAssetData(uuid, key); err != nil || string(data) != "fake-png" {
		t.Errorf("asset %s/%s after filing = %q, %v; want the original bytes", uuid, key, data, err)
	}
	if !strings.Contains(newBody, oldExtRef) {
		t.Errorf("Expected body to still contain the stable asset ref %q, got: %s", oldExtRef, newBody)
	}
}

// seedBuffer creates an unfiled buffer with a name and a body, and a summary and
// tags a buffer is not searched on.
func seedBuffer(t *testing.T, ds *DocumentService, title, summary string, tags []string, body string) domain.Document {
	t.Helper()
	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New buffer: %v", err)
	}
	m := doc.Meta()
	m.SetDisplayName(title)
	m.SetSummary(&summary)
	m.SetTags(tags)
	doc.SetBody([]byte(body))
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save buffer: %v", err)
	}
	return doc
}

// Search answers every document: filed notes on all four fields, buffers on name
// and content only, notes first, under the criteria's kinds, durable-only,
// folder and limit.
func TestDocumentService_SearchAnswersTheCriteria(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	seedFiledNote(t, ds, "Auth Design", "design/api", []string{"security"},
		"Token exchange rules.", "# Heading\n\nA sentence about goroutines.")
	seedFiledNote(t, ds, "Grocery List", "", []string{"personal"}, "weekly shop", "milk, eggs")
	seedBuffer(t, ds, "Scratch Auth", "buffer summary words", []string{"buffertag"}, "scratch goroutines")

	all := domain.SearchFields{domain.SearchName, domain.SearchSummary, domain.SearchTags, domain.SearchContent}
	for _, tc := range []struct {
		name     string
		criteria domain.SearchCriteria
		want     []string
	}{
		{"name", domain.SearchCriteria{Terms: "AUTH", Fields: domain.SearchFields{domain.SearchName}}, []string{"Auth Design", "Scratch Auth"}},
		{"summary", domain.SearchCriteria{Terms: "token exchange", Fields: domain.SearchFields{domain.SearchSummary}}, []string{"Auth Design"}},
		{"tags", domain.SearchCriteria{Terms: "personal", Fields: domain.SearchFields{domain.SearchTags}}, []string{"Grocery List"}},
		{"content", domain.SearchCriteria{Terms: "goroutines", Fields: domain.SearchFields{domain.SearchContent}}, []string{"Auth Design", "Scratch Auth"}},
		{"name is not content", domain.SearchCriteria{Terms: "milk", Fields: domain.SearchFields{domain.SearchName}}, nil},
		{"name and content", domain.SearchCriteria{Terms: "milk", Fields: domain.SearchFields{domain.SearchName, domain.SearchContent}}, []string{"Grocery List"}},
		{"terms with no field", domain.SearchCriteria{Terms: "auth"}, nil},
		{"a buffer has no summary", domain.SearchCriteria{Terms: "buffer summary", Fields: all}, nil},
		{"a buffer has no tags", domain.SearchCriteria{Terms: "buffertag", Fields: all}, nil},
		{"no terms is everything", domain.SearchCriteria{Fields: all}, []string{"Auth Design", "Grocery List", "Scratch Auth"}},
		{"kinds: notes", domain.SearchCriteria{Kinds: []string{"note"}}, []string{"Auth Design", "Grocery List"}},
		{"kinds: buffers", domain.SearchCriteria{Kinds: []string{"buffer"}}, []string{"Scratch Auth"}},
		{"kinds: none held here", domain.SearchCriteria{Kinds: []string{"digital-note"}}, nil},
		{"durable only", domain.SearchCriteria{Terms: "auth", Fields: all, DurableOnly: true}, []string{"Auth Design"}},
		{"folder", domain.SearchCriteria{Folder: "design"}, []string{"Auth Design"}},
		{"folder nested and cased", domain.SearchCriteria{Folder: "/Design/API/"}, []string{"Auth Design"}},
		{"folder is not a name prefix", domain.SearchCriteria{Folder: "des"}, nil},
		{"folder leaves out buffers", domain.SearchCriteria{Terms: "scratch", Fields: all, Folder: "design"}, nil},
		{"limit", domain.SearchCriteria{Limit: 2}, []string{"Auth Design", "Grocery List"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hits, err := ds.Search(tc.criteria)
			if err != nil {
				t.Fatalf("Search: %v", err)
			}
			var got []string
			for _, h := range hits {
				got = append(got, h.Title)
			}
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Errorf("Search = %q, want %q", got, tc.want)
			}
		})
	}
}

// A hit carries what every consumer shows: its address, kind, the fields that
// matched, the folder and snippet that disambiguate it, its own summary, tags
// and when it changed.
func TestDocumentService_SearchHitsCarryWhatConsumersShow(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	note := seedFiledNote(t, ds, "Auth Design", "design", []string{"security"},
		"Token exchange rules.", "# Heading\n\nThe auth flow is here.")
	buf := seedBuffer(t, ds, "Scratch", "", nil, "auth scribbles")

	hits, err := ds.Search(domain.SearchCriteria{Terms: "auth", Fields: domain.SearchFields{
		domain.SearchContent, domain.SearchName, domain.SearchSummary, domain.SearchTags}})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(hits) != 2 {
		t.Fatalf("hits = %+v, want the note and the buffer", hits)
	}
	n, b := hits[0], hits[1]
	if n.URI != domain.NewContainerAddress(note.UUID()).String() || n.Container() != note.UUID() || n.Kind != "note" {
		t.Errorf("note hit = %+v", n)
	}
	if fmt.Sprint(n.Matched) != "[NAME CONTENT]" {
		t.Errorf("note matched %v, want NAME then CONTENT", n.Matched)
	}
	if n.Folder != "design" || !strings.HasPrefix(n.Detail, "design · ") || !strings.Contains(n.Detail, "auth flow") {
		t.Errorf("folder %q detail %q, want the folder then the content snippet", n.Folder, n.Detail)
	}
	if n.Summary != "Token exchange rules." || fmt.Sprint(n.Tags) != "[security]" || n.Modified == "" {
		t.Errorf("note hit = %+v, want its summary, tags and modified time", n)
	}
	if b.Container() != buf.UUID() || b.Kind != "buffer" || b.Folder != "" || len(b.Tags) != 0 || fmt.Sprint(b.Matched) != "[CONTENT]" {
		t.Errorf("buffer hit = %+v", b)
	}
}

// A folder delete erases every document beneath it in one filesystem call that
// names only the folder, so nothing sweeps those documents out of whatever the
// store uses to resolve uuids. Until DeleteFolder forgets them, LoadByUUID
// keeps handing back a storable for a document whose directory is gone — a
// dangling read that succeeds, which is worse than the honest failure below.
func TestDocumentService_DeleteFolderStopsResolvingTheUUIDsItTook(t *testing.T) {
	ds, fs := newTestDocumentService(t)

	buried := map[string]bool{}
	for _, title := range []string{"First", "Second"} {
		doc := seedFiledNote(t, ds, title, "Doomed", nil, "", "body")
		if _, err := ds.LoadByUUID(doc.UUID()); err != nil {
			t.Fatalf("seeded note %s does not resolve before the delete: %v", title, err)
		}
		buried[doc.UUID()] = true
	}
	// A block beneath the folder goes with it, so its uuid must stop resolving too.
	blk := seedBlockIn(t, fs, domain.LibraryCategory, "doomed-block")
	folderStorable, err := fs.CreateOrLoadFolder(domain.LibraryCategory, domain.CleanFolderPath("Doomed"))
	if err != nil {
		t.Fatalf("CreateOrLoadFolder: %v", err)
	}
	if _, err := fs.Reparent(blk, folderStorable); err != nil {
		t.Fatalf("Reparent: %v", err)
	}
	buried[blk.Key()] = true

	entries, err := ds.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	folder := ""
	for _, e := range entries {
		if e.IsDir && e.Name == "Doomed" {
			folder = e.ID
		}
	}
	if folder == "" {
		t.Fatal("the seeded folder is not in the tree")
	}

	deleted, err := ds.DeleteFolder(folder)
	if err != nil {
		t.Fatalf("DeleteFolder: %v", err)
	}
	got := map[string]bool{}
	for _, uuid := range deleted {
		got[uuid] = true
	}
	if len(got) != len(buried) {
		t.Fatalf("DeleteFolder reported %v, want everything buried %v", got, buried)
	}

	for uuid := range buried {
		if _, err := fs.LoadByUUID(uuid); err == nil {
			t.Errorf("uuid %s still resolves after the folder that held it was deleted", uuid)
		}
	}
}

// #89 — the delete dialog promised the folder "must be empty" while the delete
// was os.RemoveAll. Telling the truth means counting what goes BEFORE it goes,
// and the count has to reach through sub-folders: those documents are destroyed
// just as thoroughly as the ones sitting directly in the folder.
func TestDocumentService_FolderContents_CountsEverythingBeneath(t *testing.T) {
	ds, _ := newTestDocumentService(t)

	seedFiledNote(t, ds, "Top One", "Doomed", nil, "", "body")
	seedFiledNote(t, ds, "Top Two", "Doomed", nil, "", "body")
	seedFiledNote(t, ds, "Buried", "Doomed/Deeper", nil, "", "body")

	folderID := func(name string) string {
		entries, err := ds.List()
		if err != nil {
			t.Fatalf("List: %v", err)
		}
		var walk func([]NoteEntry) string
		walk = func(es []NoteEntry) string {
			for _, e := range es {
				if e.IsDir && e.Name == name {
					return e.ID
				}
				if found := walk(e.Children); found != "" {
					return found
				}
			}
			return ""
		}
		id := walk(entries)
		if id == "" {
			t.Fatalf("folder %q is not in the tree", name)
		}
		return id
	}

	got, err := ds.FolderContents(folderID("Doomed"))
	if err != nil {
		t.Fatalf("FolderContents: %v", err)
	}
	if got.Notes != 3 {
		t.Errorf("Notes = %d, want 3 (two here, one a level down)", got.Notes)
	}
	if got.Folders != 1 {
		t.Errorf("Folders = %d, want 1 (Deeper)", got.Folders)
	}
	if got.IsEmpty() {
		t.Error("IsEmpty() on a folder holding three notes")
	}

	// An empty folder is the case the old copy described, and it must still read
	// as empty rather than as "deletes 0 notes".
	if err := ds.NewFolder("Vacant"); err != nil {
		t.Fatalf("NewFolder: %v", err)
	}
	empty, err := ds.FolderContents(folderID("Vacant"))
	if err != nil {
		t.Fatalf("FolderContents(empty): %v", err)
	}
	if !empty.IsEmpty() || empty.Notes != 0 || empty.Folders != 0 {
		t.Errorf("empty folder counted as %+v", empty)
	}
}

// A block is refused and unseen in every category it can reach, directly or by a
// move: the category alone must never make a YAML body read as a Note.
func TestDocumentService_RefusesABlockInEveryCategory(t *testing.T) {
	placements := []struct {
		name string
		seed func(t *testing.T, fs *filestore.FileStore) string
	}{
		{"working copy", func(t *testing.T, fs *filestore.FileStore) string {
			return seedBlockIn(t, fs, domain.WorkingCopy, "b").Key()
		}},
		{"library", func(t *testing.T, fs *filestore.FileStore) string {
			return seedBlockIn(t, fs, domain.LibraryCategory, "b").Key()
		}},
		{"blocks", func(t *testing.T, fs *filestore.FileStore) string {
			return seedBlockIn(t, fs, domain.Blocks, "b").Key()
		}},
		{"moved to the library", func(t *testing.T, fs *filestore.FileStore) string {
			moved, err := fs.Move(seedBlockIn(t, fs, domain.Blocks, "b"), domain.LibraryCategory)
			if err != nil {
				t.Fatalf("Move: %v", err)
			}
			return moved.Key()
		}},
		{"in a library folder", func(t *testing.T, fs *filestore.FileStore) string {
			folder, err := fs.CreateOrLoadFolder(domain.LibraryCategory, "folder")
			if err != nil {
				t.Fatalf("CreateOrLoadFolder: %v", err)
			}
			moved, err := fs.Reparent(seedBlockIn(t, fs, domain.LibraryCategory, "b"), folder)
			if err != nil {
				t.Fatalf("Reparent: %v", err)
			}
			return moved.Key()
		}},
	}
	for _, tc := range placements {
		t.Run(tc.name, func(t *testing.T) {
			ds, fs := newTestDocumentService(t)
			note := seedFiledNote(t, ds, "Real Note", "", nil, "", "body mentioning quarantined")
			uuid := tc.seed(t, fs)

			if doc, err := ds.LoadByUUID(uuid); !errors.Is(err, domain.ErrNotADocument) {
				t.Errorf("LoadByUUID = %v, %v; want ErrNotADocument", doc, err)
			}

			uuids, err := ds.AllUUIDs()
			if err != nil {
				t.Fatalf("AllUUIDs: %v", err)
			}
			if len(uuids) != 1 || uuids[0] != note.UUID() {
				t.Errorf("AllUUIDs = %v, want only the note", uuids)
			}

			results, err := ds.Search(domain.SearchCriteria{Terms: "quarantined", Fields: domain.SearchFields{domain.SearchName, domain.SearchContent}})
			if err != nil {
				t.Fatalf("Search: %v", err)
			}
			if len(results) != 1 || results[0].Container() != note.UUID() {
				t.Errorf("Search = %+v, want only the note", results)
			}

			if got := ds.Count(); got != 1 {
				t.Errorf("Count = %d, want 1", got)
			}

			entries, err := ds.List()
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			var walk func(es []NoteEntry)
			walk = func(es []NoteEntry) {
				for _, e := range es {
					if e.ID == uuid {
						t.Errorf("the sidebar tree holds the block: %+v", e)
					}
					walk(e.Children)
				}
			}
			walk(entries)

			buffer, err := ds.New()
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			if got := buffer.Meta().DisplayName(); got != "Untitled 1" {
				t.Errorf("new buffer named %q; a block's name must not advance the counter", got)
			}
		})
	}
}
