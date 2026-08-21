package editor

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// A uri-list names local files, and ONLY local files. The other flavours a drag
// carries (a dragged link's http URL, a comment line, the trailing blank the CRLF
// termination leaves) name nothing to read, and treating any of them as a path is
// how a link drag would turn into a failed file read.
func TestUriList_FilesReadsOnlyLocalPaths(t *testing.T) {
	cases := []struct {
		name string
		list string
		want []droppedFile
	}{
		{
			name: "one file, CRLF terminated as the format requires",
			list: "file:///home/u/notes.md\r\n",
			want: []droppedFile{"/home/u/notes.md"},
		},
		{
			name: "several files keep drag order",
			list: "file:///a.png\r\nfile:///b.pdf\r\nfile:///c.txt\r\n",
			want: []droppedFile{"/a.png", "/b.pdf", "/c.txt"},
		},
		{
			name: "percent escapes are decoded — the path is what the file is called",
			list: "file:///home/u/a%20file%20%231.pdf\r\n",
			want: []droppedFile{"/home/u/a file #1.pdf"},
		},
		{
			name: "comment and blank lines are not paths (RFC 2483 §5)",
			list: "# a comment\r\n\r\nfile:///a.png\r\n",
			want: []droppedFile{"/a.png"},
		},
		{
			name: "a dragged link is not a file",
			list: "https://example.com/page\r\n",
			want: nil,
		},
		{
			name: "localhost is this machine; another host is a share we cannot read",
			list: "file://localhost/a.png\r\nfile://fileserver/share/b.png\r\n",
			want: []droppedFile{"/a.png"},
		},
		{
			name: "a bare path with no scheme names nothing — the format is URIs",
			list: "/home/u/notes.md\r\n",
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := uriList(tc.list).files()
			if len(got) != len(tc.want) {
				t.Fatalf("files() = %q, want %q", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("files()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// The entry a dropped file becomes is the shape the browser's file branch used to
// produce, because it feeds the same paste registry: a data URI carrying the
// bytes, and the ORIGINAL filename in Context — which AttachmentProcessor refuses
// a file without.
func TestDroppedFile_EntryCarriesTheBytesAndTheFilename(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "swagger.yml")
	body := "openapi: 3.0.0\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	entry, ok := droppedFile(path).entry(domain.DefaultMaxAttachmentBytes)
	if !ok {
		t.Fatal("a readable regular file must produce an entry")
	}
	if !strings.HasPrefix(entry.Content, "data:") {
		t.Errorf("content must be a data URI, got %.40q", entry.Content)
	}
	data, err := entry.DecodeDataURI()
	if err != nil || string(data) != body {
		t.Errorf("data URI must carry the file's bytes: %q err=%v", data, err)
	}
	if name, _ := entry.Context["filename"].(string); name != "swagger.yml" {
		t.Errorf("context filename = %q, want swagger.yml", name)
	}
	if strings.HasPrefix(entry.MIMEType, "image/") {
		t.Errorf("a yaml file must not declare itself an image, got %q", entry.MIMEType)
	}
}

// smart-image claims a paste only when BOTH the entry's type and its data URI say
// image/*, so an image that came back text/plain would silently become an
// attachment instead.
func TestDroppedFile_EntryTypesAnImageBothWays(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shot.png")
	png, _ := base64.StdEncoding.DecodeString(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
	if err := os.WriteFile(path, png, 0o644); err != nil {
		t.Fatal(err)
	}

	entry, ok := droppedFile(path).entry(domain.DefaultMaxAttachmentBytes)
	if !ok {
		t.Fatal("a readable png must produce an entry")
	}
	if entry.MIMEType != "image/png" {
		t.Errorf("mime type = %q, want image/png", entry.MIMEType)
	}
	if !strings.HasPrefix(entry.Content, "data:image/png;base64,") {
		t.Errorf("data URI must declare image/png too, got %.30q", entry.Content)
	}
}

// A file with no extension is typed from its bytes, because there is nothing else
// to ask — and the OS hands over plenty of them (CHANGELOG, LICENSE, Makefile).
func TestDroppedFile_ExtensionlessFileIsTypedFromItsBytes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "CHANGELOG")
	if err := os.WriteFile(path, []byte("## 1.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	entry, ok := droppedFile(path).entry(domain.DefaultMaxAttachmentBytes)
	if !ok {
		t.Fatal("an extensionless file must still produce an entry")
	}
	if entry.MIMEType != "text/plain" {
		t.Errorf("mime type = %q, want the sniffed text/plain", entry.MIMEType)
	}
}

// A file too big to hold is SKIPPED WITHOUT BEING READ. The size is asked of the
// filesystem, not of the bytes, which is what keeps a huge drop out of memory —
// the front half of the ceiling the browser used to enforce before Go did the
// reading. AttachmentProcessor's own check remains the backstop, so the two
// halves must name the SAME constant.
//
// Both files here are SPARSE (truncate, never written), so the ceiling is
// exercised at full size for the cost of an inode: a guard that regressed into
// reading first would have to move 25MB to fail this.
func TestDroppedFile_OverTheCeilingIsSkippedWithoutBeingRead(t *testing.T) {
	sparse := func(name string, size int64) droppedFile {
		t.Helper()
		path := filepath.Join(t.TempDir(), name)
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(size); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		return droppedFile(path)
	}

	if _, ok := sparse("huge.pdf", domain.DefaultMaxAttachmentBytes+1).entry(domain.DefaultMaxAttachmentBytes); ok {
		t.Error("a file over the ceiling must produce no entry")
	}
	// The ceiling is a >, not a >=, and this is the pair to the backstop's own
	// boundary test: a file of exactly the limit is within it.
	if _, ok := sparse("big.pdf", domain.DefaultMaxAttachmentBytes).entry(domain.DefaultMaxAttachmentBytes); !ok {
		t.Error("a file of exactly the ceiling must still produce an entry")
	}
}

// A path the drop named but the filesystem does not have is SKIPPED, not fatal:
// the file may have been moved between the drag starting and the drop landing.
func TestDroppedFile_UnreadablePathsProduceNoEntry(t *testing.T) {
	dir := t.TempDir()
	if _, ok := droppedFile(filepath.Join(dir, "gone.pdf")).entry(domain.DefaultMaxAttachmentBytes); ok {
		t.Error("a missing file must produce no entry")
	}
	// A directory is a path the OS will happily put on a drag, and reading one is
	// not an error on every platform.
	if _, ok := droppedFile(dir).entry(domain.DefaultMaxAttachmentBytes); ok {
		t.Error("a directory must produce no entry")
	}
}

// newDropEditor stands up an editor with the real attachment kind registered, so
// a drop's journey is the production one: uri-list → file read → paste match →
// block.
func newDropEditor(t *testing.T) (*EditorService, string) {
	t.Helper()
	resetRegistry()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	svc := block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, dir)}
	block.RegisterProcessor(processors.NewAttachmentProcessor(svc))

	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetServices(svc)
	es.SetLifecycleListener(&mockLifecycleListener{})
	doc, _ := ds.New()
	doc.SetBody([]byte(""))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { waitJobs(t, es, uuid) })
	return es, uuid
}

// writeDropped writes a file into a temp dir and returns its file: URI.
func writeDropped(t *testing.T, name, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return "file://" + path
}

// A drop of several files becomes several blocks, in drag order, starting at the
// index the drop landed on.
func TestHandleNativeDrop_OneBlockPerFileInDragOrder(t *testing.T) {
	es, uuid := newDropEditor(t)

	list := strings.Join([]string{
		writeDropped(t, "first.yml", "openapi: 3.0.0"),
		writeDropped(t, "second.pdf", "%PDF-1.4 second"),
	}, "\r\n") + "\r\n"

	res := es.HandleNativeDrop(uuid, []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: list},
	}, 0)

	if !res.IsBlock() {
		t.Fatalf("a drop that created blocks must report the block outcome, got %q", res.Outcome)
	}
	// Several blocks, so none is named — the caret anchor has no single block to be
	// consumed against, exactly as a slice paste answers.
	if res.ID != "" || res.Kind != "" {
		t.Errorf("a multi-file drop must name no block, got %+v", res)
	}

	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 2 {
		t.Fatalf("want one block per dropped file, got %d: %+v", len(blocks), blocks)
	}
	for i, want := range []string{"first.yml", "second.pdf"} {
		if blocks[i].Kind != "attachment" {
			t.Errorf("block %d kind = %q, want attachment", i, blocks[i].Kind)
		}
		if title, _ := blocks[i].Attrs["title"].(string); title != want {
			t.Errorf("block %d title = %q, want %q (drag order)", i, title, want)
		}
	}
}

// A negative index APPENDS, the same normalisation every other create path makes,
// so a drop below the last block does not land at the top of the document.
func TestHandleNativeDrop_NegativeIndexAppends(t *testing.T) {
	es, uuid := newDropEditor(t)
	first := writeDropped(t, "first.yml", "openapi: 3.0.0")
	if res := es.HandleNativeDrop(uuid, []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: first + "\r\n"},
	}, 0); !res.IsBlock() {
		t.Fatalf("setup drop failed: %q", res.Outcome)
	}

	second := writeDropped(t, "second.yml", "openapi: 3.1.0")
	if res := es.HandleNativeDrop(uuid, []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: second + "\r\n"},
	}, -1); !res.IsBlock() {
		t.Fatalf("append drop failed: %q", res.Outcome)
	}

	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	if title, _ := blocks[1].Attrs["title"].(string); title != "second.yml" {
		t.Errorf("appended block title = %q, want second.yml (appended last)", title)
	}
}

// One unreadable file among several does not cost the others their drop.
func TestHandleNativeDrop_SkipsUnreadableFiles(t *testing.T) {
	es, uuid := newDropEditor(t)

	list := strings.Join([]string{
		"file://" + filepath.Join(t.TempDir(), "gone.pdf"),
		writeDropped(t, "here.yml", "openapi: 3.0.0"),
	}, "\r\n") + "\r\n"

	if res := es.HandleNativeDrop(uuid, []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: list},
	}, 0); !res.IsBlock() {
		t.Fatalf("the readable file must still land, got %q", res.Outcome)
	}
	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 1 {
		t.Fatalf("want the one readable file's block, got %d: %+v", len(blocks), blocks)
	}
	if title, _ := blocks[0].Attrs["title"].(string); title != "here.yml" {
		t.Errorf("block title = %q, want here.yml", title)
	}
}

// A drop naming nothing readable does NOTHING, which is the outcome that tells
// the frontend to leave the caret's empty paragraph where it is.
func TestHandleNativeDrop_NothingReadableIsNothing(t *testing.T) {
	es, uuid := newDropEditor(t)

	cases := map[string]string{
		"a dragged link":      "https://example.com/page\r\n",
		"a vanished file":     "file://" + filepath.Join(t.TempDir(), "gone.pdf") + "\r\n",
		"an empty uri-list":   "",
		"a comment-only list": "# nothing here\r\n",
	}
	for name, list := range cases {
		t.Run(name, func(t *testing.T) {
			res := es.HandleNativeDrop(uuid, []block.ContentEntry{
				{MIMEType: "text/uri-list", Content: list},
			}, 0)
			if res.Outcome != block.OutcomeNothing {
				t.Errorf("outcome = %q, want nothing", res.Outcome)
			}
		})
	}
	if got := len(es.shadows[uuid].SnapshotBlocks()); got != 0 {
		t.Errorf("nothing readable must create no blocks, got %d", got)
	}
}

// A drop for a document nobody has open is refused rather than panicking on a nil
// shadow — a socket can outlive the editor that owned it.
func TestHandleNativeDrop_UnopenedDocumentIsNothing(t *testing.T) {
	es, _ := newDropEditor(t)
	res := es.HandleNativeDrop("no-such-uuid", []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: writeDropped(t, "a.yml", "x: 1") + "\r\n"},
	}, 0)
	if res.Outcome != block.OutcomeNothing {
		t.Errorf("outcome = %q, want nothing", res.Outcome)
	}
}

// The html lens is WebKitGTK's ONE readable drop flavour (#86): the drag's file
// URIs arrive as anchor hrefs inside styled markup, entity-encoded. Extraction
// follows uri-list rules — local file: URIs only, document order.
func TestDropMarkup_ExtractsLocalFileURIs(t *testing.T) {
	cases := []struct {
		name string
		html string
		want []droppedFile
	}{
		{
			// The MEASURED WebKitGTK shape: style-only anchor, URI as TEXT, no href.
			name: "the URI as anchor text with no href at all",
			html: `<a style="caret-color: rgb(0, 0, 0); color: rgb(0, 0, 0); font-weight: 400;">file:///home/stephen/Documents/rainfall_tracking.yaml</a>`,
			want: []droppedFile{"/home/stephen/Documents/rainfall_tracking.yaml"},
		},
		{
			name: "one styled anchor, double quotes",
			html: `<a style="caret-color: rgb(0, 0, 0); color: rgb(0, 0, 238);" href="file:///home/u/report.pdf">report.pdf</a>`,
			want: []droppedFile{"/home/u/report.pdf"},
		},
		{
			name: "several anchors keep drag order",
			html: `<a href="file:///a.png">a</a> <a href='file:///b.pdf'>b</a>`,
			want: []droppedFile{"/a.png", "/b.pdf"},
		},
		{
			name: "percent escapes decode and &amp; means &",
			html: `<a href="file:///home/u/a%20file.pdf?x=1&amp;y=2">a file</a>`,
			want: []droppedFile{"/home/u/a file.pdf"},
		},
		{
			name: "a dragged browser link is not a file",
			html: `<a href="https://example.com/page">Example</a>`,
			want: nil,
		},
		{
			name: "markup with no anchors names nothing",
			html: `<p>just prose</p>`,
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dropMarkup(tc.html).files()
			if len(got) != len(tc.want) {
				t.Fatalf("files() = %q, want %q", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("files()[%d] = %q, want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// The frame may carry the html lens instead of a uri-list, and the ingestion
// treats them identically from that point on.
func TestHandleNativeDrop_HTMLEntryReachesTheSameIngestion(t *testing.T) {
	es, uuid := newDropEditor(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(path, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	res := es.HandleNativeDrop(uuid, []block.ContentEntry{
		{MIMEType: "text/html", Content: `<a href="file://` + path + `">notes.txt</a>`},
	}, 0)
	if res.Outcome != block.OutcomeBlock {
		t.Fatalf("outcome = %q, want block", res.Outcome)
	}
}

// The bucket redeem: a frame with NO readable entries means "the drop happened,
// the page could read none of it — GTK caught the paths" (#86). Same ethos as
// the empty-clipboard paste, one gesture over.
type fakeDropBucket struct{ paths []string }

func (f *fakeDropBucket) TakeDrop(time.Duration) []string { return f.paths }

func TestHandleNativeDrop_EmptyEntriesRedeemTheNativeBucket(t *testing.T) {
	es, uuid := newDropEditor(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(path, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	es.SetPendingDrops(&fakeDropBucket{paths: []string{path}})

	res := es.HandleNativeDrop(uuid, nil, 0)
	if res.Outcome != block.OutcomeBlock {
		t.Fatalf("outcome = %q, want block", res.Outcome)
	}
}

func TestHandleNativeDrop_EmptyEntriesEmptyBucketIsNothing(t *testing.T) {
	es, uuid := newDropEditor(t)
	es.SetPendingDrops(&fakeDropBucket{})
	if res := es.HandleNativeDrop(uuid, nil, 0); res.Outcome != block.OutcomeNothing {
		t.Fatalf("outcome = %q, want nothing", res.Outcome)
	}
}

// Entries that DID name files win over the bucket — the fast path for platforms
// whose webview can read its own drops.
func TestHandleNativeDrop_ReadableEntriesSkipTheBucket(t *testing.T) {
	es, uuid := newDropEditor(t)
	dir := t.TempDir()
	real := filepath.Join(dir, "real.txt")
	if err := os.WriteFile(real, []byte("real\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	decoy := filepath.Join(dir, "decoy.txt")
	if err := os.WriteFile(decoy, []byte("decoy\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	es.SetPendingDrops(&fakeDropBucket{paths: []string{decoy}})

	res := es.HandleNativeDrop(uuid, []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: "file://" + real + "\r\n"},
	}, 0)
	if res.Outcome != block.OutcomeBlock {
		t.Fatalf("outcome = %q, want block", res.Outcome)
	}
}
