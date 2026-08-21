package protocol

import (
	"encoding/json"

	"sieve/sieve/block"
)

// AppendIndex is the document position meaning "after everything else". It is the
// DECODE-TIME default of every frame carrying an Index, so a client that sends no
// index appends rather than silently inserting at the top of the document.
const AppendIndex = -1

// DocUpdateFrame carries the markdown-mode buffer's current text to the shadow
// document. It is fire-and-forget — the shadow debounces persistence — so it
// carries no opId and gets no reply.
type DocUpdateFrame struct {
	Type     string `json:"type"`
	Markdown string `json:"markdown" doc:"the whole buffer, not a diff"`
}

// FlushFrame asks the shadow document to persist now rather than on its
// debounce. It is fire-and-forget and deliberately unanswered: a save is a FACT
// about a container, not the outcome of one client's request, so it is published
// to the whole workspace as a container-saved broadcast rather than replied to
// here. A failed save answers nothing — the document stays dirty, which is the
// honest signal — and the server logs why.
type FlushFrame struct {
	Type string `json:"type"`
}

// EnterMarkdownFrame switches the document to markdown mode: the server embeds
// the current block state into markdown and answers with a MarkdownContentFrame
// carrying the merged text to seed the markdown editor.
type EnterMarkdownFrame struct {
	Type string `json:"type"`
	OpID string `json:"opId,omitempty" doc:"echoed on the markdown-content reply"`
}

// EnterWysiwygFrame switches the document to WYSIWYG mode, re-parsing the block
// tree from the markdown the client holds and answering with a
// WysiwygContentFrame.
type EnterWysiwygFrame struct {
	Type string `json:"type"`
	// Markdown is a POINTER so an absent field is distinguishable from an
	// intentionally-empty document: only a present value is adopted as the text to
	// re-parse. A pending doc-update may not have flushed, so the client's textarea
	// value — not the shadow's — is the truth at this moment.
	Markdown *string `json:"markdown,omitempty" doc:"the buffer to re-parse; absent means keep what the shadow holds"`
	OpID     string  `json:"opId,omitempty" doc:"echoed on the wysiwyg-content reply"`
}

// RetryBlockJobFrame re-runs the job of one block that failed or was interrupted.
type RetryBlockJobFrame struct {
	Type string `json:"type"`
	ID   string `json:"id" doc:"the block whose job re-runs"`
}

// ExtractFrame creates a block from selected content — the additive extract/paste
// mechanic and the in-place transform, told apart by Operation.
type ExtractFrame struct {
	Type       string               `json:"type"`
	OpID       string               `json:"opId,omitempty" doc:"echoed on the extract-ack"`
	BlockID    string               `json:"blockId" doc:"the source block: transformed in place, or extracted from"`
	TargetKind string               `json:"targetKind" doc:"the block kind to create"`
	Operation  block.Action         `json:"operation,omitempty" doc:"empty means extract — the additive default"`
	Entries    []block.ContentEntry `json:"entries" doc:"the selection, one entry per clipboard-style view"`
	Index      int                  `json:"index" doc:"document position for the new block; -1 appends, and is the default when the key is absent"`
}

// UnmarshalJSON decodes an extract with Index seeded to AppendIndex. The default
// belongs to the TYPE and not to each caller: a decoder that forgets to pre-seed
// reads a missing index as 0 and inserts at the top of the document.
func (f *ExtractFrame) UnmarshalJSON(data []byte) error {
	// The local type sheds this method, or Unmarshal would call it forever.
	type frame ExtractFrame
	seeded := frame{Index: AppendIndex}
	if err := json.Unmarshal(data, &seeded); err != nil {
		return err
	}
	*f = ExtractFrame(seeded)
	return nil
}

// BlockOpFrame applies one granular operation to the authoritative block tree.
// The op describes the MUTATION; OpID describes the REQUEST, which is why it
// rides the outer envelope rather than the op.
type BlockOpFrame struct {
	Type string        `json:"type"`
	OpID string        `json:"opId,omitempty" doc:"echoed on the block-op-ack; absent means no ack is sent"`
	Op   block.BlockOp `json:"op"`
}

// MarkdownContentFrame is the merged markdown that seeds the markdown editor
// after a mode switch.
type MarkdownContentFrame struct {
	Type     string `json:"type"`
	UUID     string `json:"uuid"`
	Markdown string `json:"markdown" doc:"blocks embedded back into markdown — the whole document"`
	OpID     string `json:"opId,omitempty"`
}

// NewMarkdownContentFrame builds the markdown-mode seed.
func NewMarkdownContentFrame(uuid, markdown string) MarkdownContentFrame {
	return MarkdownContentFrame{Type: TypeMarkdownContent, UUID: uuid, Markdown: markdown}
}

// WithOpID returns the reply correlated to the client's enter-markdown request.
func (f MarkdownContentFrame) WithOpID(opID string) MarkdownContentFrame {
	f.OpID = opID
	return f
}

// WysiwygContentFrame is the re-parsed block list the WYSIWYG editor mounts after
// a mode switch. Without it the editor would mount empty until the next document
// load.
type WysiwygContentFrame struct {
	Type   string                `json:"type"`
	UUID   string                `json:"uuid"`
	Blocks []block.FrontendBlock `json:"blocks"`
	OpID   string                `json:"opId,omitempty"`
}

// NewWysiwygContentFrame builds the WYSIWYG-mode seed.
func NewWysiwygContentFrame(uuid string, blocks []block.FrontendBlock) WysiwygContentFrame {
	return WysiwygContentFrame{Type: TypeWysiwygContent, UUID: uuid, Blocks: blocks}
}

// WithOpID returns the reply correlated to the client's enter-wysiwyg request.
func (f WysiwygContentFrame) WithOpID(opID string) WysiwygContentFrame {
	f.OpID = opID
	return f
}

// AckFrame is the request-correlated outcome of a block-op or an extract. It is
// the opId CARRIER: it is emitted after the operation, and therefore after any
// render-back the operation fired synchronously on the same socket — the
// ordering the client's correlation relies on. A failure sends both this (with
// ok:false) and the generic ErrorFrame; they answer different questions.
type AckFrame struct {
	Type  string `json:"type"`
	OpID  string `json:"opId"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty" doc:"present only when ok is false"`
}

// NewBlockOpAckFrame builds the block-op outcome; a nil err is ok:true.
func NewBlockOpAckFrame(opID string, err error) AckFrame {
	return newAckFrame(TypeBlockOpAck, opID, err)
}

// NewExtractAckFrame builds the extract/transform outcome; a nil err is ok:true.
func NewExtractAckFrame(opID string, err error) AckFrame {
	return newAckFrame(TypeExtractAck, opID, err)
}

func newAckFrame(frameType, opID string, err error) AckFrame {
	ack := AckFrame{Type: frameType, OpID: opID, OK: err == nil}
	if err != nil {
		ack.Error = err.Error()
	}
	return ack
}

// InsertBlockFrame is the render-back for a block the SERVER created: the client
// places this authoritative node at this index as a tracked transaction, and
// never computes a position of its own.
type InsertBlockFrame struct {
	Type     string                 `json:"type"`
	Kind     string                 `json:"kind"`
	ID       string                 `json:"id"`
	Attrs    map[string]interface{} `json:"attrs"`
	Index    int                    `json:"index" doc:"document position to insert at"`
	Markdown string                 `json:"markdown" doc:"markdown-mode buffer only; WYSIWYG renders from attrs"`
	Token    string                 `json:"token" doc:"transient handle echoed from a create-block op, so the client can swap its pending node for the authoritative id"`
}

// NewInsertBlockFrame builds the created-block render-back.
func NewInsertBlockFrame(kind, id string, attrs map[string]interface{}, index int, markdown, token string) InsertBlockFrame {
	return InsertBlockFrame{
		Type:     TypeInsertBlock,
		Kind:     kind,
		ID:       id,
		Attrs:    attrs,
		Index:    index,
		Markdown: markdown,
		Token:    token,
	}
}

// BlockAttrsUpdatedFrame is the render-back for a block whose attrs the server
// changed — a finished job's result, a status transition.
type BlockAttrsUpdatedFrame struct {
	Type  string                 `json:"type"`
	ID    string                 `json:"id"`
	Attrs map[string]interface{} `json:"attrs" doc:"the full attrs bag, not a patch"`
}

// NewBlockAttrsUpdatedFrame builds the updated-block render-back.
func NewBlockAttrsUpdatedFrame(id string, attrs map[string]interface{}) BlockAttrsUpdatedFrame {
	return BlockAttrsUpdatedFrame{Type: TypeBlockAttrsUpdated, ID: id, Attrs: attrs}
}

// ReplaceBlockFrame is the render-back for an in-place transform: one block
// becomes another kind with a new identity, and the client replaces by id rather
// than reloading the document.
type ReplaceBlockFrame struct {
	Type    string                 `json:"type"`
	OldID   string                 `json:"oldId" doc:"the block being replaced; the client matches on it rather than reloading"`
	NewKind string                 `json:"newKind"`
	NewID   string                 `json:"newId" doc:"a transform mints a fresh identity — the new block is not the old one renamed"`
	Attrs   map[string]interface{} `json:"attrs" doc:"the new block's full attrs bag"`
	NewYaml string                 `json:"newYaml" doc:"markdown-mode buffer only"`
}

// NewReplaceBlockFrame builds the transformed-block render-back. Its parameters
// are in the order block.BlockLifecycleListener.OnBlockReplaced receives them
// (oldID, newKind, newID) — the sole caller — because two adjacent string
// parameters that read one way in the listener and the other in the constructor
// transpose silently and produce a frame that is wrong but valid.
func NewReplaceBlockFrame(oldID, newKind, newID string, attrs map[string]interface{}, newYaml string) ReplaceBlockFrame {
	return ReplaceBlockFrame{
		Type:    TypeReplaceBlock,
		OldID:   oldID,
		NewKind: newKind,
		NewID:   newID,
		Attrs:   attrs,
		NewYaml: newYaml,
	}
}

// ErrorFrame reports that an operation failed, in words meant for the user. It is
// uncorrelated: an ack answers "did my request succeed", this says "something went
// wrong here". An unknown inbound frame type is answered with one.
type ErrorFrame struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// NewErrorFrame builds the failure notice.
func NewErrorFrame(message string) ErrorFrame {
	return ErrorFrame{Type: TypeError, Message: message}
}

// None of the frames below carries a uuid: the document channel is bound to one
// document, so "which document" is not an argument. Each HTTP route they replace
// took one, and re-importing that parameter is the mistake to avoid.

// LoadFrame asks for the document this channel is bound to, as the editor mounts
// it.
type LoadFrame struct {
	Type string `json:"type"`
	OpID string `json:"opId,omitempty" doc:"echoed on the load-content reply"`
}

// DocumentContent is a document as the editor mounts it: the buffer, the mode it
// was last in, and — in WYSIWYG — the block list it renders from.
type DocumentContent struct {
	Body string `json:"body" doc:"raw markdown, frontmatter already stripped"`
	Mode string `json:"mode" doc:"wysiwyg | markdown — the mode this document was last in"`
	UUID string `json:"uuid" doc:"empty when nothing was found, which the client treats as an empty document"`
	// Scroll is a per-user VIEW property, not document metadata, so it rides the
	// session's tab list. Zero means park at top — the same answer for a tab never
	// scrolled and a tab never opened, which need no distinction.
	Scroll int `json:"scroll" doc:"the tab's saved scroll offset; 0 parks at the top"`
	// Version is the BASELINE for the container-saved fact: without it a client
	// that waits for its own save to land has nothing to compare the first fact
	// against, and would settle on a debounce write that predates the ask. Same
	// convention as the fact carries — 0 means the container keeps no version
	// history, which is every prompt.
	Version int `json:"version" doc:"the version of the content served here; 0 when the container keeps no version history"`
	// Blocks is what WYSIWYG renders from; markdown mode serves Body only and the
	// client never builds blocks there.
	Blocks []block.FrontendBlock `json:"blocks,omitempty" doc:"WYSIWYG only: the block list, already through the shadow so ids are stable"`
}

// LoadContentFrame answers a load. The content is EMBEDDED so its fields sit at
// the top level of the frame, the same shape the editor already mounts from.
type LoadContentFrame struct {
	Type string `json:"type"`
	DocumentContent
	OpID string `json:"opId,omitempty"`
}

// NewLoadContentFrame builds the load answer.
func NewLoadContentFrame(content DocumentContent) LoadContentFrame {
	return LoadContentFrame{Type: TypeLoadContent, DocumentContent: content}
}

// WithOpID returns the reply correlated to the client's load request.
func (f LoadContentFrame) WithOpID(opID string) LoadContentFrame {
	f.OpID = opID
	return f
}

// PasteKind discriminates what a paste is asking for. It is a REQUEST
// discriminant: it decides which of the request's payload fields is meaningful,
// and what the server does with them.
type PasteKind string

const (
	// PasteKindSmart offers one clipboard's views to the block registry and lets a
	// kind claim them.
	PasteKindSmart PasteKind = "smart"
	// PasteKindSlice reconstructs a copied multi-block selection: an ordered list
	// of per-block view sets, each paste-matched and created with a fresh id.
	PasteKindSlice PasteKind = "slice"
	// PasteKindNativeDrop ingests files dragged in from the desktop. It exists
	// because a WebKitGTK webview never materialises a readable File for a
	// file-manager drag — all the page receives is the `text/uri-list` the OS put
	// on the drag, so the bytes can only be read by the server.
	//
	// It reuses Entries, carrying that one view verbatim: the client forwards what
	// the DataTransfer gave it and interprets nothing.
	PasteKindNativeDrop PasteKind = "native-drop"
)

// PasteFrame hands a clipboard to the server to make sense of. Which of Entries
// and Slice is meaningful follows Kind — reading them the other way round is how
// a discriminated union rots into a bag of optional flags.
type PasteFrame struct {
	Type    string                 `json:"type"`
	OpID    string                 `json:"opId,omitempty" doc:"echoed on the paste-ack"`
	Kind    PasteKind              `json:"kind" doc:"smart | slice | native-drop. SECURITY: native-drop makes the server READ LOCAL FILES named by the entries' file:// URIs, so this wire carries a filesystem-read capability. It is only acceptable because the socket upgrade enforces an origin allow-list that admits the app's own window and refuses foreign browser origins; auth-on-upgrade (#83) must cover this channel."`
	Entries []block.ContentEntry   `json:"entries,omitempty" doc:"smart: the clipboard's views. native-drop: the single text/uri-list view the OS put on the drag"`
	Slice   [][]block.ContentEntry `json:"slice,omitempty" doc:"slice only: one view set per copied block, in order"`
	Index   int                    `json:"index" doc:"document position for the first created block; -1 appends, and is the default when the key is absent"`
}

// UnmarshalJSON decodes a paste with Index seeded to AppendIndex, for the reason
// ExtractFrame.UnmarshalJSON gives.
func (f *PasteFrame) UnmarshalJSON(data []byte) error {
	type frame PasteFrame
	seeded := frame{Index: AppendIndex}
	if err := json.Unmarshal(data, &seeded); err != nil {
		return err
	}
	*f = PasteFrame(seeded)
	return nil
}

// PasteAckFrame answers a paste with what the server made of the clipboard. Its
// body is block.PasteResult — the discriminated union the client switches on —
// whichever kind was pasted, because "what happened to this clipboard" has one
// answer shape.
//
// Any block it created arrives separately as an insert-block render-back, which
// stays the authoritative render signal; the ack exists so the client knows
// whether to consume the caret (outcome block), insert a fragment (content), or
// replay the clipboard locally (none). A slice paste creates several blocks and
// therefore names none of them: its answer is the outcome alone.
type PasteAckFrame struct {
	Type string `json:"type"`
	OpID string `json:"opId"`
	block.PasteResult
	Error string `json:"error,omitempty" doc:"why the paste failed; the outcome is then none, so the client still replays locally"`
}

// NewPasteAckFrame builds the paste answer.
func NewPasteAckFrame(opID string, result block.PasteResult) PasteAckFrame {
	return PasteAckFrame{Type: TypePasteAck, OpID: opID, PasteResult: result}
}

// NewPasteFailedFrame builds the answer to a paste that could not be served. It
// is a separate constructor so a failure can never be emitted claiming an
// outcome that created something.
func NewPasteFailedFrame(opID string, err error) PasteAckFrame {
	f := PasteAckFrame{Type: TypePasteAck, OpID: opID, PasteResult: block.PasteNothing()}
	if err != nil {
		f.Error = err.Error()
	}
	return f
}

// DetectExtractionsFrame asks which blocks a selection could become — the offer
// list behind the extract menu. It creates nothing.
type DetectExtractionsFrame struct {
	Type       string               `json:"type"`
	OpID       string               `json:"opId,omitempty" doc:"echoed on the detect-extractions-result reply"`
	SourceKind string               `json:"sourceKind" doc:"the kind the selection came from; shapes which offers make sense"`
	Entries    []block.ContentEntry `json:"entries" doc:"the selection, one entry per clipboard-style view"`
}

// DetectExtractionsResultFrame is one offer per kind that would accept the
// selection.
type DetectExtractionsResultFrame struct {
	Type   string                   `json:"type"`
	OpID   string                   `json:"opId"`
	Offers []block.SupportedActions `json:"offers" doc:"never null — the menu renders a list, and an empty one means nothing claimed the selection"`
}

// NewDetectExtractionsResultFrame builds the offer list. A nil slice is
// normalised to empty, so the menu never reads a length off null.
func NewDetectExtractionsResultFrame(opID string, offers []block.SupportedActions) DetectExtractionsResultFrame {
	if offers == nil {
		offers = []block.SupportedActions{}
	}
	return DetectExtractionsResultFrame{Type: TypeDetectExtractionsResult, OpID: opID, Offers: offers}
}

// ExportFrame asks for clean whole-document text — the "Copy as Markdown"
// contract, with AI blocks excluded because prior Q&A is conversation, not
// document content. It is a clipboard read, never a download.
type ExportFrame struct {
	Type string `json:"type"`
	OpID string `json:"opId,omitempty" doc:"echoed on the export-content reply"`
	// Format keeps the frame alive for future export targets. Only "markdown"
	// exists; absent defaults to it, and an unknown value is refused rather than
	// silently answered with markdown.
	Format string `json:"format,omitempty" doc:"markdown, the only format there is"`
}

// ExportContentFrame carries the exported document.
type ExportContentFrame struct {
	Type    string `json:"type"`
	OpID    string `json:"opId"`
	Format  string `json:"format" doc:"the format that was produced, echoed — it decides the clipboard's mime type"`
	Content string `json:"content" doc:"the whole exported document"`
}

// NewExportContentFrame builds the export answer.
func NewExportContentFrame(opID, format, content string) ExportContentFrame {
	return ExportContentFrame{Type: TypeExportContent, OpID: opID, Format: format, Content: content}
}

// FocusFrame is the dwell ping: the user is looking at this document, which
// raises its focus count. It is fire-and-forget and deliberately unanswered — the
// old endpoint's response was never read, and a reply nobody consumes is a
// contract nobody maintains.
//
// It is NOT the liveness ping: a backgrounded tab proving it is alive is not a
// human dwelling on a document.
type FocusFrame struct {
	Type string `json:"type"`
}
