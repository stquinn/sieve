package editor

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/png"
	"reflect"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

func TestHandlePaste_stampsSmartPaste_onDetectionOnly(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

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

	// Pass-2 detection: fenced code text (no sieve view) → tagged.
	res := es.HandlePaste(uuid, []block.ContentEntry{
		{MIMEType: "text/plain", Content: "```python\nx = 1\ny = 2\n```"},
	}, -1)
	if !res.IsBlock() {
		t.Fatalf("expected detection paste to create a block, got %q", res.Outcome)
	}
	blk, found := es.shadowFor(uuid).SnapshotBlock(res.ID)
	if !found {
		t.Fatal("block not found in shadow")
	}
	if blk.Attrs["smartPaste"] != true {
		t.Errorf("detected paste must be tagged smartPaste; attrs=%v", blk.Attrs)
	}

	// Pass-1 round-trip: a copied code block's own sieve view → NOT tagged.
	res2 := es.HandlePaste(uuid, []block.ContentEntry{
		{MIMEType: "sieve/code", Content: `{"source":"x = 1\ny = 2","language":"python"}`},
	}, -1)
	if !res2.IsBlock() {
		t.Fatalf("expected round-trip paste to create a block, got %q", res2.Outcome)
	}
	blk2, found2 := es.shadowFor(uuid).SnapshotBlock(res2.ID)
	if !found2 {
		t.Fatal("block2 not found in shadow")
	}
	if blk2.Attrs["smartPaste"] == true {
		t.Errorf("round-trip paste must NOT be tagged smartPaste; attrs=%v", blk2.Attrs)
	}

	// A placement of the same detected content → NOT tagged.
	res3 := es.HandlePlacement(uuid, []block.ContentEntry{
		{MIMEType: "text/plain", Content: "```python\nx = 1\ny = 2\n```"},
	}, -1)
	if !res3.IsBlock() {
		t.Fatalf("expected placement to create a block, got %q", res3.Outcome)
	}
	if blk3, _ := es.shadowFor(uuid).SnapshotBlock(res3.ID); blk3.Attrs["smartPaste"] == true {
		t.Errorf("placement must NOT be tagged smartPaste; attrs=%v", blk3.Attrs)
	}
}

// newTestEditorServiceWithProseBlock creates an EditorService with an open document
// containing a single prose block with id "pr-1" holding a native code fence.
// Modelled on editor_service_promote_test.go's setup.
func newTestEditorServiceWithProseBlock(t *testing.T) (*EditorService, string) {
	t.Helper()
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	es.SetLifecycleListener(&mockLifecycleListener{})

	// A prose block wrapping a native code fence — the classic TRANSFORM source.
	body := "<!--s:pr-1-->\n```go\nx := 0\n```\n<!--/s:pr-1-->"
	doc, _ := ds.New()
	doc.SetBody([]byte(body))
	doc, _ = ds.Save(doc)
	uuid := doc.UUID()
	if err := es.Open(uuid); err != nil {
		t.Fatalf("Open: %v", err)
	}
	// Sync the shadow markdown so the tree reflects the body.
	es.UpdateMarkdown(uuid, body)
	// Drain any background jobs before TempDir cleanup.
	t.Cleanup(func() { waitJobs(t, es, uuid) })
	return es, uuid
}

func TestCreateBlockFromEntries_transform_replacesInPlace(t *testing.T) {
	es, uuid := newTestEditorServiceWithProseBlock(t)
	// TRANSFORM the prose block "pr-1" into a code block.
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	id, _, err := es.CreateBlockFromEntries(uuid, "code", entries, block.ActionTransform, "pr-1")
	if err != nil {
		t.Fatalf("transform failed: %v", err)
	}
	blk, found := es.shadowFor(uuid).SnapshotBlock(id)
	if !found || blk.Kind != "code" {
		t.Fatalf("expected code block in place, found=%v blk=%+v", found, blk)
	}
	if _, stillThere := es.shadowFor(uuid).SnapshotBlock("pr-1"); stillThere && id != "pr-1" {
		t.Fatalf("source pr-1 should have been replaced, not survive alongside")
	}
}

func TestCreateBlockFromEntries_extract_isAdditive(t *testing.T) {
	es, uuid := newTestEditorServiceWithProseBlock(t)
	before := len(es.shadowFor(uuid).SnapshotBlocks())
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: "```go\nx := 1\n```"}}
	_, _, err := es.CreateBlockFromEntries(uuid, "code", entries, block.ActionExtract, "")
	if err != nil {
		t.Fatalf("extract failed: %v", err)
	}
	if got := len(es.shadowFor(uuid).SnapshotBlocks()); got != before+1 {
		t.Fatalf("extract should add one block: before=%d after=%d", before, got)
	}
}

// A block nested in an answer is offered as its own kind, and taking it is an
// additive copy: a new block of that kind, with an id of its own, directly after
// the ai-block, whose answer is left as it was. Deleting the copy — its undo —
// leaves the document as it was before. A block of a popup answer, whose holder
// is no block here, is copied after the block it is anchored to. An image's copy
// holds a copy of its file.
func TestCreateBlockFromEntries_nestedBlockIsCopiedAfterItsHost(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewReferenceProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewLogProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewSmartCardProcessor(block.BlockServices{LinkPreview: fakeLinkPreview{}}))
	block.RegisterProcessor(processors.NewWebClipBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	for _, tc := range []struct {
		kind  string
		attrs map[string]interface{}
		key   string
		// stored, when set, registers the kind over the row's store and returns
		// the element's attrs, naming content that store holds; fresh is an attr
		// the copy holds anew.
		stored func(t *testing.T, ds *services.DocumentService, fs *filestore.FileStore, uuid string) map[string]interface{}
		fresh  string
	}{
		{kind: block.KindProse, attrs: map[string]interface{}{"content": "It is **this**."}, key: "content"},
		{kind: "code", attrs: map[string]interface{}{"language": "go", "source": "x := 1", "status": block.BlockStatusComplete}, key: "source"},
		{kind: "diagram", attrs: map[string]interface{}{"diagramType": "mermaid", "source": "graph TD\n  A --> B", "status": block.BlockStatusComplete}, key: "source"},
		{kind: "reference", attrs: map[string]interface{}{"uri": "sieve://0198c1a0-0001-7000-8000-000000000001", "status": block.BlockStatusComplete,
			"cache": map[string]interface{}{"title": "Auth design", "mime": "sieve/note", "cachedAt": "2026-11-26T10:00:00Z"}}, key: "uri"},
		{kind: "log", attrs: map[string]interface{}{"source": "2026-11-26T10:00:02Z ERROR pool exhausted", "parsedAssetRef": "sieve://0198c1a0-0001-7000-8000-0000000000aa/log-parsed", "logFormatName": "ISO", "status": block.BlockStatusComplete}, key: "parsedAssetRef"},
		{kind: "smart-card", attrs: map[string]interface{}{"href": "https://go.dev/doc/effective_go", "title": "Effective Go", "siteName": "go.dev", "status": block.BlockStatusComplete}, key: "title"},
		{kind: "web-clip", attrs: map[string]interface{}{"source": "https://go.dev/blog/go1.22", "mode": "summarise", "title": "Go 1.22 is released", "content": "## Go 1.22\n\nLoop variables are per-iteration.", "page": "sieve://0198c1a0-0001-7000-8000-0000000000aa/page-go1.22.html", "status": block.BlockStatusComplete}, key: "content"},
		{kind: "smart-image", key: "summary", fresh: "src", stored: func(t *testing.T, ds *services.DocumentService, fs *filestore.FileStore, uuid string) map[string]interface{} {
			p := processors.NewSmartImageProcessor(block.BlockServices{Documents: ds, Assets: services.NewAssetService(fs, "")})
			block.RegisterProcessor(p)
			var chart bytes.Buffer
			_ = png.Encode(&chart, image.NewRGBA(image.Rect(0, 0, 4, 3)))
			attrs := p.Transform([]block.ContentEntry{{MIMEType: "image/png", Content: "data:image/png;base64," + base64.StdEncoding.EncodeToString(chart.Bytes())}}, uuid, fixtureID("element"), block.ActionPaste)
			if attrs == nil {
				t.Fatal("the image was not stored")
			}
			attrs["summary"], attrs["alt"], attrs["status"] = "A bar chart of pool use.", "bar chart", block.BlockStatusComplete
			return attrs
		}},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			ds, fs := newTestDocumentService(t)
			es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
			es.SetLifecycleListener(&mockLifecycleListener{})
			uuid := seedProse(t, es, ds, fixtureID("pr-1"), fixtureID("pr-3"))
			if tc.stored != nil {
				tc.attrs = tc.stored(t, ds, fs, uuid)
			}
			elementID := fixtureID("element")
			element := map[string]interface{}{"id": elementID}
			for k, v := range tc.attrs {
				element[k] = v
			}
			host := fixtureID("host")
			if err := es.HandleBlockOp(uuid, block.BlockOp{
				Type: "create-block", Kind: "ai-block", BlockID: host,
				Attrs: map[string]interface{}{
					"status":         block.BlockStatusComplete,
					block.AnswerAttr: []interface{}{map[string]interface{}{"kind": tc.kind, "attrs": element}},
				},
				Anchor: block.Anchor{AfterBlockID: fixtureID("pr-1")},
			}); err != nil {
				t.Fatalf("create the host: %v", err)
			}
			stored := func() string {
				t.Helper()
				waitJobs(t, es, uuid)
				if err := es.Flush(uuid); err != nil {
					t.Fatalf("Flush: %v", err)
				}
				saved, _ := ds.LoadByUUID(uuid)
				return string(saved.Body())
			}
			before := stored()
			hostBefore, _ := es.shadowFor(uuid).SnapshotBlock(host)

			view, _ := json.Marshal(element)
			entries := []block.ContentEntry{{
				MIMEType: "sieve/" + tc.kind, Content: string(view),
				Context: map[string]interface{}{"parentId": host},
			}}
			offers := es.DetectExtractions(uuid, tc.kind, entries)
			own, ok := offerFor(offers, tc.kind)
			if !ok || !own.Has(block.ActionExtract) {
				t.Fatalf("a nested %s must be offered as its own kind; offers=%v", tc.kind, offers)
			}
			for _, o := range offers {
				if o.Has(block.ActionTransform) || o.Has(block.ActionUndoSmartPaste) {
					t.Errorf("a nested source must be offered nothing in place; %s offers %v", o.Kind, o.Actions)
				}
			}

			id, _, err := es.CreateBlockFromEntries(uuid, tc.kind, entries, block.ActionExtract, host)
			if err != nil {
				t.Fatalf("extract: %v", err)
			}
			if id == elementID || id == host {
				t.Fatalf("the copy must have an id of its own, got %q", id)
			}
			copied, _ := es.shadowFor(uuid).SnapshotBlock(id)
			if copied.Kind != tc.kind || copied.Attrs[tc.key] != tc.attrs[tc.key] {
				t.Errorf("the copy is a %s holding %v, want a %s holding %v", copied.Kind, copied.Attrs[tc.key], tc.kind, tc.attrs[tc.key])
			}
			if tc.fresh != "" && (copied.Attrs[tc.fresh] == tc.attrs[tc.fresh] || copied.Attrs[tc.fresh] == nil) {
				t.Errorf("the copy's %s = %v, want one of its own beside the source's %v", tc.fresh, copied.Attrs[tc.fresh], tc.attrs[tc.fresh])
			}
			if got, want := frontendIDs(t, es, uuid), []string{fixtureID("pr-1"), host, id, fixtureID("pr-3")}; !reflect.DeepEqual(got, want) {
				t.Errorf("the copy is not directly after its host: %v", got)
			}
			if hostAfter, _ := es.shadowFor(uuid).SnapshotBlock(host); !reflect.DeepEqual(hostAfter.Attrs, hostBefore.Attrs) {
				t.Errorf("the host changed:\n%v\nwant\n%v", hostAfter.Attrs, hostBefore.Attrs)
			}

			if err := es.HandleBlockOp(uuid, block.BlockOp{Type: "delete-block", BlockID: id}); err != nil {
				t.Fatalf("delete the copy: %v", err)
			}
			if got := stored(); got != before {
				t.Errorf("after the copy's undo the document is\n%s\nwant\n%s", got, before)
			}

			// The same element held by a popup command, which no block of the
			// document is, lands after the block the caller anchors it to.
			held := []block.ContentEntry{{MIMEType: entries[0].MIMEType, Content: entries[0].Content, Context: map[string]interface{}{"parentId": fixtureID("command")}}}
			popupCopy, _, err := es.CreateBlockFromEntries(uuid, tc.kind, held, block.ActionExtract, fixtureID("pr-3"))
			if err != nil {
				t.Fatalf("extract from a popup answer: %v", err)
			}
			if got, want := frontendIDs(t, es, uuid), []string{fixtureID("pr-1"), host, fixtureID("pr-3"), popupCopy}; !reflect.DeepEqual(got, want) {
				t.Errorf("the popup block's copy is not after its anchor: %v", got)
			}
		})
	}
}

// A whole ai-block cannot be converted, and neither can a whole block that says
// it is read-only: every processor but prose declines it, and prose offers its
// Embed in Document, in place. Content nested in an answer is not the exchange,
// so its offers are those of any nested source, each a copy.
func TestDetectExtractions_onlyProseTakesAWholeExchange(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewSmartImageProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewSmartCardProcessor(block.BlockServices{LinkPreview: fakeLinkPreview{}}))
	block.RegisterProcessor(processors.NewReferenceProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewWebClipBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewLogProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	// An answer of one code block, whose markdown — the exchange's text/plain
	// view — is that block fenced.
	const fence = "```go\nx := 1\n```"
	code := map[string]interface{}{"language": "go", "source": "x := 1", "status": block.BlockStatusComplete}
	diagram := map[string]interface{}{"diagramType": "mermaid", "source": "graph TD\n  A --> B", "status": block.BlockStatusComplete}
	host := fixtureID("host")
	exchange := map[string]interface{}{
		"id": host, "status": block.BlockStatusComplete, block.QuestionAttr: "what is it?",
		block.AnswerAttr: []interface{}{map[string]interface{}{"kind": "code", "attrs": code}},
	}
	view := func(kind string, attrs map[string]interface{}, ctx map[string]interface{}) block.ContentEntry {
		b, _ := json.Marshal(attrs)
		return block.ContentEntry{MIMEType: "sieve/" + kind, Content: string(b), Context: ctx}
	}
	readOnly := map[string]interface{}{"readOnly": true}
	nested := map[string]interface{}{"parentId": host}
	embed := map[string][]block.Action{block.KindProse: {block.ActionTransform}}
	copies := func(kinds ...string) map[string][]block.Action {
		out := map[string][]block.Action{}
		for _, k := range kinds {
			out[k] = []block.Action{block.ActionExtract}
		}
		return out
	}

	for _, tc := range []struct {
		name       string
		sourceKind string
		entries    []block.ContentEntry
		want       map[string][]block.Action // the menu's offers: every action but paste
	}{
		{name: "a whole ai-block that says it is read-only", sourceKind: block.KindAIBlock, entries: []block.ContentEntry{
			{MIMEType: "text/plain", Content: fence, Context: readOnly}, view(block.KindAIBlock, exchange, readOnly),
		}, want: embed},
		{name: "a whole ai-block that does not say so", sourceKind: block.KindAIBlock, entries: []block.ContentEntry{
			{MIMEType: "text/plain", Content: fence}, view(block.KindAIBlock, exchange, nil),
		}, want: embed},
		{name: "a whole block of a kind no processor names, read-only", sourceKind: "exhibit", entries: []block.ContentEntry{
			{MIMEType: "text/plain", Content: fence, Context: readOnly}, view("exhibit", map[string]interface{}{"source": fence}, readOnly),
		}, want: embed},
		{name: "that block when it does not say so", sourceKind: "exhibit", entries: []block.ContentEntry{
			{MIMEType: "text/plain", Content: fence}, view("exhibit", map[string]interface{}{"source": fence}, nil),
		}, want: map[string][]block.Action{block.KindProse: {block.ActionTransform}, "code": {block.ActionTransform}}},
		{name: "a code block nested in the answer", sourceKind: "code", entries: []block.ContentEntry{
			view("code", code, nested),
		}, want: copies(block.KindProse, "code")},
		{name: "a diagram nested in the answer", sourceKind: block.KindDiagram, entries: []block.ContentEntry{
			view(block.KindDiagram, diagram, nested),
		}, want: copies(block.KindProse, block.KindDiagram, "smart-image", "code")},
		{name: "a fence in the answer's prose", sourceKind: block.KindAIBlock, entries: []block.ContentEntry{
			{MIMEType: "text/plain", Content: fence, Context: nested}, view(block.KindAIBlock, exchange, nil),
		}, want: copies(block.KindProse, "code")},
		{name: "a link in the answer's prose", sourceKind: block.KindAIBlock, entries: []block.ContentEntry{
			{MIMEType: "text/uri-list", Content: "https://go.dev/doc/effective_go", Context: nested}, view(block.KindAIBlock, exchange, nil),
		}, want: copies(block.KindProse, "smart-card", "web-clip")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := map[string][]block.Action{}
			for _, o := range block.DetectExtractions(tc.sourceKind, tc.entries) {
				for _, a := range o.Actions {
					if a != block.ActionPaste {
						got[o.Kind] = append(got[o.Kind], a)
					}
				}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("offers = %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("Embed in Document replaces the exchange in place", func(t *testing.T) {
		ds, _ := newTestDocumentService(t)
		es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
		es.SetLifecycleListener(&mockLifecycleListener{})
		uuid := seedProse(t, es, ds, fixtureID("pr-1"), fixtureID("pr-3"))
		if err := es.HandleBlockOp(uuid, block.BlockOp{
			Type: "create-block", Kind: block.KindAIBlock, BlockID: host, Attrs: exchange,
			Anchor: block.Anchor{AfterBlockID: fixtureID("pr-1")},
		}); err != nil {
			t.Fatalf("create the exchange: %v", err)
		}
		blk, _ := es.shadowFor(uuid).SnapshotBlock(host)
		entries := []block.ContentEntry{{MIMEType: "text/plain", Content: fence}, view(block.KindAIBlock, blk.Attrs, nil)}
		id, _, err := es.CreateBlockFromEntries(uuid, block.KindProse, entries, block.ActionTransform, host)
		if err != nil {
			t.Fatalf("embed: %v", err)
		}
		if blk, _ := es.shadowFor(uuid).SnapshotBlock(id); id != host || blk.Kind != block.KindProse {
			t.Errorf("embed made %s %q, want the exchange replaced in place by prose", blk.Kind, id)
		}
	})
}
