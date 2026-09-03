package protocol

import (
	"reflect"
	"sort"
	"testing"
)

// The vocabulary, spelled out independently of the registration code so that
// deleting a registration fails a test rather than quietly shrinking the wire.
func TestRegistry_HoldsTheWholeVocabulary(t *testing.T) {
	cases := []struct {
		channel   Channel
		direction Direction
		want      []string
	}{
		{ChannelDocument, Inbound, []string{
			"ping", "doc-update", "flush", "enter-markdown", "enter-wysiwyg",
			"retry-block-job", "extract", "block-op",
			"load", "paste", "detect-extractions", "export", "focus", "text-replace",
			"feature-control",
		}},
		{ChannelDocument, Outbound, []string{
			"pong", "markdown-content", "wysiwyg-content", "extract-ack",
			"block-op-ack", "insert-block", "block-attrs-updated", "replace-block",
			"remove-block", "order-changed", "error",
			"load-content", "paste-ack", "detect-extractions-result", "export-content",
			"text-marks", "text-replace-ack",
		}},
		{ChannelWorkspace, Inbound, []string{
			"ping", "command", "command-cancel", "mention-query", "mention-resolve",
			"session-scroll", "spell-ignore", "spell-learn", "feature-control",
		}},
		{ChannelWorkspace, Outbound, []string{
			"pong", "command-result", "mention-result", "mention-resolved",
			"invalidate", "jobs-changed", "container-deleted", "container-saved",
		}},
	}

	r := NewRegistry()
	for _, tc := range cases {
		t.Run(string(tc.channel)+" "+string(tc.direction), func(t *testing.T) {
			got := []string{}
			for _, f := range r.FramesFor(tc.channel, tc.direction) {
				got = append(got, f.Type)
			}
			sort.Strings(got)
			want := append([]string(nil), tc.want...)
			sort.Strings(want)
			if !reflect.DeepEqual(got, want) {
				t.Errorf("vocabulary\n got: %v\nwant: %v", got, want)
			}
		})
	}
}

// ONE SHAPE, TWO WIRES. The control frame is registered on both channels with
// the same payload, because the channel — not a field — is what says which scope
// a switch speaks for. Two payloads would be two grammars wearing one word.
func TestRegistry_FeatureControlIsOneShapeOnBothChannels(t *testing.T) {
	r := NewRegistry()
	document, onDocument := r.Frame(ChannelDocument, TypeFeatureControl)
	workspace, onWorkspace := r.Frame(ChannelWorkspace, TypeFeatureControl)
	if !onDocument || !onWorkspace {
		t.Fatalf("feature-control registered on document=%v workspace=%v, want both", onDocument, onWorkspace)
	}
	if document.Payload != workspace.Payload {
		t.Errorf("payloads differ: %v vs %v", document.Payload, workspace.Payload)
	}
	if document.Direction != Inbound || workspace.Direction != Inbound {
		t.Errorf("directions = (%s, %s), want both inbound — nothing answers a switch", document.Direction, workspace.Direction)
	}
}

// Retired words must not be speakable. block-extracted was emitted for months and
// dropped by every client; the SSE event names are what invalidate topics
// replaced, and they are event names, not frame types.
func TestRegistry_RetiredVocabularyIsAbsent(t *testing.T) {
	r := NewRegistry()
	for _, retired := range []string{
		"block-extracted",
		// The lifecycle grammar replaced them: a per-producer verb and a
		// spelling-only marks push are exactly what the control frame and the
		// feature-carrying push are there to make unnecessary.
		"spell-enable", "spell-marks",
		"notes:changed", "session:changed", "prompts:changed", "jobs:changed", "intent:changed",
	} {
		for _, channel := range []Channel{ChannelDocument, ChannelWorkspace} {
			if _, ok := r.Frame(channel, retired); ok {
				t.Errorf("%q is registered on the %s channel", retired, channel)
			}
		}
	}
}

// The channel razor moved these operations onto a wire. Leaving the endpoint
// registered would keep generating a contract for a route nobody serves, which is
// how a deleted endpoint comes back as documentation.
func TestRegistry_RazoredEndpointsAreAbsent(t *testing.T) {
	r := NewRegistry()
	for _, e := range []struct{ method, path string }{
		{"GET", "/api/document/export"},
		{"POST", "/api/document/paste"},
		{"POST", "/api/document/detect-extractions"},
		{"GET", "/api/jobs"},
		{"POST", "/api/jobs/{kind}/{id}"},
	} {
		if _, ok := r.Endpoint(e.method, e.path); ok {
			t.Errorf("%s %s is still registered", e.method, e.path)
		}
	}
	// The two that survive on HTTP are a PAIR, and they survive for one reason: a
	// prompt pseudo-document opens no channel, so it has no wire to read along and
	// none to flush along. Keeping only one of them would leave a prompt loadable
	// but unsavable, or the reverse.
	for _, e := range []struct{ method, path string }{
		{"GET", "/api/document/load"},
		{"POST", "/api/document/save"},
	} {
		if _, ok := r.Endpoint(e.method, e.path); !ok {
			t.Errorf("%s %s is not registered", e.method, e.path)
		}
	}
}

// A parameter that does not travel in the body must SAY so in a tag rather than
// only in prose: the generator places parameters from the tag, and a field it
// reads as a body property becomes one in the schema.
func TestEndpointRequests_MarkNonBodyFieldsWithQueryTags(t *testing.T) {
	for _, req := range []struct {
		name string
		typ  reflect.Type
	}{
		{"DocumentLoadRequest", reflect.TypeOf(DocumentLoadRequest{})},
		{"DocumentSaveRequest", reflect.TypeOf(DocumentSaveRequest{})},
	} {
		field, ok := req.typ.FieldByName("UUID")
		if !ok {
			t.Fatalf("%s has no UUID field", req.name)
		}
		if got := field.Tag.Get("query"); got != "uuid" {
			t.Errorf(`%s.UUID query tag is %q, want "uuid"`, req.name, got)
		}
	}
}

func TestRegistry_UnknownFrameIsRefused(t *testing.T) {
	r := NewRegistry()
	if entry, ok := r.Frame(ChannelDocument, "no-such-frame"); ok || entry != (FrameEntry{}) {
		t.Errorf("unknown frame answered %#v, %v", entry, ok)
	}
	// A channel's words are its own: a workspace frame arriving on a document
	// socket is as unknown as one nobody defined.
	if _, ok := r.Frame(ChannelDocument, TypeCommand); ok {
		t.Error("a workspace frame resolved on the document channel")
	}
	if _, ok := r.Frame(ChannelWorkspace, TypeBlockOp); ok {
		t.Error("a document frame resolved on the workspace channel")
	}
}

func TestRegistry_DuplicateRegistrationPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("registering a frame twice was accepted")
		}
	}()
	r := NewRegistry()
	r.addFrame(ChannelDocument, Inbound, TypeBlockOp, BlockOpFrame{})
}

func TestRegistry_DuplicateEndpointPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("registering an endpoint twice was accepted")
		}
	}()
	r := NewRegistry()
	r.addEndpoint(EndpointEntry{Method: "POST", Path: "/api/document/save", ResponseKind: ResponseNone})
}

// Every frame must name a payload type: it is the only place the frame's fields
// and its documentation live.
func TestRegistry_EveryFrameNamesAStructPayload(t *testing.T) {
	for _, f := range NewRegistry().Frames() {
		if f.Payload == nil {
			t.Errorf("%s/%s has no payload type", f.Channel, f.Type)
			continue
		}
		if f.Payload.Kind() != reflect.Struct {
			t.Errorf("%s/%s payload is %v, not a struct", f.Channel, f.Type, f.Payload.Kind())
		}
		if _, ok := f.Payload.FieldByName("Type"); !ok {
			t.Errorf("%s/%s payload %v has no Type field to carry its type word", f.Channel, f.Type, f.Payload)
		}
	}
}

// An endpoint earns a registry entry by having typed data in some direction —
// that type is where its documentation lives. One with neither has nowhere to be
// documented and belongs in the route inventory instead.
func TestRegistry_EveryEndpointCarriesATypedContract(t *testing.T) {
	for _, e := range NewRegistry().Endpoints() {
		if e.Request == nil && e.Response == nil {
			t.Errorf("%s %s has neither a request nor a response type", e.Method, e.Path)
		}
		if e.ResponseKind == ResponseJSON && e.Response == nil {
			t.Errorf("%s %s answers json but names no response type", e.Method, e.Path)
		}
		if e.ResponseKind != ResponseJSON && e.Response != nil {
			t.Errorf("%s %s names a response type but answers %s", e.Method, e.Path, e.ResponseKind)
		}
	}
}

// AcceptsForm is what the generated spec advertises a second request encoding
// off, so the flag has to match which handlers actually read a urlencoded body
// (requesthandlers' requestBody). An endpoint that grows form-reading and does
// not declare it here ships a spec saying only JSON is accepted.
func TestRegistry_EndpointsDeclareTheEncodingsTheyAccept(t *testing.T) {
	form := map[string]bool{
		"PATCH /api/note/{id}":   true,
		"POST /api/folder":       true,
		"PATCH /api/folder/{id}": true,
	}
	for _, e := range NewRegistry().Endpoints() {
		key := e.Method + " " + e.Path
		if e.AcceptsForm != form[key] {
			t.Errorf("%s AcceptsForm = %v, want %v", key, e.AcceptsForm, form[key])
		}
	}
}

func TestRegistry_EndpointLookup(t *testing.T) {
	r := NewRegistry()
	entry, ok := r.Endpoint("POST", "/api/document/save")
	if !ok {
		t.Fatal("save is not registered")
	}
	if entry.Request != reflect.TypeOf(DocumentSaveRequest{}) {
		t.Errorf("save request type is %v", entry.Request)
	}
	if entry.Response != reflect.TypeOf(DocumentSaveResponse{}) {
		t.Errorf("save response type is %v", entry.Response)
	}
	if entry, ok := r.Endpoint("POST", "/api/nothing"); ok || entry != (EndpointEntry{}) {
		t.Errorf("unknown endpoint answered %#v, %v", entry, ok)
	}
	// The key is the route PATTERN, not a filled-in path.
	if _, ok := r.Endpoint("PATCH", "/api/note/9f2b"); ok {
		t.Error("a concrete path matched a parameterised pattern")
	}
}

// The topics ARE the invalidation vocabulary: one frame type carries a topic as
// data, and this list is both what may be sent and what a reconnecting client
// resyncs on. A topic missing from it is a view that silently never refreshes.
func TestRegistry_TopicsAreTheInvalidationVocabulary(t *testing.T) {
	got := []string{}
	for _, topic := range NewRegistry().Topics() {
		got = append(got, string(topic))
	}
	sort.Strings(got)
	want := []string{"intent", "library", "notes", "prompts", "session"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("topics\n got: %v\nwant: %v", got, want)
	}
}

// The contract cannot be edited through what a lookup hands back.
func TestRegistry_ExposesCopies(t *testing.T) {
	r := NewRegistry()
	frames := r.Frames()
	frames[0].Type = "mutated"
	if r.Frames()[0].Type == "mutated" {
		t.Error("editing a returned frame changed the registry")
	}
	endpoints := r.Endpoints()
	endpoints[0].Path = "/mutated"
	if r.Endpoints()[0].Path == "/mutated" {
		t.Error("editing a returned endpoint changed the registry")
	}
}
