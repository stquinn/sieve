package editor

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// DATA-LOSS GUARD: a failed markdown roundtrip (or a serialize error) yields empty
// content; flushing that must NOT wipe a non-empty file. The user lost data when an
// empty derive was saved over their document.
func TestEditorService_FlushDoesNotWipeNonEmptyDocWithEmptyContent(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte("Important content the user wrote\n\nmore"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Markdown roundtrip fails → buffer ends up empty.
	es.EnterMarkdown(uuid)
	es.UpdateMarkdown(uuid, "")
	_ = es.Flush(uuid)

	saved, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(saved.Body()), "Important content") {
		t.Fatalf("DATA LOSS: empty flush wiped a non-empty doc; on-disk body = %q", string(saved.Body()))
	}
}

// A client that hands back a buffer emptier than the one it was given takes the
// document's whole tree with it: the buffer IS the mode's truth, so enter-wysiwyg
// re-parses it into nothing. Only the flush guard keeps that off disk — the
// condition the enter-wysiwyg WARN reports.
func TestEditorService_EnterWysiwygOverEmptyBufferKeepsTheFileIntact(t *testing.T) {
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte("alpha alpha alpha\n\nbravo bravo"))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}

	es.EnterWysiwyg(uuid) // no markdown was ever handed over: the buffer is empty
	if blocks, ok := es.FrontendBlocks(uuid); !ok || len(blocks) != 0 {
		t.Fatalf("expected the empty buffer to re-parse into no blocks, got %d (ok=%v)", len(blocks), ok)
	}
	_ = es.Flush(uuid)

	saved, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	if !strings.Contains(string(saved.Body()), "alpha alpha alpha") {
		t.Fatalf("DATA LOSS: an empty re-parse reached disk; on-disk body = %q", string(saved.Body()))
	}
}
