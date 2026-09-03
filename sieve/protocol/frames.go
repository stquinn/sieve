package protocol

// Channel names a WebSocket wire. The two are different protocols, not two uses
// of one: a document channel is bound to one open document (it has a shadow, and
// a mutating frame claims listener ownership on it), while a workspace channel is
// bound to the app window and carries many tenants' traffic plus server-initiated
// broadcasts. "Editor" names the UI component that consumes the document wire,
// never the wire itself; "session" names domain.Session panel state under
// /api/session/*, never this channel.
type Channel string

const (
	ChannelDocument  Channel = "document"  // GET /api/ws/document/{uuid}
	ChannelWorkspace Channel = "workspace" // GET /api/ws/workspace
)

// WSSubprotocol is the subprotocol a dial on either wire negotiates, and the
// server selects it on every accepted upgrade.
//
// It is half of a credential, not decoration. Both wires ride the loopback
// listener — WebKitGTK cannot carry an upgrade over the app's custom scheme —
// and any local process can reach that listener, so an upgrade must prove it
// comes from the shell this run served. The browser WebSocket API cannot set a
// request header, so the proof rides the one list it can send: a client offers
// this word FIRST and the run's token SECOND. The server answers with this word
// alone, so the token appears in no response header.
const WSSubprotocol = "sieve.v1"

// Direction is which way a frame travels.
type Direction string

const (
	Inbound  Direction = "inbound"  // client → server
	Outbound Direction = "outbound" // server → client
)

// Frame type words. Every frame carries its type in the `type` field, and Go
// spells one only through these constants — a literal is how a wire word drifts
// out of the Registry.
const (
	// Both channels.
	TypePing = "ping"
	TypePong = "pong"

	// Document channel, client → server.
	TypeDocUpdate         = "doc-update"
	TypeFlush             = "flush"
	TypeEnterMarkdown     = "enter-markdown"
	TypeEnterWysiwyg      = "enter-wysiwyg"
	TypeRetryBlockJob     = "retry-block-job"
	TypeExtract           = "extract"
	TypeBlockOp           = "block-op"
	TypeLoad              = "load"
	TypePaste             = "paste"
	TypeDetectExtractions = "detect-extractions"
	TypeExport            = "export"
	TypeFocus             = "focus"
	TypeTextReplace       = "text-replace"

	// Both channels, client → server. Which channel a feature-control frame
	// arrives on IS the scope it speaks for: the workspace wire controls a
	// workspace-wide feature, a document channel controls that document's.
	TypeFeatureControl = "feature-control"

	// Document channel, server → client.
	TypeMarkdownContent         = "markdown-content"
	TypeWysiwygContent          = "wysiwyg-content"
	TypeExtractAck              = "extract-ack"
	TypeBlockOpAck              = "block-op-ack"
	TypeInsertBlock             = "insert-block"
	TypeBlockAttrsUpdated       = "block-attrs-updated"
	TypeReplaceBlock            = "replace-block"
	TypeRemoveBlock             = "remove-block"
	TypeOrderChanged            = "order-changed"
	TypeError                   = "error"
	TypeLoadContent             = "load-content"
	TypePasteAck                = "paste-ack"
	TypeDetectExtractionsResult = "detect-extractions-result"
	TypeExportContent           = "export-content"
	TypeTextMarks               = "text-marks"
	TypeTextReplaceAck          = "text-replace-ack"

	// Workspace channel, client → server.
	TypeCommand        = "command"
	TypeCommandCancel  = "command-cancel"
	TypeMentionQuery   = "mention-query"
	TypeMentionResolve = "mention-resolve"
	TypeSessionScroll  = "session-scroll"
	TypeSpellIgnore    = "spell-ignore"
	TypeSpellLearn     = "spell-learn"

	// Workspace channel, server → client.
	TypeCommandResult    = "command-result"
	TypeMentionResult    = "mention-result"
	TypeMentionResolved  = "mention-resolved"
	TypeInvalidate       = "invalidate"
	TypeJobsChanged      = "jobs-changed"
	TypeContainerDeleted = "container-deleted"
	TypeContainerSaved   = "container-saved"
)

// Topic is what an invalidate frame invalidates — the subject a view refetches
// when it hears one. Topics are DATA on a single frame type, deliberately: a new
// subject to invalidate is a new constant here, never a new frame type, so the
// vocabulary the two sides must agree on stays fixed.
type Topic string

const (
	TopicNotes   Topic = "notes"   // the note/folder tree changed
	TopicSession Topic = "session" // tabs, active tab, or panel state changed
	TopicPrompts Topic = "prompts" // the prompt library changed
	TopicLibrary Topic = "library" // the open library changed
	TopicIntent  Topic = "intent"  // a document's user_intent changed
)

// PingFrame is a liveness probe, answered with a PongFrame. Both channels carry
// it. On the document channel it is deliberately NOT a mutating frame: a
// backgrounded tab proving it is alive is not evidence a human is editing there,
// so it must never steal listener ownership from the tab that is.
type PingFrame struct {
	Type string `json:"type"`
}

// PongFrame answers a PingFrame.
type PongFrame struct {
	Type string `json:"type"`
}

// NewPongFrame builds the liveness reply.
func NewPongFrame() PongFrame { return PongFrame{Type: TypePong} }

// FeatureControlFrame switches one text-service feature on or off, and says what
// it is to work with. It is the WHOLE lifecycle grammar for every producer that
// reads the text substrate — present and future — so a new feature is a new
// registered inspector and a new word in Feature, never a new frame type.
//
// THE CHANNEL IS THE SCOPE. On the workspace wire it speaks for a feature that
// has one answer for the whole app (spelling, which is persisted); on a document
// channel it speaks for that document alone (a find whose term dies with the
// dialog). There is deliberately no scope field: a frame cannot claim a reach its
// socket does not have, and a document channel closing is the implicit disable
// for everything it switched on.
//
// Parameters is the feature's own business — a search term, a case flag, an
// imperative like replace-all — carried and never read by the framework, so a
// feature's options cost the wire nothing.
type FeatureControlFrame struct {
	Type       string         `json:"type"`
	Feature    string         `json:"feature" doc:"which producer this is about; a word from the registered feature vocabulary, refused when nothing serves it"`
	Enabled    bool           `json:"enabled" doc:"the state the feature is being put INTO, not a request to flip"`
	Parameters map[string]any `json:"parameters,omitempty" doc:"what the feature is to work with; interpreted by that feature alone"`
}
