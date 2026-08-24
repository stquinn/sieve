package protocol

import (
	"fmt"
	"reflect"
)

// FrameEntry is one frame in the vocabulary: which wire carries it, which way it
// travels, its type word, and the Go type that IS its payload. No prose — the
// payload type's godoc is the documentation of record.
type FrameEntry struct {
	Channel   Channel
	Direction Direction
	Type      string
	Payload   reflect.Type
}

// ResponseKind is what an endpoint's answer IS, which is not the same question as
// what the endpoint does: a mutation that answers with an HTML fragment is still
// an operation and still lives under /api.
type ResponseKind string

const (
	ResponseJSON     ResponseKind = "json"     // a typed body, described by the entry's Response type
	ResponseFragment ResponseKind = "fragment" // HTML for HTMX to swap in; the template is its contract
	ResponseNone     ResponseKind = "none"     // 204, or a body no caller reads
)

// EndpointEntry is one HTTP operation whose contract is typed data. Request
// describes every parameter the operation takes, whichever way they arrive — a
// field that is not a body property carries a query:"…" tag saying so — and is
// nil when the operation takes none.
type EndpointEntry struct {
	Method       string
	Path         string
	Request      reflect.Type
	Response     reflect.Type
	ResponseKind ResponseKind
	// AcceptsForm records that the operation also reads its parameters from an
	// application/x-www-form-urlencoded body under the same field names — one
	// contract in two encodings, which is how a single route serves both a typed
	// client and an HTMX dialog form. The generated spec advertises both request
	// content types for such an operation, so a client that posts a form is not
	// reading a spec that says only JSON is accepted.
	AcceptsForm bool
}

type frameKey struct {
	channel Channel
	typ     string
}

type endpointKey struct {
	method string
	path   string
}

// Registry is the wire vocabulary itself: every frame either side may speak and
// every typed endpoint. Dispatch and emission go through it, so a frame type that
// is not here cannot be spoken, and generation reflects over it rather than
// scraping handler source.
type Registry struct {
	frames        []FrameEntry
	frameIndex    map[frameKey]int
	endpoints     []EndpointEntry
	endpointIndex map[endpointKey]int
}

// NewRegistry builds the contract. It panics on a duplicate registration: the
// table is static, so a collision is a programming error that must not survive
// until a frame is silently dispatched to the wrong handler.
func NewRegistry() *Registry {
	r := &Registry{
		frameIndex:    map[frameKey]int{},
		endpointIndex: map[endpointKey]int{},
	}
	r.registerDocumentFrames()
	r.registerWorkspaceFrames()
	r.registerEndpoints()
	return r
}

func (r *Registry) registerDocumentFrames() {
	r.addFrame(ChannelDocument, Inbound, TypePing, PingFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeDocUpdate, DocUpdateFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeFlush, FlushFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeEnterMarkdown, EnterMarkdownFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeEnterWysiwyg, EnterWysiwygFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeRetryBlockJob, RetryBlockJobFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeExtract, ExtractFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeBlockOp, BlockOpFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeLoad, LoadFrame{})
	r.addFrame(ChannelDocument, Inbound, TypePaste, PasteFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeDetectExtractions, DetectExtractionsFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeExport, ExportFrame{})
	r.addFrame(ChannelDocument, Inbound, TypeFocus, FocusFrame{})

	r.addFrame(ChannelDocument, Outbound, TypePong, PongFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeMarkdownContent, MarkdownContentFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeWysiwygContent, WysiwygContentFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeExtractAck, AckFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeBlockOpAck, AckFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeInsertBlock, InsertBlockFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeBlockAttrsUpdated, BlockAttrsUpdatedFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeReplaceBlock, ReplaceBlockFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeRemoveBlock, RemoveBlockFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeOrderChanged, OrderChangedFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeError, ErrorFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeLoadContent, LoadContentFrame{})
	r.addFrame(ChannelDocument, Outbound, TypePasteAck, PasteAckFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeDetectExtractionsResult, DetectExtractionsResultFrame{})
	r.addFrame(ChannelDocument, Outbound, TypeExportContent, ExportContentFrame{})
}

func (r *Registry) registerWorkspaceFrames() {
	r.addFrame(ChannelWorkspace, Inbound, TypePing, PingFrame{})
	r.addFrame(ChannelWorkspace, Inbound, TypeCommand, CommandFrame{})
	r.addFrame(ChannelWorkspace, Inbound, TypeCommandCancel, CommandCancelFrame{})
	r.addFrame(ChannelWorkspace, Inbound, TypeMentionQuery, MentionQueryFrame{})
	r.addFrame(ChannelWorkspace, Inbound, TypeMentionResolve, MentionResolveFrame{})
	r.addFrame(ChannelWorkspace, Inbound, TypeSessionScroll, SessionScrollFrame{})

	r.addFrame(ChannelWorkspace, Outbound, TypePong, PongFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeCommandResult, CommandResultFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeMentionResult, MentionResultFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeMentionResolved, MentionResolvedFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeInvalidate, InvalidateFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeJobsChanged, JobsChangedFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeContainerDeleted, ContainerDeletedFrame{})
	r.addFrame(ChannelWorkspace, Outbound, TypeContainerSaved, ContainerSavedFrame{})
}

func (r *Registry) registerEndpoints() {
	r.addEndpoint(EndpointEntry{
		Method: "GET", Path: "/api/document/load",
		Request: reflect.TypeOf(DocumentLoadRequest{}), Response: reflect.TypeOf(DocumentContent{}),
		ResponseKind: ResponseJSON,
	})
	r.addEndpoint(EndpointEntry{
		Method: "POST", Path: "/api/document/save",
		Request: reflect.TypeOf(DocumentSaveRequest{}), Response: reflect.TypeOf(DocumentSaveResponse{}),
		ResponseKind: ResponseJSON,
	})
	// The note/folder family is reached from HTMX dialogs as well as from typed
	// callers, so each of these reads a urlencoded body too (requesthandlers'
	// requestBody is the one door both encodings come through).
	r.addEndpoint(EndpointEntry{
		Method: "PATCH", Path: "/api/note/{id}",
		Request: reflect.TypeOf(NotePatchRequest{}), ResponseKind: ResponseFragment,
		AcceptsForm: true,
	})
	r.addEndpoint(EndpointEntry{
		Method: "POST", Path: "/api/folder",
		Request: reflect.TypeOf(FolderCreateRequest{}), ResponseKind: ResponseFragment,
		AcceptsForm: true,
	})
	r.addEndpoint(EndpointEntry{
		Method: "PATCH", Path: "/api/folder/{id}",
		Request: reflect.TypeOf(FolderPatchRequest{}), ResponseKind: ResponseFragment,
		AcceptsForm: true,
	})
	r.addEndpoint(EndpointEntry{
		Method: "POST", Path: "/api/tabs/close",
		Request: reflect.TypeOf(TabsCloseRequest{}), ResponseKind: ResponseFragment,
	})
}

func (r *Registry) addFrame(channel Channel, direction Direction, frameType string, payload interface{}) {
	key := frameKey{channel: channel, typ: frameType}
	if _, exists := r.frameIndex[key]; exists {
		panic(fmt.Sprintf("protocol: frame %q registered twice on the %s channel", frameType, channel))
	}
	r.frameIndex[key] = len(r.frames)
	r.frames = append(r.frames, FrameEntry{
		Channel:   channel,
		Direction: direction,
		Type:      frameType,
		Payload:   reflect.TypeOf(payload),
	})
}

func (r *Registry) addEndpoint(e EndpointEntry) {
	key := endpointKey{method: e.Method, path: e.Path}
	if _, exists := r.endpointIndex[key]; exists {
		panic(fmt.Sprintf("protocol: endpoint %s %s registered twice", e.Method, e.Path))
	}
	r.endpointIndex[key] = len(r.endpoints)
	r.endpoints = append(r.endpoints, e)
}

// Frame looks a frame up by the pair that identifies it on the wire. An
// unregistered type is the zero entry and false — the caller's cue to refuse it
// rather than guess.
func (r *Registry) Frame(channel Channel, frameType string) (FrameEntry, bool) {
	i, ok := r.frameIndex[frameKey{channel: channel, typ: frameType}]
	if !ok {
		return FrameEntry{}, false
	}
	return r.frames[i], true
}

// Frames returns every frame in registration order. The slice is a copy, so a
// consumer cannot edit the contract.
func (r *Registry) Frames() []FrameEntry {
	return append([]FrameEntry(nil), r.frames...)
}

// FramesFor returns one channel's frames travelling one way, in registration
// order — the shape a dispatch table or a channel's documentation needs.
func (r *Registry) FramesFor(channel Channel, direction Direction) []FrameEntry {
	out := []FrameEntry{}
	for _, f := range r.frames {
		if f.Channel == channel && f.Direction == direction {
			out = append(out, f)
		}
	}
	return out
}

// Endpoint looks an endpoint up by method and route pattern (the chi pattern,
// with its parameters, not a filled-in path).
func (r *Registry) Endpoint(method, path string) (EndpointEntry, bool) {
	i, ok := r.endpointIndex[endpointKey{method: method, path: path}]
	if !ok {
		return EndpointEntry{}, false
	}
	return r.endpoints[i], true
}

// Endpoints returns every typed endpoint in registration order, as a copy.
func (r *Registry) Endpoints() []EndpointEntry {
	return append([]EndpointEntry(nil), r.endpoints...)
}

// Topics returns every invalidation topic. The registry owns the list because it
// owns the vocabulary: a client resyncing after a reconnect walks exactly this,
// and a topic missing from it is a view that silently never refreshes.
func (r *Registry) Topics() []Topic {
	return []Topic{TopicNotes, TopicSession, TopicPrompts, TopicLibrary, TopicIntent}
}
