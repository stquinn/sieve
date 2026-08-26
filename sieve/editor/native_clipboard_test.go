package editor

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
)

// fakeClipboard is what a desktop clipboard looks like to this package: one
// offer, or an error. The real reader is cgo over GTK and cannot run in a test
// (there is no display, and the suite builds with cgo off), which is the whole
// reason the port exists.
type fakeClipboard struct {
	entries []block.ContentEntry
	err     error
	reads   int
}

func (c *fakeClipboard) Entries() ([]block.ContentEntry, error) {
	c.reads++
	return c.entries, c.err
}

// fakeImageKind claims an image paste and nothing else. It stands in for
// smart-image so this file tests the ROUTING — an image offer takes the ordinary
// paste path, at the index it was given — without dragging in smart-image's AI
// describe job. That the REAL kind claims the reader's entry shape is pinned
// separately, by TestNativeClipboard_SmartImageClaimsTheReadersEntry.
type fakeImageKind struct {
	block.FencedSerializer
	block.FencedDeserializer
}

func newFakeImageKind() *fakeImageKind {
	return &fakeImageKind{FencedDeserializer: block.FencedDeserializer{Kind: "fake-image"}}
}

func (p *fakeImageKind) Kind() string          { return p.FencedDeserializer.Kind }
func (p *fakeImageKind) Mode() block.BlockMode { return block.BlockModeBlock }

func (p *fakeImageKind) InitAttrs(id string, overrides map[string]interface{}) map[string]interface{} {
	attrs := map[string]interface{}{"id": id, "status": block.BlockStatusComplete}
	for k, v := range overrides {
		attrs[k] = v
	}
	return attrs
}

func (p *fakeImageKind) IsSupportedContent(entries []block.ContentEntry) block.SupportedActions {
	for _, e := range entries {
		if strings.HasPrefix(e.MIMEType, "image/") && strings.HasPrefix(e.Content, "data:image/") {
			return block.SupportedActions{Kind: p.Kind(), Actions: []block.Action{block.ActionPaste}}
		}
	}
	return block.SupportedActions{Kind: p.Kind()}
}

func (p *fakeImageKind) Transform(entries []block.ContentEntry, _ string, _ string, _ block.Action) map[string]interface{} {
	return map[string]interface{}{"src": entries[0].Content}
}

func (p *fakeImageKind) BuildContext(_ block.SieveBlock, _ block.DocView, _ map[string]bool) block.AIContext {
	return block.AIContext{}
}
func (p *fakeImageKind) MarkdownRepresentation(_ block.SieveBlock, _ string) string { return "" }
func (p *fakeImageKind) OnChange(_ *block.SieveBlock)                               {}
func (p *fakeImageKind) DescribeJob(_ block.JobContext) *block.ProcessorJob         { return nil }

// onePixelPNG is the smallest thing that is unambiguously a PNG, in the shape the
// GTK reader hands it over: a data URI.
func onePixelPNG(t *testing.T) block.ContentEntry {
	t.Helper()
	png, err := base64.StdEncoding.DecodeString(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
	if err != nil {
		t.Fatal(err)
	}
	return block.ContentEntry{
		MIMEType: "image/png",
		Content:  "data:image/png;base64," + base64.StdEncoding.EncodeToString(png),
	}
}

// The entry the reader produces has to be one the real image kind CLAIMS, and
// smart-image demands image/* of BOTH halves — the mime type and the data URI.
// A reader that answered "application/octet-stream", or handed over raw bytes
// instead of a data URI, would compile, ship, and quietly make references out of
// every screenshot.
func TestNativeClipboard_SmartImageClaimsTheReadersEntry(t *testing.T) {
	entries := []block.ContentEntry{onePixelPNG(t)}
	if !processors.NewSmartImageProcessor(block.BlockServices{}).
		IsSupportedContent(entries).Has(block.ActionPaste) {
		t.Fatalf("smart-image must claim the clipboard reader's image entry: %+v", entries[0])
	}
}

// A screenshot on the clipboard becomes a block at the caret's index, read from
// the OS because WebKitGTK hands the page an empty DataTransfer.
func TestHandleNativeClipboard_ImageTakesTheOrdinaryPastePath(t *testing.T) {
	es, uuid := newClipboardEditor(t)
	clip := &fakeClipboard{entries: []block.ContentEntry{onePixelPNG(t)}}
	es.SetNativeClipboard(clip)

	res := es.HandleNativeClipboard(uuid, 0)

	if !res.IsBlock() {
		t.Fatalf("a clipboard image must create a block, got %q", res.Outcome)
	}
	// An image is ONE block, so unlike a multi-file drop it names itself — which is
	// what lets the surface consume the caret's empty-paragraph anchor against it.
	if res.Kind != "fake-image" {
		t.Errorf("kind = %q, want the image kind the registry claimed it for", res.Kind)
	}
	if res.ID == "" {
		t.Error("a single created block must name itself")
	}
	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 1 || blocks[0].Kind != "fake-image" {
		t.Fatalf("want one image block, got %+v", blocks)
	}
	// The bytes reached the processor: the reader's data URI, not a path or a
	// placeholder.
	if src, _ := blocks[0].Attrs["src"].(string); !strings.HasPrefix(src, "data:image/png;base64,") {
		t.Errorf("src = %.30q, want the clipboard's data URI", src)
	}
	if clip.reads != 1 {
		t.Errorf("clipboard read %d times, want exactly 1", clip.reads)
	}
}

// The index is the caret's, not an append: a paste lands where the user is.
func TestHandleNativeClipboard_ImageLandsAtTheGivenIndex(t *testing.T) {
	es, uuid := newClipboardEditor(t)
	es.SetNativeClipboard(&fakeClipboard{entries: []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: writeDropped(t, "first.yml", "openapi: 3.0.0") + "\r\n"},
	}})
	if res := es.HandleNativeClipboard(uuid, 0); !res.IsBlock() {
		t.Fatalf("setup paste failed: %q", res.Outcome)
	}

	es.SetNativeClipboard(&fakeClipboard{entries: []block.ContentEntry{onePixelPNG(t)}})
	if res := es.HandleNativeClipboard(uuid, 0); !res.IsBlock() {
		t.Fatalf("image paste failed: %q", res.Outcome)
	}

	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 2 {
		t.Fatalf("want 2 blocks, got %d", len(blocks))
	}
	if blocks[0].Kind != "fake-image" {
		t.Errorf("block 0 kind = %q, want the image pasted at index 0", blocks[0].Kind)
	}
}

// A copied FILE takes the same ingestion a dropped file does — paths off the
// uri-list, the attachment ceiling, one block per file. The gesture differs; what
// the clipboard names does not.
func TestHandleNativeClipboard_CopiedFilesTakeTheDropIngestion(t *testing.T) {
	es, uuid := newClipboardEditor(t)
	list := strings.Join([]string{
		writeDropped(t, "first.yml", "openapi: 3.0.0"),
		writeDropped(t, "second.pdf", "%PDF-1.4 second"),
	}, "\r\n") + "\r\n"
	es.SetNativeClipboard(&fakeClipboard{entries: []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: list},
	}})

	if res := es.HandleNativeClipboard(uuid, 0); !res.IsBlock() {
		t.Fatalf("copied files must create blocks, got %q", res.Outcome)
	}
	blocks := es.shadows[uuid].SnapshotBlocks()
	if len(blocks) != 2 {
		t.Fatalf("want one block per copied file, got %d: %+v", len(blocks), blocks)
	}
	for i, want := range []string{"first.yml", "second.pdf"} {
		if blocks[i].Kind != "reference" {
			t.Errorf("block %d kind = %q, want reference", i, blocks[i].Kind)
		}
		if title := refTitle(blocks[i].Attrs); title != want {
			t.Errorf("block %d title = %q, want %q (copy order)", i, title, want)
		}
	}
}

// The stat ceiling is the drop path's, and it must still hold for a copy: it is
// what keeps a file too big to hold out of memory ENTIRELY, and a second route
// into the same ingestion must not become a way around it.
func TestHandleNativeClipboard_CopiedFileOverTheCeilingIsSkipped(t *testing.T) {
	es, uuid := newClipboardEditor(t)
	path := filepath.Join(t.TempDir(), "huge.pdf")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	// SPARSE: the ceiling is exercised at full size for the cost of an inode.
	if err := f.Truncate(domain.DefaultMaxAttachmentBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	es.SetNativeClipboard(&fakeClipboard{entries: []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: "file://" + path + "\r\n"},
	}})

	if res := es.HandleNativeClipboard(uuid, 0); res.Outcome != block.OutcomeNothing {
		t.Errorf("outcome = %q, want nothing", res.Outcome)
	}
	if got := len(es.shadows[uuid].SnapshotBlocks()); got != 0 {
		t.Errorf("a file over the ceiling must create no block, got %d", got)
	}
}

// Every way of holding nothing answers the SAME thing, and none of them is an
// error: `none` is what leaves the caret's empty paragraph where it is. A read
// that timed out reaches here as an empty answer for exactly this reason.
func TestHandleNativeClipboard_NothingUsableIsNothing(t *testing.T) {
	cases := map[string]NativeClipboardPort{
		"an empty or timed-out read": &fakeClipboard{},
		"a read that failed":         &fakeClipboard{err: errors.New("gdk selection cancelled")},
		"no reader at all (cgo off)": nil,
	}
	for name, clip := range cases {
		t.Run(name, func(t *testing.T) {
			es, uuid := newClipboardEditor(t)
			es.SetNativeClipboard(clip)
			if res := es.HandleNativeClipboard(uuid, 0); res.Outcome != block.OutcomeNothing {
				t.Errorf("outcome = %q, want nothing", res.Outcome)
			}
			if got := len(es.shadows[uuid].SnapshotBlocks()); got != 0 {
				t.Errorf("nothing usable must create no blocks, got %d", got)
			}
		})
	}
}

// A paste for a document nobody has open is refused rather than panicking on a
// nil shadow — a socket can outlive the editor that owned it.
func TestHandleNativeClipboard_UnopenedDocumentIsNothing(t *testing.T) {
	es, _ := newClipboardEditor(t)
	es.SetNativeClipboard(&fakeClipboard{entries: []block.ContentEntry{onePixelPNG(t)}})
	if res := es.HandleNativeClipboard("no-such-uuid", 0); res.Outcome != block.OutcomeNothing {
		t.Errorf("outcome = %q, want nothing", res.Outcome)
	}
}

// newClipboardEditor stands up the drop editor (real reference kind, so a copied
// file's journey is the production one) plus an image kind for the other branch.
func newClipboardEditor(t *testing.T) (*EditorService, string) {
	t.Helper()
	es, uuid := newDropEditor(t)
	block.RegisterProcessor(newFakeImageKind())
	return es, uuid
}
