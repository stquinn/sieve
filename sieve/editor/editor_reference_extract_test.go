package editor

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/store"
)

// A held file whose EXTENSION says only "text" and whose CONTENT is unmistakably
// Go: recognition on this path reads the bytes, never the file name.
const heldGo = "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n"

// stubAssets is the read half of AssetService: a held file's bytes keyed by the
// name the block stores in src. The document uuid is ignored so a fixture can be
// wired before the document it belongs to exists.
type stubAssets struct{ files map[string][]byte }

func (s stubAssets) Save(store.Category, string, string, []byte) (*domain.ImageAsset, error) {
	return nil, errors.New("stubAssets: writes are not part of this test")
}

func (s stubAssets) ServeAssetData(_, filename string) ([]byte, error) {
	if b, ok := s.files[filename]; ok {
		return b, nil
	}
	return nil, errors.New("stubAssets: no such asset " + filename)
}

// newEditorHoldingFile opens a document whose only block is a reference HOLDING
// filename, and returns the service, the document uuid and the block id.
//
// It is created with the attrs a DROP produces — the address plus the face those
// same bytes describe — because that is the only gesture that makes a held file.
// A bare coordinate would be a POINTER: no `mime` would be stamped, and without
// one the block hands over nothing and every offer below is empty.
func newEditorHoldingFile(t *testing.T, filename string, data []byte) (*EditorService, string, string) {
	t.Helper()
	resetRegistry()
	assets := block.BlockServices{Assets: stubAssets{files: map[string][]byte{filename: data}}}
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewReferenceProcessor(assets))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	doc, _ := ds.New()
	doc.SetBody([]byte(""))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { waitJobs(t, es, uuid) })

	id, _, err := es.CreateBlock(uuid, "reference", map[string]interface{}{
		"uri":   domain.NewLeafAddress(uuid, filename).String(),
		"title": filename,
		"mime":  "text/plain",
		"bytes": strconv.Itoa(len(data)),
	}, -1)
	if err != nil {
		t.Fatalf("CreateBlock(reference): %v", err)
	}
	return es, uuid, id
}

// referenceEntries is the ContentEntry array the frontend sends for a reference
// source: the framework's universal sieve/<kind> view of its attrs, and nothing
// else — a held file has no text form on the client at all.
func referenceEntries(t *testing.T, es *EditorService, uuid, blockID string) []block.ContentEntry {
	t.Helper()
	blk, ok := es.shadows[uuid].SnapshotBlock(blockID)
	if !ok {
		t.Fatalf("reference %q not in shadow", blockID)
	}
	payload, err := json.Marshal(blk.Attrs)
	if err != nil {
		t.Fatalf("marshal attrs: %v", err)
	}
	return []block.ContentEntry{{MIMEType: "sieve/reference", Content: string(payload)}}
}

func offerFor(offers []block.SupportedActions, kind string) (block.SupportedActions, bool) {
	for _, o := range offers {
		if o.Kind == kind {
			return o, true
		}
	}
	return block.SupportedActions{}, false
}

func TestDetectExtractions_referenceHoldingCode_offersCodeExtract(t *testing.T) {
	es, uuid, blockID := newEditorHoldingFile(t, "snippet.txt", []byte(heldGo))

	offers := es.DetectExtractions(uuid, "reference", referenceEntries(t, es, uuid, blockID))

	code, ok := offerFor(offers, "code")
	if !ok {
		t.Fatalf("a reference holding recognisable code must offer the code kind; offers=%v", offers)
	}
	if !code.Has(block.ActionExtract) {
		t.Errorf("the code offer must be an EXTRACT; got %v", code.Actions)
	}
	// The reference is the file's provenance: replacing it with the extracted code
	// would delete the very thing the code was read out of.
	if code.Has(block.ActionTransform) {
		t.Errorf("an offer built from HELD content must never be an in-place TRANSFORM; got %v", code.Actions)
	}
}

// Demotion is per-offer, not blanket: prose's "Embed in Document" stands on the
// reference's own view, so it keeps its in-place transform.
func TestDetectExtractions_referenceHoldingCode_leavesUnheldOffersInPlace(t *testing.T) {
	es, uuid, blockID := newEditorHoldingFile(t, "snippet.txt", []byte(heldGo))

	offers := es.DetectExtractions(uuid, "reference", referenceEntries(t, es, uuid, blockID))

	prose, ok := offerFor(offers, "prose")
	if !ok {
		t.Fatalf("prose is the universal sink and must still be offered; offers=%v", offers)
	}
	if !prose.Has(block.ActionTransform) {
		t.Errorf("prose's offer does not rest on held content and must keep TRANSFORM; got %v", prose.Actions)
	}
}

// The fixture carries the SAME recognisable source as the positive case behind PNG
// magic bytes, so the only thing standing between it and a code offer is the
// text-format guard.
func TestDetectExtractions_binaryReference_offersNoCode(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), []byte(heldGo)...)
	es, uuid, blockID := newEditorHoldingFile(t, "diagram.png", png)

	offers := es.DetectExtractions(uuid, "reference", referenceEntries(t, es, uuid, blockID))

	if code, ok := offerFor(offers, "code"); ok {
		t.Errorf("a binary reference must offer no code extraction; got %v", code.Actions)
	}
}

// Same content as the positive case, only far more of it: size is the sole
// difference between an offer and none.
func TestDetectExtractions_oversizedTextReference_offersNoCode(t *testing.T) {
	big := []byte(strings.Repeat(heldGo, 8000)) // ~500KB, past the editable-content ceiling
	es, uuid, blockID := newEditorHoldingFile(t, "huge.txt", big)

	offers := es.DetectExtractions(uuid, "reference", referenceEntries(t, es, uuid, blockID))

	if code, ok := offerFor(offers, "code"); ok {
		t.Errorf("a file too large to edit as document content must offer no code extraction; got %v", code.Actions)
	}
}

func TestCreateBlockFromEntries_extractCodeFromReference_keepsTheReference(t *testing.T) {
	es, uuid, referenceID := newEditorHoldingFile(t, "snippet.txt", []byte(heldGo))
	entries := referenceEntries(t, es, uuid, referenceID)

	codeID, _, err := es.CreateBlockFromEntries(uuid, "code", entries, 1, block.ActionExtract, referenceID)
	if err != nil {
		t.Fatalf("CreateBlockFromEntries: %v", err)
	}

	blocks := es.shadows[uuid].SnapshotBlocks()
	var order []string
	for _, b := range blocks {
		order = append(order, b.ID)
	}
	if len(order) != 2 || order[0] != referenceID || order[1] != codeID {
		t.Fatalf("extraction is additive: want [reference, code] = [%s %s], got %v", referenceID, codeID, order)
	}

	code, _ := es.shadows[uuid].SnapshotBlock(codeID)
	// CodeBlockProcessor trims its source, as it does for every source it claims.
	if src, _ := code.Attrs["source"].(string); src != strings.TrimSpace(heldGo) {
		t.Errorf("held file must reach the code block verbatim:\n got %q\nwant %q", src, strings.TrimSpace(heldGo))
	}
	if lang, _ := code.Attrs["language"].(string); lang != "go" {
		t.Errorf("language must come from the code kind's own recognition of the bytes; got %q", lang)
	}

	ref, ok := es.shadows[uuid].SnapshotBlock(referenceID)
	if !ok {
		t.Fatal("the reference is the file's provenance and must survive extraction")
	}
	if uri, _ := ref.Attrs["uri"].(string); uri != domain.NewLeafAddress(uuid, "snippet.txt").String() {
		t.Errorf("the surviving reference must still hold its file; uri=%q", uri)
	}
}

// A .sql file. The code kind recognises its contents on their own — nothing on
// this path reads the ".sql" suffix.
const heldSQL = "-- active customers\nSELECT id, name\nFROM customers\nWHERE active = 1;\n"

func TestDetectExtractions_referenceHoldingSQL_offersCodeExtract(t *testing.T) {
	es, uuid, blockID := newEditorHoldingFile(t, "report.sql", []byte(heldSQL))
	entries := referenceEntries(t, es, uuid, blockID)

	code, ok := offerFor(es.DetectExtractions(uuid, "reference", entries), "code")
	if !ok || !code.Has(block.ActionExtract) {
		t.Fatalf("a .sql reference must offer a code extraction; got %v ok=%v", code.Actions, ok)
	}

	codeID, _, err := es.CreateBlockFromEntries(uuid, "code", entries, 1, block.ActionExtract, blockID)
	if err != nil {
		t.Fatalf("CreateBlockFromEntries: %v", err)
	}
	extracted, _ := es.shadows[uuid].SnapshotBlock(codeID)
	if lang, _ := extracted.Attrs["language"].(string); lang != "sql" {
		t.Errorf("language: got %q, want sql", lang)
	}
	if _, survived := es.shadows[uuid].SnapshotBlock(blockID); !survived {
		t.Error("the reference must survive the extraction")
	}
}
