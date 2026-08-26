package requesthandlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/services"
)

// A native drop's frame carries ONLY the index: the paths come from the native
// drop bucket the OS-level catch fed (Wails OnFileDrop), and the page's view of
// a drop is never consulted. Multi-file drags arrive as one callback, so several
// files are one gesture, one frame, several blocks.
//
// The block still arrives the way every other created block does — an
// insert-block render-back — so this pins the ACK, which is what tells the
// surface whether to consume the caret's empty-paragraph anchor.
func TestWS_NativeDrop_ReadsTheFilesAndMakesBlocks(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	block.RegisterProcessor(processors.NewReferenceProcessor(block.BlockServices{
		Documents: sp.Documents, Assets: services.NewAssetService(sp.Store, ""),
	}))
	t.Cleanup(func() { block.UnregisterProcessor("reference") })

	dir := t.TempDir()
	var paths []string
	for _, name := range []string{"swagger.yml", "notes.txt"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("dropped "+name), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	sp.Editor.SetPendingDrops(&wsFakeDropBucket{paths: paths})

	c := dialWS(t, srv, uuid)
	frame, err := json.Marshal(map[string]interface{}{
		"type": "paste", "opId": "op-drop", "kind": "native-drop", "index": 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	send(t, c, string(frame))

	ack := readUntil(t, c, "paste-ack", 2*time.Second)
	if ack["opId"] != "op-drop" {
		t.Errorf("opId = %v, want op-drop", ack["opId"])
	}
	// A drop can create several blocks and so names none of them, exactly as a
	// slice paste answers: there is no single block for the caret anchor to be
	// consumed against.
	if ack["outcome"] != "block" {
		t.Fatalf("outcome = %v, want block (%v)", ack["outcome"], ack)
	}
	if ack["id"] != nil && ack["id"] != "" {
		t.Errorf("a multi-file drop must name no block, got id=%v", ack["id"])
	}

	closeAndSettle(c)

	// The files reached the document, in drag order and under their own names.
	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	body := string(doc.Body())
	first, second := strings.Index(body, "swagger.yml"), strings.Index(body, "notes.txt")
	if first < 0 || second < 0 {
		t.Fatalf("both dropped files must be in the document, got:\n%s", body)
	}
	if first > second {
		t.Errorf("blocks must land in drag order, got:\n%s", body)
	}
}

// wsFakeDropBucket stands in for nativedrop.Default so the route is testable
// without a real GTK drop.
type wsFakeDropBucket struct{ paths []string }

func (f *wsFakeDropBucket) TakeDrop(time.Duration) []string { return f.paths }

// An unredeemable drop answers `none`, which is what leaves the caret's empty
// paragraph alone. It must not be an error frame: nothing failed — the bucket
// simply held no file this machine has.
func TestWS_NativeDrop_NothingReadableIsNothing(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	sp.Editor.SetPendingDrops(&wsFakeDropBucket{paths: []string{filepath.Join(t.TempDir(), "gone.pdf")}})

	c := dialWS(t, srv, uuid)
	frame, err := json.Marshal(map[string]interface{}{
		"type": "paste", "opId": "op-drop", "kind": "native-drop", "index": 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	send(t, c, string(frame))

	ack := readUntil(t, c, "paste-ack", 2*time.Second)
	if ack["outcome"] != "none" {
		t.Errorf("outcome = %v, want none (%v)", ack["outcome"], ack)
	}
	if e, _ := ack["error"].(string); e != "" {
		t.Errorf("a drop of nothing readable is not an error, got %q", e)
	}
	closeAndSettle(c)
}
