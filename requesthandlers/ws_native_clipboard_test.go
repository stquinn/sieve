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

// stubClipboard stands in for the GTK reader, which cannot run here: it needs a
// desktop, and the suite builds with cgo off.
type stubClipboard struct{ entries []block.ContentEntry }

func (c stubClipboard) Entries() ([]block.ContentEntry, error) { return c.entries, nil }

// A native-clipboard paste is the one paste kind that carries NO payload: the
// page's DataTransfer was empty, which is the whole signal, so the frame says
// only where the caret is and the server reads the OS clipboard itself.
//
// The block still arrives the way every created block does, over an insert-block
// render-back, so this pins the ACK: what tells the surface whether to consume
// the caret's empty-paragraph anchor.
func TestWS_NativeClipboard_ReadsTheClipboardAndMakesABlock(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	block.RegisterProcessor(processors.NewReferenceProcessor(block.BlockServices{
		Documents: sp.Documents, Assets: services.NewAssetService(sp.Store, ""),
	}))
	t.Cleanup(func() { block.UnregisterProcessor("reference") })

	path := filepath.Join(t.TempDir(), "swagger.yml")
	if err := os.WriteFile(path, []byte("openapi: 3.0.0"), 0o644); err != nil {
		t.Fatal(err)
	}
	sp.Editor.SetNativeClipboard(stubClipboard{entries: []block.ContentEntry{
		{MIMEType: "text/uri-list", Content: "file://" + path + "\r\n"},
	}})

	c := dialWS(t, srv, uuid)
	frame, err := json.Marshal(map[string]interface{}{
		"type": "paste", "opId": "op-clip", "kind": "native-clipboard",
	})
	if err != nil {
		t.Fatal(err)
	}
	send(t, c, string(frame))

	ack := readUntil(t, c, "paste-ack", 2*time.Second)
	if ack["opId"] != "op-clip" {
		t.Errorf("opId = %v, want op-clip", ack["opId"])
	}
	if ack["outcome"] != "block" {
		t.Fatalf("outcome = %v, want block (%v)", ack["outcome"], ack)
	}

	closeAndSettle(c)

	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(doc.Body()), "swagger.yml") {
		t.Fatalf("the copied file must be in the document, got:\n%s", doc.Body())
	}
}

// A clipboard holding nothing this reader can use answers `none`, which is what
// leaves the caret's empty paragraph alone. It must not be an error frame:
// nothing failed — there was simply nothing to paste.
func TestWS_NativeClipboard_NothingUsableIsNothing(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	sp.Editor.SetNativeClipboard(stubClipboard{})

	c := dialWS(t, srv, uuid)
	frame, err := json.Marshal(map[string]interface{}{
		"type": "paste", "opId": "op-clip", "kind": "native-clipboard",
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
		t.Errorf("an empty clipboard is not an error, got %q", e)
	}
	closeAndSettle(c)
}
