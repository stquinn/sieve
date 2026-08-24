package editor

import (
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/block"
)

// A block born in a lens carries its DURABLE id from the keystroke that made it
// (issue #96): a UUIDv7 needs no coordination, so the client can name the block
// and Go's job on that path is to VALIDATE rather than to mint. These pin the
// three answers the validator can give — adopt, refuse malformed, refuse taken —
// and the fact that a refusal changes nothing.

func openSeeded(t *testing.T) (*EditorService, string) {
	t.Helper()
	resetRegistry()
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody(nil)
	doc, _ = ds.Save(doc)
	if err := es.Open(doc.UUID()); err != nil {
		t.Fatalf("Open: %v", err)
	}
	return es, doc.UUID()
}

func TestCreateBlock_adoptsAClientMintedID(t *testing.T) {
	es, uuid := openSeeded(t)
	id := ident.New()

	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: id,
		Attrs: map[string]interface{}{"content": "typed in the editor"}, Index: 0,
	}); err != nil {
		t.Fatalf("create with a client id: %v", err)
	}

	blk := frontendBlockByID(t, es, uuid, id)
	if blk.ID != id {
		t.Fatalf("block.ID = %q, want the client's %q", blk.ID, id)
	}
	// The both-places rule: the WYSIWYG wire and the fenced serializer read
	// identity out of Attrs, so an adopted id has to land there too.
	if got, _ := blk.Attrs["id"].(string); got != id {
		t.Fatalf("Attrs[\"id\"] = %q, want %q — the id must live in BOTH places", got, id)
	}
	if got, _ := blk.Attrs["content"].(string); got != "typed in the editor" {
		t.Fatalf("content = %q, want the client's", got)
	}
}

func TestCreateBlock_stillMintsWhenTheClientNamesNothing(t *testing.T) {
	es, uuid := openSeeded(t)

	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose",
		Attrs: map[string]interface{}{"content": "server-born"}, Index: 0,
	}); err != nil {
		t.Fatalf("create with no id: %v", err)
	}
	ids := frontendIDs(t, es, uuid)
	if len(ids) != 1 || !ident.Valid(ids[0]) {
		t.Fatalf("server mint produced %v, want one valid uuid", ids)
	}
}

func TestCreateBlock_refusesAMalformedClientID(t *testing.T) {
	es, uuid := openSeeded(t)

	for _, bad := range []string{"pr-1", "not-a-uuid", "0000", strings.Repeat("a", 36)} {
		err := es.HandleBlockOp(uuid, block.BlockOp{
			Type: "create-block", Kind: "prose", BlockID: bad,
			Attrs: map[string]interface{}{"content": "x"}, Index: 0,
		})
		if err == nil {
			t.Fatalf("create accepted the malformed id %q", bad)
		}
		// A refusal, never a correction: substituting an id would leave the client
		// addressing a block that no longer answers to the name it gave.
		if ids := frontendIDs(t, es, uuid); len(ids) != 0 {
			t.Fatalf("a refused create still changed the document: %v", ids)
		}
	}
}

func TestCreateBlock_refusesAnIDTheDocumentAlreadyHolds(t *testing.T) {
	es, uuid := openSeeded(t)
	id := ident.New()

	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: id,
		Attrs: map[string]interface{}{"content": "first"}, Index: 0,
	}); err != nil {
		t.Fatalf("first create: %v", err)
	}
	err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: id,
		Attrs: map[string]interface{}{"content": "second"}, Index: 1,
	})
	if err == nil {
		t.Fatal("create accepted an id the document already holds — two blocks would merge under one name")
	}
	if ids := frontendIDs(t, es, uuid); len(ids) != 1 {
		t.Fatalf("the refused duplicate still landed: %v", ids)
	}
	blk := frontendBlockByID(t, es, uuid, id)
	if got, _ := blk.Attrs["content"].(string); got != "first" {
		t.Fatalf("the duplicate overwrote the original: content = %q", got)
	}
}

func TestCreateBlock_aClientIDSurvivesTheSaveRoundTrip(t *testing.T) {
	resetRegistry()
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	doc, _ := ds.New()
	doc.SetBody(nil)
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	id := ident.New()
	if err := es.HandleBlockOp(uuid, block.BlockOp{
		Type: "create-block", Kind: "prose", BlockID: id,
		Attrs: map[string]interface{}{"content": "round trip"}, Index: 0,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := es.Flush(uuid); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	saved, err := ds.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	// The id the LENS chose is the handle on disk — the whole point of letting it
	// choose, and what makes the create's echo need no resolution step.
	if body := string(saved.Body()); !strings.Contains(body, "<!--s:"+id+"-->") {
		t.Fatalf("the client's id is not the handle on disk:\n%s", body)
	}
}
