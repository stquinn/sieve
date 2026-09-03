package gen

import (
	"reflect"

	"sieve/sieve/protocol"
)

// The types below are the emitters' FIXTURE CONTRACT: a wire small enough to
// read a whole golden file of, exercising each shape the real one contains — an
// embedded payload, a slice, a map, a pointer, a doc: tag, a query: tag.
//
// They live in this package so the godoc walk finds them exactly the way it
// finds the real declarations, which is also what lets the missing-comment rule
// be tested with a type that genuinely has no comment.

// FixturePingFrame is a liveness probe on the fixture wire.
type FixturePingFrame struct {
	Type string `json:"type"`
}

// FixtureOpenFrame asks the fixture wire to open something.
//
// It carries an opId, so it takes part in request/reply and the specs correlate
// its answer to it.
type FixtureOpenFrame struct {
	Type string `json:"type"`
	OpID string `json:"opId,omitempty" doc:"echoed on the reply"`
	Name string `json:"name" doc:"what to open"`
}

// FixtureContent is the body a fixture open answers with.
type FixtureContent struct {
	Body  string            `json:"body"`
	Marks map[string]string `json:"marks,omitempty" doc:"an open bag of annotations"`
}

// FixtureOpenedFrame answers a fixture open. It EMBEDS the content, so the
// content's fields sit at the frame's top level.
type FixtureOpenedFrame struct {
	Type string `json:"type"`
	FixtureContent
	OpID string `json:"opId"`
}

// FixtureTopic is the subject a fixture notice names.
type FixtureTopic string

// FixtureNotice is an uncorrelated broadcast on the fixture wire.
type FixtureNotice struct {
	Type    string       `json:"type"`
	Topic   FixtureTopic `json:"topic"`
	Details []string     `json:"details,omitempty" doc:"lines the client may show"`
	Silent  *bool        `json:"silent,omitempty" doc:"absent leaves the client's own preference alone"`
}

// FixturePatchRequest changes a fixture thing's name.
type FixturePatchRequest struct {
	Owner string `json:"owner" query:"owner" doc:"who is asking; a query parameter, not a body field"`
	Name  string `json:"name" doc:"the new name"`
}

// FixtureCreateRequest makes a fixture thing. Every field travels in the body,
// so this type's own component IS the request body the operation references —
// which FixturePatchRequest, split across the query string, deliberately is not.
type FixtureCreateRequest struct {
	Name string `json:"name" doc:"what to call it"`
}

// FixturePatchResponse reports the version the patch produced.
type FixturePatchResponse struct {
	Version int `json:"version"`
}

type FixtureUndocumentedFrame struct {
	Type string `json:"type"`
}

// fixtureContract is the small wire the emitter goldens are rendered from. It
// declares no home package, so the goldens carry the fixture's own prose and
// nothing quoted out of sieve/protocol — an edit to the real package's godoc
// must not fail an emitter's unit test.
func fixtureContract() Contract {
	return Contract{
		Frames: []protocol.FrameEntry{
			{Channel: protocol.ChannelDocument, Direction: protocol.Inbound, Type: "ping", Payload: reflect.TypeOf(FixturePingFrame{})},
			{Channel: protocol.ChannelDocument, Direction: protocol.Inbound, Type: "open", Payload: reflect.TypeOf(FixtureOpenFrame{})},
			{Channel: protocol.ChannelDocument, Direction: protocol.Outbound, Type: "opened", Payload: reflect.TypeOf(FixtureOpenedFrame{})},
			{Channel: protocol.ChannelWorkspace, Direction: protocol.Outbound, Type: "notice", Payload: reflect.TypeOf(FixtureNotice{})},
		},
		Endpoints: []protocol.EndpointEntry{
			{
				Method: "PATCH", Path: "/api/thing/{id}",
				Request:      reflect.TypeOf(FixturePatchRequest{}),
				Response:     reflect.TypeOf(FixturePatchResponse{}),
				ResponseKind: protocol.ResponseJSON,
			},
			{
				Method: "POST", Path: "/api/thing",
				Request:      reflect.TypeOf(FixtureCreateRequest{}),
				ResponseKind: protocol.ResponseFragment,
				AcceptsForm:  true,
			},
		},
		Topics:   []protocol.Topic{protocol.TopicNotes},
		Features: []string{"fixture-check"},
		Routes: []Route{
			{Method: "GET", Pattern: "/api/ws/document/{uuid}"},
			{Method: "GET", Pattern: "/api/ws/workspace"},
			{Method: "GET", Pattern: "/ui/views/thing"},
			{Method: "PATCH", Pattern: "/api/thing/{id}"},
			{Method: "POST", Pattern: "/api/thing"},
		},
		Commands: []CommandWord{
			{Family: "fixture", Name: "do-a-thing", Description: "Do the fixture thing"},
			{Family: "fixture", Name: "undo-a-thing", Description: "Undo the fixture thing"},
			{Family: "other", Name: "elsewhere", Description: "A verb in a second family"},
		},
		AssetURLPrefix: "/ui/assets/",
		WSSubprotocol:  "fixture.v1",
	}
}
