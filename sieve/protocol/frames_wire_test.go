package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// The `legacy` values below are the maps requesthandlers/ws_handler.go builds at
// its emission sites, copied verbatim. They are the fidelity ORACLE: a protocol
// frame must marshal to the same JSON object, so acquiring types moves no wire.
// Key ORDER differs (a map marshals sorted, a struct in field order) and is not
// part of the contract, so the oracle is compared as decoded objects while
// `golden` pins the exact bytes a typed frame now produces.
type wireCase struct {
	name    string
	channel Channel
	frame   interface{}
	golden  string
	// legacy is nil for a frame the target introduces, which has nothing to be
	// faithful to.
	legacy interface{}
}

func outboundWireCases() []wireCase {
	attrs := map[string]interface{}{"status": "done", "source": "x = 1"}
	blocks := []block.FrontendBlock{{ID: "b1", Kind: "prose", Attrs: map[string]interface{}{"content": "hello"}}}
	candidates := []domain.Candidate{{URI: "sieve://9f2b", Title: "Auth Design", Kind: "note", Detail: "design/"}}
	target := domain.OpenTarget{URI: "sieve://9f2b", UUID: "9f2b", BlockID: "b1", Kind: "note", Title: "Auth Design"}
	marks := []domain.TextMark{{
		BlockID: "b1", Locator: "content", Quote: "teh", Occurrence: 1,
		Start: 15, End: 18, Class: domain.TextClassProse,
	}}
	boom := errors.New("boom")

	return []wireCase{
		{
			name:    "pong",
			channel: ChannelDocument,
			frame:   NewPongFrame(),
			golden:  `{"type":"pong"}`,
			legacy:  map[string]string{"type": "pong"},
		},
		{
			name:    "markdown-content",
			channel: ChannelDocument,
			frame:   NewMarkdownContentFrame("doc-1", "# hi").WithOpID("op-2"),
			golden:  `{"type":"markdown-content","uuid":"doc-1","markdown":"# hi","opId":"op-2"}`,
			legacy:  map[string]string{"type": "markdown-content", "uuid": "doc-1", "markdown": "# hi", "opId": "op-2"},
		},
		{
			name:    "wysiwyg-content",
			channel: ChannelDocument,
			frame:   NewWysiwygContentFrame("doc-1", blocks),
			golden:  `{"type":"wysiwyg-content","uuid":"doc-1","blocks":[{"id":"b1","kind":"prose","attrs":{"content":"hello"}}]}`,
			legacy:  map[string]interface{}{"type": "wysiwyg-content", "uuid": "doc-1", "blocks": blocks},
		},
		{
			name:    "block-op-ack success",
			channel: ChannelDocument,
			frame:   NewBlockOpAckFrame("op-7", nil),
			golden:  `{"type":"block-op-ack","opId":"op-7","ok":true}`,
			legacy:  map[string]interface{}{"type": "block-op-ack", "opId": "op-7", "ok": true},
		},
		{
			name:    "block-op-ack failure",
			channel: ChannelDocument,
			frame:   NewBlockOpAckFrame("op-7", boom),
			golden:  `{"type":"block-op-ack","opId":"op-7","ok":false,"error":"boom"}`,
			legacy:  map[string]interface{}{"type": "block-op-ack", "opId": "op-7", "ok": false, "error": "boom"},
		},
		{
			name:    "extract-ack success",
			channel: ChannelDocument,
			frame:   NewExtractAckFrame("op-4", nil),
			golden:  `{"type":"extract-ack","opId":"op-4","ok":true}`,
			legacy:  map[string]interface{}{"type": "extract-ack", "opId": "op-4", "ok": true},
		},
		{
			name:    "insert-block",
			channel: ChannelDocument,
			frame:   NewInsertBlockFrame("code", "b1", attrs, 3, "```go\nx := 1\n```"),
			golden:  `{"type":"insert-block","kind":"code","id":"b1","attrs":{"source":"x = 1","status":"done"},"index":3,"markdown":"` + "```go\\nx := 1\\n```" + `"}`,
			legacy: map[string]interface{}{
				"type": "insert-block", "kind": "code", "id": "b1", "attrs": attrs,
				"index": 3, "markdown": "```go\nx := 1\n```",
			},
		},
		{
			name:    "insert-block with no attrs",
			channel: ChannelDocument,
			frame:   NewInsertBlockFrame("prose", "b2", nil, 0, ""),
			golden:  `{"type":"insert-block","kind":"prose","id":"b2","attrs":null,"index":0,"markdown":""}`,
			legacy: map[string]interface{}{
				"type": "insert-block", "kind": "prose", "id": "b2", "attrs": map[string]interface{}(nil),
				"index": 0, "markdown": "",
			},
		},
		{
			name:    "block-attrs-updated",
			channel: ChannelDocument,
			frame:   NewBlockAttrsUpdatedFrame("b1", attrs),
			golden:  `{"type":"block-attrs-updated","id":"b1","attrs":{"source":"x = 1","status":"done"}}`,
			legacy:  map[string]interface{}{"type": "block-attrs-updated", "id": "b1", "attrs": attrs},
		},
		{
			name:    "replace-block",
			channel: ChannelDocument,
			frame:   NewReplaceBlockFrame("b1", "diagram", "b2", attrs, "kind: diagram\n"),
			golden:  `{"type":"replace-block","oldId":"b1","newKind":"diagram","newId":"b2","attrs":{"source":"x = 1","status":"done"},"newYaml":"kind: diagram\n"}`,
			legacy: map[string]interface{}{
				"type": "replace-block", "oldId": "b1", "newId": "b2", "newKind": "diagram",
				"attrs": attrs, "newYaml": "kind: diagram\n",
			},
		},
		{
			// A bare id is the whole payload: a block that left the container has
			// nothing else to say about itself.
			name:    "remove-block",
			channel: ChannelDocument,
			frame:   NewRemoveBlockFrame("b1"),
			golden:  `{"type":"remove-block","id":"b1"}`,
		},
		{
			name:    "order-changed",
			channel: ChannelDocument,
			frame:   NewOrderChangedFrame([]string{"b2", "b1", "b3"}),
			golden:  `{"type":"order-changed","order":["b2","b1","b3"]}`,
		},
		{
			// An emptied container still reorders to a LIST: the client installs
			// what it is given, and a null would be a crash rather than "nothing".
			name:    "order-changed for an emptied container",
			channel: ChannelDocument,
			frame:   NewOrderChangedFrame(nil),
			golden:  `{"type":"order-changed","order":[]}`,
		},
		{
			name:    "load-content",
			channel: ChannelDocument,
			frame: NewLoadContentFrame(DocumentContent{
				Body: "# hi", Mode: "wysiwyg", UUID: "doc-1", Scroll: 240, Version: 12, Blocks: blocks,
			}).WithOpID("op-8"),
			golden: `{"type":"load-content","body":"# hi","mode":"wysiwyg","uuid":"doc-1","scroll":240,"version":12,"blocks":[{"id":"b1","kind":"prose","attrs":{"content":"hello"}}],"opId":"op-8"}`,
			// The payload half is the body GET /api/editor/load answered with; only
			// the type/opId envelope around it is new.
			legacy: map[string]interface{}{
				"type": "load-content", "body": "# hi", "mode": "wysiwyg", "uuid": "doc-1",
				"scroll": 240, "version": 12, "blocks": blocks, "opId": "op-8",
			},
		},
		{
			// Markdown mode serves the body only, and a document nobody found is an
			// empty uuid — both of which must stay expressible. The version is 0
			// here for the reason a prompt's always is: it keeps no version history.
			name:    "load-content in markdown mode",
			channel: ChannelDocument,
			frame:   NewLoadContentFrame(DocumentContent{Body: "raw", Mode: "markdown", UUID: "prompt:default"}),
			golden:  `{"type":"load-content","body":"raw","mode":"markdown","uuid":"prompt:default","scroll":0,"version":0}`,
		},
		{
			name:    "paste-ack for a created block",
			channel: ChannelDocument,
			frame:   NewPasteAckFrame("op-9", block.PasteBlock("web-clip", "b7", "kind: web-clip\n")),
			golden:  `{"type":"paste-ack","opId":"op-9","outcome":"block","kind":"web-clip","id":"b7","rawYaml":"kind: web-clip\n"}`,
			legacy: map[string]interface{}{
				"type": "paste-ack", "opId": "op-9",
				"outcome": "block", "kind": "web-clip", "id": "b7", "rawYaml": "kind: web-clip\n",
			},
		},
		{
			name:    "paste-ack for a fragment",
			channel: ChannelDocument,
			frame:   NewPasteAckFrame("op-9", block.PasteContent(`<a href="x">T</a>`)),
			// encoding/json escapes <, > and & — the fragment crosses the wire
			// escaped and the client's JSON.parse gives the markup back intact.
			golden: `{"type":"paste-ack","opId":"op-9","outcome":"content","html":"\u003ca href=\"x\"\u003eT\u003c/a\u003e"}`,
		},
		{
			// A failed paste answers "none" so the client replays the clipboard
			// locally — the graceful fallback — and the message says why.
			name:    "paste-ack for a failure",
			channel: ChannelDocument,
			frame:   NewPasteFailedFrame("op-9", boom),
			golden:  `{"type":"paste-ack","opId":"op-9","outcome":"none","error":"boom"}`,
		},
		{
			name:    "detect-extractions-result",
			channel: ChannelDocument,
			frame: NewDetectExtractionsResultFrame("op-10", []block.SupportedActions{
				{Kind: "code", Actions: []block.Action{block.ActionExtract, block.ActionTransform}},
			}),
			golden: `{"type":"detect-extractions-result","opId":"op-10","offers":[{"kind":"code","actions":["extract","transform"]}]}`,
		},
		{
			name:    "detect-extractions-result with no offers",
			channel: ChannelDocument,
			frame:   NewDetectExtractionsResultFrame("op-10", nil),
			golden:  `{"type":"detect-extractions-result","opId":"op-10","offers":[]}`,
		},
		{
			name:    "export-content",
			channel: ChannelDocument,
			frame:   NewExportContentFrame("op-11", "markdown", "# Auth Design\n"),
			golden:  `{"type":"export-content","opId":"op-11","format":"markdown","content":"# Auth Design\n"}`,
		},
		{
			name:    "spell-marks",
			channel: ChannelDocument,
			frame:   NewSpellMarksFrame("b1", marks),
			golden:  `{"type":"spell-marks","blockId":"b1","marks":[{"locator":"content","quote":"teh","occurrence":1,"start":15,"end":18,"class":"prose","suggestions":[]}]}`,
		},
		{
			// The clear. An empty set must marshal as [] and never as null — the
			// client reads a length off it to decide what to drop.
			name:    "spell-marks cleared",
			channel: ChannelDocument,
			frame:   NewSpellMarksFrame("b1", nil),
			golden:  `{"type":"spell-marks","blockId":"b1","marks":[]}`,
		},
		{
			name:    "text-replace-ack applied",
			channel: ChannelDocument,
			frame:   NewTextReplaceAckFrame("op-1", nil),
			golden:  `{"type":"text-replace-ack","opId":"op-1","outcome":"ok"}`,
		},
		{
			// A stale anchor is an outcome, not an error: the wire says so by
			// carrying the word and no error string.
			name:    "text-replace-ack stale",
			channel: ChannelDocument,
			frame:   NewTextReplaceAckFrame("op-1", fmt.Errorf("%w: %q at occurrence %d", block.ErrTextStale, "teh", 1)),
			golden:  `{"type":"text-replace-ack","opId":"op-1","outcome":"stale"}`,
		},
		{
			name:    "text-replace-ack failed",
			channel: ChannelDocument,
			frame:   NewTextReplaceAckFrame("op-1", boom),
			golden:  `{"type":"text-replace-ack","opId":"op-1","outcome":"error","error":"boom"}`,
		},
		{
			name:    "error",
			channel: ChannelDocument,
			frame:   NewErrorFrame("block-op create-block failed: nope"),
			golden:  `{"type":"error","message":"block-op create-block failed: nope"}`,
			legacy:  map[string]interface{}{"type": "error", "message": "block-op create-block failed: nope"},
		},
		{
			name:    "command-result pending",
			channel: ChannelWorkspace,
			frame:   NewCommandResultFrame("c-1", "btw", "PENDING"),
			golden:  `{"type":"command-result","correlationId":"c-1","cmd":"btw","status":"PENDING"}`,
			legacy:  map[string]interface{}{"type": "command-result", "correlationId": "c-1", "cmd": "btw", "status": "PENDING"},
		},
		{
			name:    "command-result with block",
			channel: ChannelWorkspace,
			frame:   NewCommandResultFrame("c-1", "btw", "COMPLETE").WithBlock("ai-block", attrs),
			golden:  `{"type":"command-result","correlationId":"c-1","cmd":"btw","status":"COMPLETE","block":{"kind":"ai-block","attrs":{"source":"x = 1","status":"done"}}}`,
			legacy: map[string]interface{}{
				"type": "command-result", "correlationId": "c-1", "cmd": "btw", "status": "COMPLETE",
				"block": map[string]interface{}{"kind": "ai-block", "attrs": attrs},
			},
		},
		{
			name:    "command-result error",
			channel: ChannelWorkspace,
			frame:   NewCommandResultFrame("c-1", "btw", "ERROR").WithError("commands unavailable"),
			golden:  `{"type":"command-result","correlationId":"c-1","cmd":"btw","status":"ERROR","error":"commands unavailable"}`,
			legacy: map[string]interface{}{
				"type": "command-result", "correlationId": "c-1", "cmd": "btw",
				"status": "ERROR", "error": "commands unavailable",
			},
		},
		{
			name:    "mention-result",
			channel: ChannelWorkspace,
			frame:   NewMentionResultFrame("c-2", candidates),
			golden:  `{"type":"mention-result","correlationId":"c-2","candidates":[{"uri":"sieve://9f2b","title":"Auth Design","kind":"note","detail":"design/","summary":""}]}`,
			legacy:  map[string]interface{}{"type": "mention-result", "correlationId": "c-2", "candidates": candidates},
		},
		{
			name:    "mention-result with no matches",
			channel: ChannelWorkspace,
			frame:   NewMentionResultFrame("c-2", nil),
			golden:  `{"type":"mention-result","correlationId":"c-2","candidates":[]}`,
			legacy:  map[string]interface{}{"type": "mention-result", "correlationId": "c-2", "candidates": []domain.Candidate{}},
		},
		{
			name:    "mention-resolved found",
			channel: ChannelWorkspace,
			frame:   NewMentionResolvedFrame("c-3", "sieve://9f2b", target),
			golden:  `{"type":"mention-resolved","correlationId":"c-3","uri":"sieve://9f2b","found":true,"uuid":"9f2b","blockId":"b1","kind":"note","title":"Auth Design"}`,
			legacy: map[string]interface{}{
				"type": "mention-resolved", "correlationId": "c-3", "uri": "sieve://9f2b",
				"found": true, "uuid": "9f2b", "blockId": "b1", "kind": "note", "title": "Auth Design",
			},
		},
		{
			name:    "mention-resolved unresolvable",
			channel: ChannelWorkspace,
			frame:   NewMentionUnresolvedFrame("c-3", "sieve://gone", errors.New("node: address resolves to nothing")),
			golden:  `{"type":"mention-resolved","correlationId":"c-3","uri":"sieve://gone","found":false,"uuid":"","blockId":"","kind":"","title":"","error":"node: address resolves to nothing"}`,
			legacy: map[string]interface{}{
				"type": "mention-resolved", "correlationId": "c-3", "uri": "sieve://gone",
				"found": false, "uuid": "", "blockId": "", "kind": "", "title": "",
				"error": "node: address resolves to nothing",
			},
		},
		{
			name:    "invalidate",
			channel: ChannelWorkspace,
			frame:   NewInvalidateFrame(TopicNotes),
			golden:  `{"type":"invalidate","topic":"notes"}`,
		},
		{
			name:    "jobs-changed",
			channel: ChannelWorkspace,
			frame: NewJobsChangedFrame(JobsSnapshot{
				Active: []domain.JobInfo{{JobID: "j1", Label: "Refining…", SpinTab: true, State: "active", Category: "ai"}},
				Queued: []domain.JobInfo{},
			}),
			golden: `{"type":"jobs-changed","active":[{"jobId":"j1","label":"Refining…","spinTab":true,"state":"active","category":"ai"}],"queued":[]}`,
			// The payload half is JobTracker.broadcastJobs' snapshot verbatim; only
			// the type envelope around it is new.
			legacy: map[string]interface{}{
				"type":   "jobs-changed",
				"active": []domain.JobInfo{{JobID: "j1", Label: "Refining…", SpinTab: true, State: "active", Category: "ai"}},
				"queued": []domain.JobInfo{},
			},
		},
		{
			// An empty snapshot is still two lists: the status bar reads their
			// lengths, so a null would be a crash rather than "no jobs".
			name:    "jobs-changed with nothing running",
			channel: ChannelWorkspace,
			frame:   NewJobsChangedFrame(JobsSnapshot{}),
			golden:  `{"type":"jobs-changed","active":[],"queued":[]}`,
		},
		{
			// A bare uuid is the whole payload: the client reconciles by identity,
			// and there is nothing about a document that no longer exists to send.
			name:    "container-deleted",
			channel: ChannelWorkspace,
			frame:   NewContainerDeletedFrame("0198f3c1-1b2a-7000-8000-000000000001"),
			golden:  `{"type":"container-deleted","uuid":"0198f3c1-1b2a-7000-8000-000000000001"}`,
		},
		{
			// The saved fact is near its deleted sibling's shape: a uuid, no opId —
			// it answers no request, because every writer publishes it — plus the
			// version that makes it orderable against what a listener already knew.
			name:    "container-saved",
			channel: ChannelWorkspace,
			frame:   NewContainerSavedFrame("0198f3c1-1b2a-7000-8000-000000000001", 7),
			golden:  `{"type":"container-saved","uuid":"0198f3c1-1b2a-7000-8000-000000000001","version":7}`,
		},
	}
}

// Every outbound frame must marshal to exactly the bytes pinned here.
func TestOutboundFrames_MarshalToGoldenJSON(t *testing.T) {
	for _, tc := range outboundWireCases() {
		t.Run(tc.name, func(t *testing.T) {
			got, err := json.Marshal(tc.frame)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tc.golden {
				t.Errorf("frame JSON drifted\n got: %s\nwant: %s", got, tc.golden)
			}
		})
	}
}

// Every outbound frame that exists today must carry the same keys and values as
// the map ws_handler.go builds for it.
func TestOutboundFrames_MatchCurrentEmission(t *testing.T) {
	for _, tc := range outboundWireCases() {
		if tc.legacy == nil {
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			if got, want := asObject(t, tc.frame), asObject(t, tc.legacy); !reflect.DeepEqual(got, want) {
				t.Errorf("frame is not what the handler emits today\n got: %#v\nwant: %#v", got, want)
			}
		})
	}
}

// A frame that no registry entry claims cannot be routed by the dispatcher, so
// every constructor's output must be registered — on the right channel, with the
// payload type the registry names.
func TestOutboundFrames_AreRegistered(t *testing.T) {
	r := NewRegistry()
	for _, tc := range outboundWireCases() {
		t.Run(tc.name, func(t *testing.T) {
			frameType, _ := asObject(t, tc.frame)["type"].(string)
			if frameType == "" {
				t.Fatalf("frame carries no type word")
			}
			entry, ok := r.Frame(tc.channel, frameType)
			if !ok {
				t.Fatalf("frame %q is not registered on the %s channel", frameType, tc.channel)
			}
			if entry.Direction != Outbound {
				t.Errorf("frame %q is registered as %s", frameType, entry.Direction)
			}
			if got := reflect.TypeOf(tc.frame); entry.Payload != got {
				t.Errorf("registry names payload %v, constructor builds %v", entry.Payload, got)
			}
		})
	}
}

// Inbound frames are pinned by the JSON clients send today: decoding must land
// every field, and must ignore what the server does not read.
func TestInboundFrames_DecodeFromCurrentClientJSON(t *testing.T) {
	markdown := "# edited"
	cases := []struct {
		name string
		raw  string
		into interface{}
		want interface{}
	}{
		{
			name: "doc-update",
			raw:  `{"type":"doc-update","uuid":"doc-1","markdown":"# hi"}`,
			into: &DocUpdateFrame{},
			want: &DocUpdateFrame{Type: TypeDocUpdate, Markdown: "# hi"},
		},
		{
			// A flush is answered by nobody, so an opId a client still sends is
			// simply not read — the frame carries its type word and nothing else.
			name: "flush",
			raw:  `{"type":"flush","uuid":"doc-1","opId":"op-1"}`,
			into: &FlushFrame{},
			want: &FlushFrame{Type: TypeFlush},
		},
		{
			name: "enter-markdown",
			raw:  `{"type":"enter-markdown","uuid":"doc-1","opId":"op-2"}`,
			into: &EnterMarkdownFrame{},
			want: &EnterMarkdownFrame{Type: TypeEnterMarkdown, OpID: "op-2"},
		},
		{
			name: "enter-wysiwyg carrying the buffer",
			raw:  `{"type":"enter-wysiwyg","uuid":"doc-1","markdown":"# edited","opId":"op-3"}`,
			into: &EnterWysiwygFrame{},
			want: &EnterWysiwygFrame{Type: TypeEnterWysiwyg, Markdown: &markdown, OpID: "op-3"},
		},
		{
			// No markdown field at all must stay distinguishable from an empty
			// document — the pointer is the whole point.
			name: "enter-wysiwyg without a buffer",
			raw:  `{"type":"enter-wysiwyg","uuid":"doc-1"}`,
			into: &EnterWysiwygFrame{},
			want: &EnterWysiwygFrame{Type: TypeEnterWysiwyg},
		},
		{
			name: "retry-block-job",
			raw:  `{"type":"retry-block-job","uuid":"doc-1","id":"b1"}`,
			into: &RetryBlockJobFrame{},
			want: &RetryBlockJobFrame{Type: TypeRetryBlockJob, ID: "b1"},
		},
		{
			name: "extract",
			raw:  `{"type":"extract","opId":"op-4","blockId":"b1","targetKind":"code","operation":"transform","entries":[{"mimeType":"text/plain","content":"x = 1"}],"index":3}`,
			into: &ExtractFrame{},
			want: &ExtractFrame{
				Type: TypeExtract, OpID: "op-4", BlockID: "b1", TargetKind: "code",
				Operation: block.ActionTransform,
				Entries:   []block.ContentEntry{{MIMEType: "text/plain", Content: "x = 1"}},
				Index:     3,
			},
		},
		{
			// The append default is the TYPE's, not a pre-seed the caller must
			// remember: a body with no index key must still append.
			name: "extract with no index",
			raw:  `{"type":"extract","opId":"op-4","blockId":"b1","targetKind":"code","entries":[]}`,
			into: &ExtractFrame{},
			want: &ExtractFrame{
				Type: TypeExtract, OpID: "op-4", BlockID: "b1", TargetKind: "code",
				Entries: []block.ContentEntry{}, Index: AppendIndex,
			},
		},
		{
			name: "load",
			raw:  `{"type":"load","opId":"op-8"}`,
			into: &LoadFrame{},
			want: &LoadFrame{Type: TypeLoad, OpID: "op-8"},
		},
		{
			name: "smart paste",
			raw:  `{"type":"paste","opId":"op-9","kind":"smart","entries":[{"mimeType":"text/plain","content":"https://x"}],"index":3}`,
			into: &PasteFrame{},
			want: &PasteFrame{
				Type: TypePaste, OpID: "op-9", Kind: PasteKindSmart,
				Entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "https://x"}},
				Index:   3,
			},
		},
		{
			name: "smart paste with no index",
			raw:  `{"type":"paste","opId":"op-9","kind":"smart","entries":[]}`,
			into: &PasteFrame{},
			want: &PasteFrame{
				Type: TypePaste, OpID: "op-9", Kind: PasteKindSmart,
				Entries: []block.ContentEntry{}, Index: AppendIndex,
			},
		},
		{
			name: "slice paste",
			raw:  `{"type":"paste","opId":"op-9","kind":"slice","slice":[[{"mimeType":"text/plain","content":"a"}]],"index":0}`,
			into: &PasteFrame{},
			want: &PasteFrame{
				Type: TypePaste, OpID: "op-9", Kind: PasteKindSlice,
				Slice: [][]block.ContentEntry{{{MIMEType: "text/plain", Content: "a"}}},
				Index: 0,
			},
		},
		{
			name: "detect-extractions",
			raw:  `{"type":"detect-extractions","opId":"op-10","sourceKind":"prose","entries":[{"mimeType":"text/plain","content":"x = 1"}]}`,
			into: &DetectExtractionsFrame{},
			want: &DetectExtractionsFrame{
				Type: TypeDetectExtractions, OpID: "op-10", SourceKind: "prose",
				Entries: []block.ContentEntry{{MIMEType: "text/plain", Content: "x = 1"}},
			},
		},
		{
			name: "export",
			raw:  `{"type":"export","opId":"op-11","format":"markdown"}`,
			into: &ExportFrame{},
			want: &ExportFrame{Type: TypeExport, OpID: "op-11", Format: "markdown"},
		},
		{
			name: "focus",
			raw:  `{"type":"focus"}`,
			into: &FocusFrame{},
			want: &FocusFrame{Type: TypeFocus},
		},
		{
			name: "session-scroll",
			raw:  `{"type":"session-scroll","id":"doc-1","scroll":240}`,
			into: &SessionScrollFrame{},
			want: &SessionScrollFrame{Type: TypeSessionScroll, ID: "doc-1", Scroll: 240},
		},
		{
			name: "block-op",
			raw:  `{"type":"block-op","opId":"op-5","uuid":"doc-1","op":{"type":"create-block","kind":"prose","attrs":{"content":"probe"},"index":0}}`,
			into: &BlockOpFrame{},
			want: &BlockOpFrame{
				Type: TypeBlockOp, OpID: "op-5",
				Op: block.BlockOp{
					Type: "create-block", Kind: "prose",
					Attrs: map[string]interface{}{"content": "probe"},
					Index: 0,
				},
			},
		},
		{
			name: "command",
			raw:  `{"type":"command","family":"ai","cmd":"btw","args":{"text":"why?"},"context":{"docUuid":"doc-1"},"attachments":[{"uri":"sieve://9f2b","title":"Auth Design"}],"body":[{"kind":"prose","attrs":{"id":"el-1","content":"the rest of it"}}],"correlationId":"c-1"}`,
			into: &CommandFrame{},
			want: &CommandFrame{
				Type: TypeCommand, Family: "ai", Cmd: "btw",
				Args:          CommandArgs{Text: "why?"},
				CorrelationID: "c-1",
				Context:       json.RawMessage(`{"docUuid":"doc-1"}`),
				Attachments:   []domain.Attachment{{URI: "sieve://9f2b", Title: "Auth Design"}},
				Body: []CommandBlock{{Kind: "prose", Attrs: map[string]interface{}{
					"id": "el-1", "content": "the rest of it",
				}}},
			},
		},
		{
			// A composed message is a LIST OF BLOCKS of any kind, in the order it
			// was written, each carrying whatever its kind owns.
			name: "command with a multi-kind body",
			raw:  `{"type":"command","cmd":"btw","args":{"text":""},"body":[{"kind":"prose","attrs":{"content":"why does this fail?"}},{"kind":"code","attrs":{"language":"go","source":"x := 1"}},{"kind":"reference","attrs":{"uri":"sieve://9f2b","rel":"attach"}}],"correlationId":"c-2"}`,
			into: &CommandFrame{},
			want: &CommandFrame{
				Type: TypeCommand, Cmd: "btw",
				Args:          CommandArgs{Text: ""},
				CorrelationID: "c-2",
				Body: []CommandBlock{
					{Kind: "prose", Attrs: map[string]interface{}{"content": "why does this fail?"}},
					{Kind: "code", Attrs: map[string]interface{}{"language": "go", "source": "x := 1"}},
					{Kind: "reference", Attrs: map[string]interface{}{"uri": "sieve://9f2b", "rel": "attach"}},
				},
			},
		},
		{
			name: "command-cancel",
			raw:  `{"type":"command-cancel","correlationId":"c-1"}`,
			into: &CommandCancelFrame{},
			want: &CommandCancelFrame{Type: TypeCommandCancel, CorrelationID: "c-1"},
		},
		{
			name: "mention-query",
			raw:  `{"type":"mention-query","q":"auth","limit":8,"correlationId":"c-2"}`,
			into: &MentionQueryFrame{},
			want: &MentionQueryFrame{Type: TypeMentionQuery, Q: "auth", Limit: 8, CorrelationID: "c-2"},
		},
		{
			name: "mention-resolve",
			raw:  `{"type":"mention-resolve","uri":"sieve://9f2b","correlationId":"c-3"}`,
			into: &MentionResolveFrame{},
			want: &MentionResolveFrame{Type: TypeMentionResolve, URI: "sieve://9f2b", CorrelationID: "c-3"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := json.Unmarshal([]byte(tc.raw), tc.into); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if !reflect.DeepEqual(tc.into, tc.want) {
				t.Errorf("decoded frame\n got: %#v\nwant: %#v", tc.into, tc.want)
			}
		})
	}
}

// A composed message survives the wire in the order and the shape it was
// written in: one {kind, attrs} entry per block, no entry rewritten, and no
// `body` key at all on a turn that composed none.
func TestCommandFrame_BodyRoundTrips(t *testing.T) {
	golden := `{"type":"command","cmd":"btw","args":{"text":"why?"},"correlationId":"c-1","body":[{"kind":"prose","attrs":{"content":"first"}},{"kind":"code","attrs":{"language":"go","source":"x := 1"}}]}`

	frame := CommandFrame{
		Type: TypeCommand, Cmd: "btw",
		Args:          CommandArgs{Text: "why?"},
		CorrelationID: "c-1",
		Body: []CommandBlock{
			{Kind: "prose", Attrs: map[string]interface{}{"content": "first"}},
			{Kind: "code", Attrs: map[string]interface{}{"language": "go", "source": "x := 1"}},
		},
	}
	encoded, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != golden {
		t.Errorf("encoded frame\n got: %s\nwant: %s", encoded, golden)
	}

	var back CommandFrame
	if err := json.Unmarshal(encoded, &back); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !reflect.DeepEqual(back, frame) {
		t.Errorf("round-tripped frame\n got: %#v\nwant: %#v", back, frame)
	}

	bodiless, err := json.Marshal(CommandFrame{Type: TypeCommand, Cmd: "btw", CorrelationID: "c-2"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(bodiless), "body") {
		t.Errorf("a turn that composed no body still sent the key: %s", bodiless)
	}
}

// asObject marshals v and decodes it back, so two frames are compared as JSON
// objects rather than as Go values — key order is not part of the contract.
func asObject(t *testing.T, v interface{}) map[string]interface{} {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return obj
}
