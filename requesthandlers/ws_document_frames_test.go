package requesthandlers

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
)

// fakePreview stands in for the network on the paste path — a committed test
// never makes a real request.
type fakePreview struct{ title string }

func (f fakePreview) FetchTitle(string, time.Duration) string { return f.title }
func (f fakePreview) FetchFull(string) domain.LinkPreviewResult {
	return domain.LinkPreviewResult{}
}

// seedBody replaces the test document's buffer before any channel opens it.
func seedBody(t *testing.T, sp *sieve.ServiceProvider, uuid, body string) {
	t.Helper()
	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("LoadByUUID: %v", err)
	}
	doc.SetBody([]byte(body))
	if _, err := sp.Documents.Save(doc); err != nil {
		t.Fatalf("Save: %v", err)
	}
}

// send writes one frame, failing the test rather than the connection.
func send(t *testing.T, c *websocket.Conn, frame string) {
	t.Helper()
	if err := c.WriteMessage(websocket.TextMessage, []byte(frame)); err != nil {
		t.Fatalf("write %s: %v", frame, err)
	}
}

// A load frame answers with the document the channel is bound to: the buffer,
// its mode, and — in WYSIWYG — the block list, all at the frame's top level.
// The frame carries no uuid, because the channel already is one.
func TestWS_Load_AnswersWithTheChannelsDocument(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	seedBody(t, sp, uuid, "hello from disk")

	c := dialWS(t, srv, uuid)
	send(t, c, `{"type":"load","opId":"op-load"}`)

	reply := readUntil(t, c, "load-content", 2*time.Second)
	if reply["opId"] != "op-load" {
		t.Errorf("opId = %v, want op-load", reply["opId"])
	}
	if body, _ := reply["body"].(string); !strings.Contains(body, "hello from disk") {
		t.Errorf("body = %q, want the seeded buffer", body)
	}
	if reply["uuid"] != uuid {
		t.Errorf("uuid = %v, want %s", reply["uuid"], uuid)
	}
	if reply["mode"] != "wysiwyg" {
		t.Errorf("mode = %v, want wysiwyg", reply["mode"])
	}
	blocks, _ := reply["blocks"].([]interface{})
	if len(blocks) == 0 {
		t.Errorf("wysiwyg load must carry the block list, got %v", reply["blocks"])
	}
	closeAndSettle(c)
}

// Opening a document channel pushes its text marks unasked: nothing sends a
// frame to ask for them, so a missing push is a permanently unmarked document.
// They ride the owner path every other render-back does, and each names the
// feature that found it — the client draws each producer's findings its own way.
func TestWS_TextMarks_ArePushedWhenTheChannelOpens(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	seedBody(t, sp, uuid, "this sentence has a helllo in it")

	c := dialWS(t, srv, uuid)
	frame := readUntil(t, c, protocol.TypeTextMarks, 2*time.Second)

	if frame["blockId"] == "" || frame["blockId"] == nil {
		t.Errorf("text-marks named no block: %v", frame)
	}
	if frame["feature"] != domain.FeatureSpellCheck {
		t.Errorf("feature = %v, want %q", frame["feature"], domain.FeatureSpellCheck)
	}
	marks, _ := frame["marks"].([]interface{})
	if len(marks) != 1 {
		t.Fatalf("marks = %v, want the one misspelling", frame["marks"])
	}
	mark, _ := marks[0].(map[string]interface{})
	if mark["quote"] != "helllo" {
		t.Errorf("quote = %v, want helllo", mark["quote"])
	}
	if mark["class"] != domain.TextClassProse {
		t.Errorf("class = %v, want prose", mark["class"])
	}
	closeAndSettle(c)
}

// FIND, END TO END OVER THE WIRE. A control frame on the document channel
// switches a per-document producer on, its findings come back as a marks push
// naming that feature, and the same frame carrying the imperative rewrites the
// document — arriving as the ordinary replace-block echo, not as an answer of
// its own, because a replace-all is an edit like any other by the time it
// reaches a client.
//
// It is asserted HERE, over a real socket, because everything between the frame
// and the echo is relay: the handler reads a feature word it does not interpret,
// and a unit test of either end proves nothing about the wire between them.
func TestWS_Find_SearchesAndReplacesFromTheControlFrame(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, sp, _, uuid := newWsTestServer(t)
	seedBody(t, sp, uuid, "the cat sat on the mat")

	c := dialWS(t, srv, uuid)
	send(t, c, `{"type":"feature-control","feature":"find","enabled":true,"parameters":{"term":"the"}}`)

	found := readUntilFeature(t, c, domain.FeatureFind, 3*time.Second)
	marks, _ := found["marks"].([]interface{})
	if len(marks) != 2 {
		t.Fatalf("marks = %v, want both matches of the term", found["marks"])
	}
	mark, _ := marks[0].(map[string]interface{})
	if mark["quote"] != "the" || mark["grain"] != domain.GrainLiteral {
		t.Errorf("mark = %v, want the literal text at literal grain", mark)
	}

	send(t, c, `{"type":"feature-control","feature":"find","enabled":true,`+
		`"parameters":{"term":"the","replacement":"a","replaceAll":true}}`)

	echo := readUntil(t, c, protocol.TypeReplaceBlock, 3*time.Second)
	attrs, _ := echo["attrs"].(map[string]interface{})
	if content, _ := attrs["content"].(string); content != "a cat sat on a mat" {
		t.Errorf("the echoed block reads %v, want every match replaced", attrs["content"])
	}
	closeAndSettle(c)
}

// readUntilFeature reads text-marks frames until one carries the named feature.
// A document with more than one producer switched on pushes several, and a test
// about one of them must not be answered by another's.
func readUntilFeature(t *testing.T, c *websocket.Conn, feature string, within time.Duration) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		frame := readUntil(t, c, protocol.TypeTextMarks, time.Until(deadline))
		if frame["feature"] == feature {
			return frame
		}
	}
	t.Fatalf("no text-marks frame for feature %q arrived", feature)
	return nil
}

// The DEBOUNCE autosave — a save nobody asked for — announces itself on the
// workspace wire like every other save. This is the editor's only saved-signal
// for a document the user is simply typing in, so its absence is a permanently
// dirty document.
func TestWS_DebounceAutosaveAnnouncesTheSaveToTheWorkspace(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, _, _, uuid := newWsTestServerWithDebounce(t, 50*time.Millisecond)

	workspace := dialWorkspaceWS(t, srv)
	defer workspace.Close()

	c := dialWS(t, srv, uuid)
	send(t, c, `{"type":"load","opId":"op-load"}`)
	readUntil(t, c, "load-content", 2*time.Second)

	// An edit arms the autosave. Nothing here ASKS for anything.
	send(t, c, `{"type":"doc-update","uuid":"`+uuid+`","markdown":"edited after the load frame"}`)

	saved := readUntil(t, workspace, protocol.TypeContainerSaved, 2*time.Second)
	if saved["uuid"] != uuid {
		t.Errorf("container-saved uuid = %v, want %s", saved["uuid"], uuid)
	}
	// The version reaches the client, not just the notifier: it is what lets a
	// client waiting on its OWN save tell this unasked-for write apart from it.
	if version, _ := saved["version"].(float64); version <= 0 {
		t.Errorf("container-saved version = %v, want the version this write produced", saved["version"])
	}
	closeAndSettle(c)
}

// An EXPLICIT flush is fire-and-forget on the document wire: the requester hears
// nothing back there, and learns the save happened the same way every other
// client does — the workspace fact.
func TestWS_ExplicitFlushAnnouncesTheSaveAndAnswersNothing(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, _, _, uuid := newWsTestServerWithDebounce(t, time.Hour)

	workspace := dialWorkspaceWS(t, srv)
	defer workspace.Close()

	c := dialWS(t, srv, uuid)
	send(t, c, `{"type":"doc-update","uuid":"`+uuid+`","markdown":"flushed on request"}`)
	send(t, c, `{"type":"flush","uuid":"`+uuid+`"}`)

	saved := readUntil(t, workspace, protocol.TypeContainerSaved, 2*time.Second)
	if saved["uuid"] != uuid {
		t.Errorf("container-saved uuid = %v, want %s", saved["uuid"], uuid)
	}
	// Nothing came back on the document wire ANSWERING the flush: the fact travels
	// on the other one. The only frames tolerated here are the ones the server
	// pushes of its own accord — text marks, which a channel emits on open —
	// so anything else, of any type, fails.
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			break // read deadline: nothing further arrived
		}
		var frame map[string]interface{}
		_ = json.Unmarshal(raw, &frame)
		if frame["type"] != protocol.TypeTextMarks {
			t.Errorf("flush must be unanswered on the document wire, got %q", string(raw))
		}
	}
	closeAndSettle(c)
}

// A payload the handler cannot read is REFUSED, not dropped: silence leaves the
// client waiting on a correlated reply that is never coming, which is
// indistinguishable from a slow server. Same shape as dispatch's unknown-type
// refusal — an error frame naming the frame it could not read.
func TestWS_UnreadablePayloadIsRefusedNotDropped(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	// Each frame's type word is well-formed (the read loop dispatches on it) while
	// a typed field beneath it is the wrong shape.
	for _, malformed := range []struct{ name, frame string }{
		{"load", `{"type":"load","opId":42}`},
		{"paste", `{"type":"paste","opId":"op-p","entries":"not-a-list"}`},
		{"detect-extractions", `{"type":"detect-extractions","opId":"op-dx","entries":7}`},
		{"export", `{"type":"export","opId":"op-x","format":["markdown"]}`},
	} {
		t.Run(malformed.name, func(t *testing.T) {
			send(t, c, malformed.frame)
			got := readUntil(t, c, "error", 2*time.Second)
			if msg, _ := got["message"].(string); !strings.Contains(msg, malformed.name) {
				t.Errorf("error message = %q, want it to name the %s frame", msg, malformed.name)
			}
		})
	}
	closeAndSettle(c)
}

// The paste ack is the paste RESULT UNION — a discriminated "what happened",
// not "did some kind match". These bytes are the frontend's contract.
func TestWS_Paste_AckIsTheResultUnion(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	srv, sp, _, uuid := newWsTestServer(t)
	sp.Editor.SetServices(block.BlockServices{LinkPreview: fakePreview{title: "Example Domain"}})
	c := dialWS(t, srv, uuid)

	paste := func(t *testing.T, entriesJSON string) map[string]interface{} {
		t.Helper()
		send(t, c, `{"type":"paste","opId":"op-p","kind":"smart","index":0,"entries":`+entriesJSON+`}`)
		return readUntil(t, c, "paste-ack", 2*time.Second)
	}

	t.Run("URL becomes content", func(t *testing.T) {
		got := paste(t, `[{"mimeType":"text/plain","content":"https://example.com"}]`)
		if got["outcome"] != "content" {
			t.Fatalf("outcome: got %q, want content (%v)", got["outcome"], got)
		}
		if want := `<a href="https://example.com">Example Domain</a>`; got["html"] != want {
			t.Errorf("html: got %q, want %q", got["html"], want)
		}
		if _, has := got["id"]; has {
			t.Errorf("a content result must carry no block identity: %v", got)
		}
	})

	t.Run("claimed content becomes a block", func(t *testing.T) {
		got := paste(t, `[{"mimeType":"text/plain","content":"`+"```"+`go\nx := 1\n`+"```"+`"}]`)
		if got["outcome"] != "block" {
			t.Fatalf("outcome: got %q, want block (%v)", got["outcome"], got)
		}
		if got["kind"] != "code" {
			t.Errorf("kind: got %q, want code", got["kind"])
		}
		if got["id"] == "" || got["rawYaml"] == "" {
			t.Errorf("a block result must carry id and rawYaml: %v", got)
		}
		if _, has := got["html"]; has {
			t.Errorf("a block result must carry no content fragment: %v", got)
		}
	})

	// A DROPPED FILE takes the same route a paste does: the surface reads it as a
	// data URI, stamps the filename in the entry's context, and the registry
	// routes it.
	t.Run("a dropped file becomes a reference", func(t *testing.T) {
		block.RegisterProcessor(processors.NewReferenceProcessor(block.BlockServices{
			Documents: sp.Documents, Assets: services.NewAssetService(sp.Store, ""),
		}))
		t.Cleanup(func() { block.UnregisterProcessor("reference") })

		payload := base64.StdEncoding.EncodeToString([]byte("openapi: 3.0.0\n"))
		got := paste(t, `[{"mimeType":"text/yaml","content":"data:text/yaml;base64,`+payload+`","context":{"filename":"swagger.yml"}}]`)
		if got["outcome"] != "block" {
			t.Fatalf("outcome: got %q, want block (%v)", got["outcome"], got)
		}
		if got["kind"] != "reference" {
			t.Errorf("kind: got %q, want reference", got["kind"])
		}
		// The chip's label rides in the serialized block, so the drop is only
		// complete if the original filename survived the whole round trip.
		if raw, _ := got["rawYaml"].(string); !strings.Contains(raw, "swagger.yml") {
			t.Errorf("rawYaml must carry the dropped filename as the title: %q", raw)
		}
	})

	t.Run("unclaimed text is nothing", func(t *testing.T) {
		got := paste(t, `[{"mimeType":"text/plain","content":"just plain text"}]`)
		if got["outcome"] != "none" {
			t.Fatalf("outcome: got %q, want none (%v)", got["outcome"], got)
		}
	})

	closeAndSettle(c)
}

// A slice paste answers with the outcome alone: it created several blocks and
// names none of them, and each arrives as its own insert-block render-back.
func TestWS_Paste_SliceAcksWithoutNamingABlock(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	one := `[{"mimeType":"text/plain","content":"` + "```" + `go\nx := 1\n` + "```" + `"}]`
	send(t, c, `{"type":"paste","opId":"op-slice","kind":"slice","index":0,"slice":[`+one+`,`+one+`]}`)

	ack := readUntil(t, c, "paste-ack", 2*time.Second)
	if ack["opId"] != "op-slice" {
		t.Errorf("opId = %v, want op-slice", ack["opId"])
	}
	if ack["outcome"] != "block" {
		t.Errorf("outcome = %v, want block", ack["outcome"])
	}
	if _, has := ack["id"]; has {
		t.Errorf("a slice ack names no single block, got id %v", ack["id"])
	}
	closeAndSettle(c)
}

// detect-extractions answers the offer list the extract menu renders, wrapped in
// `offers` and never null — a menu reading a length off null is a crash.
func TestWS_DetectExtractions_AnswersOffers(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))

	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	send(t, c, `{"type":"detect-extractions","opId":"op-dx","sourceKind":"prose","entries":[{"mimeType":"text/plain","content":"nothing claimable"}]}`)
	reply := readUntil(t, c, "detect-extractions-result", 2*time.Second)
	if reply["opId"] != "op-dx" {
		t.Errorf("opId = %v, want op-dx", reply["opId"])
	}
	if _, ok := reply["offers"].([]interface{}); !ok {
		t.Errorf("offers must be an array, got %#v", reply["offers"])
	}
	closeAndSettle(c)
}

// export serves CLEAN whole-doc markdown: survivors render through their
// MarkdownRepresentation, and the handler's own filter drops ai-blocks because
// prior Q&A is conversation, not document content.
func TestWS_Export_DropsAIBlocksAndServesCleanMarkdown(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(processors.NewCodeBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{}))

	srv, sp, _, uuid := newWsTestServer(t)

	const priorAnswer = "PRIOR-ANSWER-must-not-export"
	body, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize([]block.SieveBlock{
		block.NewSieveBlock(block.KindProse, "pr-1", map[string]interface{}{"content": "user prose stays"}),
		block.NewSieveBlock("code", "co-1", map[string]interface{}{
			"id": "co-1", "language": "go", "source": "x := 1", "status": block.BlockStatusComplete,
		}),
		block.NewSieveBlock("ai-block", "ab-1", map[string]interface{}{
			"id": "ab-1", "ref": "doc", "type": "ASK", "status": block.BlockStatusComplete,
			"question": "what is x?", "response": priorAnswer,
		}),
	})
	if err != nil {
		t.Fatalf("seed serialize: %v", err)
	}
	seedBody(t, sp, uuid, body)

	c := dialWS(t, srv, uuid)
	send(t, c, `{"type":"export","opId":"op-x","format":"markdown"}`)
	reply := readUntil(t, c, "export-content", 2*time.Second)

	if reply["opId"] != "op-x" || reply["format"] != "markdown" {
		t.Errorf("export-content must echo opId and format, got %v", reply)
	}
	md, _ := reply["content"].(string)
	if strings.Contains(md, priorAnswer) || strings.Contains(md, "what is x?") {
		t.Errorf("export leaked the ai-block, got %q", md)
	}
	if !strings.Contains(md, "user prose stays") {
		t.Errorf("export lost prose, got %q", md)
	}
	if !strings.Contains(md, "x := 1") {
		t.Errorf("export lost code source, got %q", md)
	}
	if strings.Contains(md, "```code") || strings.Contains(md, "source:") {
		t.Errorf("export leaked the on-disk YAML fence form, got %q", md)
	}
	if strings.Contains(md, "<!--s:") {
		t.Errorf("export leaked prose sentinels, got %q", md)
	}

	// An unknown format is refused, not silently served as markdown.
	send(t, c, `{"type":"export","opId":"op-pdf","format":"pdf"}`)
	errFrame := readUntil(t, c, "error", 2*time.Second)
	if msg, _ := errFrame["message"].(string); !strings.Contains(msg, "pdf") {
		t.Errorf("error message = %q, want it to name the refused format", msg)
	}
	closeAndSettle(c)
}

// The focus frame is the dwell ping: it raises the document's focus count and
// answers nothing at all.
func TestWS_Focus_RaisesTheDocumentsFocusCount(t *testing.T) {
	srv, sp, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	before := 0
	if doc, err := sp.Documents.LoadByUUID(uuid); err == nil {
		before = doc.Meta().FocusCount()
	}
	send(t, c, `{"type":"focus"}`)

	deadline := time.Now().Add(2 * time.Second)
	for {
		doc, err := sp.Documents.LoadByUUID(uuid)
		if err == nil && doc.Meta().FocusCount() == before+1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("focus count never rose past %d", before)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Nothing is written back: a reply nobody consumes is a contract nobody
	// maintains.
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, raw, err := c.ReadMessage(); err == nil {
		t.Errorf("focus must be unanswered, got %q", string(raw))
	}
	closeAndSettle(c)
}
