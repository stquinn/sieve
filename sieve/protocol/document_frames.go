package protocol

import (
	"encoding/json"
	"errors"

	"sieve/sieve/block"
	"sieve/sieve/domain"
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
}

// NewInsertBlockFrame builds the created-block render-back.
func NewInsertBlockFrame(kind, id string, attrs map[string]interface{}, index int, markdown string) InsertBlockFrame {
	return InsertBlockFrame{
		Type:     TypeInsertBlock,
		Kind:     kind,
		ID:       id,
		Attrs:    attrs,
		Index:    index,
		Markdown: markdown,
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

// ReplaceBlockFrame is the render-back for a block the SERVER rewrote in place:
// an in-place transform, or a text edit the client asked for and Go executed.
// The client replaces by id rather than reloading the document, and takes the
// block WHOLE — this frame is the authoritative block, never a patch onto what
// the client is holding.
//
// It is the render-back for a change the client did not compute. A change the
// client already holds the result of — its own edit, echoed — goes back as a
// BlockAttrsUpdatedFrame instead.
type ReplaceBlockFrame struct {
	Type    string                 `json:"type"`
	OldID   string                 `json:"oldId" doc:"the block being replaced; the client matches on it rather than reloading"`
	NewKind string                 `json:"newKind"`
	NewID   string                 `json:"newId" doc:"equal to oldId when the block kept its identity; a transform to another kind mints a fresh one"`
	Attrs   map[string]interface{} `json:"attrs" doc:"the new block's full attrs bag"`
	NewYaml string                 `json:"newYaml" doc:"markdown-mode buffer only"`
}

// NewReplaceBlockFrame builds the replaced-block render-back. Its parameters
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

// RemoveBlockFrame is the render-back for a block that left the container: the
// client retires it by id rather than reloading the document.
//
// A block the server rewrote is NOT a removal — it keeps its slot and says so
// with a replace-block, which carries both ids. This frame means the container
// has one child fewer.
type RemoveBlockFrame struct {
	Type string `json:"type"`
	ID   string `json:"id" doc:"the block that left the container"`
}

// NewRemoveBlockFrame builds the removed-block render-back.
func NewRemoveBlockFrame(id string) RemoveBlockFrame {
	return RemoveBlockFrame{Type: TypeRemoveBlock, ID: id}
}

// OrderChangedFrame is the render-back for a reorder. It carries the COMPLETE
// child order for the same reason the set-order op does: applying a whole order
// is idempotent, so a duplicate or out-of-sequence frame lands the client in the
// same place, while a delta would not.
//
// It names no block that arrived or left — those have their own frames — so a
// client folds it as a permutation of what it already holds.
type OrderChangedFrame struct {
	Type  string   `json:"type"`
	Order []string `json:"order" doc:"the container's complete child id order, first position to last"`
}

// NewOrderChangedFrame builds the reorder render-back. A nil order is normalised
// to empty, so a client never reads a length off null.
func NewOrderChangedFrame(order []string) OrderChangedFrame {
	if order == nil {
		order = []string{}
	}
	return OrderChangedFrame{Type: TypeOrderChanged, Order: order}
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
	// PasteKindNativeClipboard asks the server to read the OS clipboard itself.
	//
	// It exists because WebKitGTK hands the page a paste event whose DataTransfer
	// is COMPLETELY EMPTY for a screenshot copied by a normal desktop tool — no
	// types, no items, no files (#87) — while any ordinary GTK process reads the
	// same offer fine. That emptiness is the whole signal, which is why this kind
	// carries no Entries: there is nothing for the client to forward.
	PasteKindNativeClipboard PasteKind = "native-clipboard"
)

// PasteFrame hands a clipboard to the server to make sense of. Which of Entries
// and Slice is meaningful follows Kind — reading them the other way round is how
// a discriminated union rots into a bag of optional flags.
type PasteFrame struct {
	Type    string                 `json:"type"`
	OpID    string                 `json:"opId,omitempty" doc:"echoed on the paste-ack"`
	Kind    PasteKind              `json:"kind" doc:"smart | slice | native-drop | native-clipboard. SECURITY: native-drop and native-clipboard make the server read files the NATIVE side caught (the drop bucket) or the OS clipboard names — never paths from the wire, so the wire carries the GESTURE, not a filesystem address. The socket upgrade gates keep these to the app's own page: an origin allow-list refuses a foreign browser page, and a per-run token refuses every other local process."`
	Entries []block.ContentEntry   `json:"entries,omitempty" doc:"smart: the clipboard's views. native-drop: absent — the server takes the paths from the native drop bucket the OS-level catch fed (Wails OnFileDrop); the page's own view of a drop is never consulted. native-clipboard: absent — the server reads the clipboard itself"`
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

// SpellMark is one flagged run of text inside a block, as it travels on the
// wire. It carries no block id — the frame that holds it names the block once.
//
// It anchors by Quote plus Occurrence, never by offsets: the client resolves
// occurrence N of the quote in the text it currently holds and marks it WHERE IT
// NOW SITS. Start and End are byte offsets into the segment as the server read
// it, and any edit since displaces them, so they are a fast-path hint. A quote
// that no longer resolves at its occurrence is dropped rather than guessed at.
type SpellMark struct {
	Locator     string   `json:"locator" doc:"which part of the block's payload this came from; opaque — only the block's processor reads it"`
	Quote       string   `json:"quote" doc:"the exact text flagged; the anchor, not a label"`
	Occurrence  int      `json:"occurrence" doc:"0-based index among identical quotes in the same segment"`
	Start       int      `json:"start" doc:"byte offset hint into the segment as the server read it"`
	End         int      `json:"end" doc:"byte offset hint, exclusive"`
	Class       string   `json:"class" doc:"the kind of language the segment holds — prose, code, label, caption, key"`
	Suggestions []string `json:"suggestions" doc:"never null — replacements offered for the quote, best first"`
}

// SpellMarksFrame is the server-initiated render-back carrying ONE block's
// complete mark set. It is not an answer to anything: the server checks a
// document when it opens and whenever its text settles, and pushes to the
// document's registered owner.
//
// Marks REPLACE what the client holds for that block. An empty array is
// therefore the clear — the frame a corrected block gets — and not a no-op.
type SpellMarksFrame struct {
	Type    string      `json:"type"`
	BlockID string      `json:"blockId" doc:"the block whose whole mark set this is"`
	Marks   []SpellMark `json:"marks" doc:"never null — an empty array clears this block's marks"`
}

// NewSpellMarksFrame builds one block's mark set for the wire, dropping the
// block id each mark carries in Go: the frame names the block, so repeating it
// per mark would let the two disagree.
func NewSpellMarksFrame(blockID string, marks []domain.TextMark) SpellMarksFrame {
	wire := make([]SpellMark, 0, len(marks))
	for _, m := range marks {
		suggestions := m.Suggestions
		if suggestions == nil {
			suggestions = []string{}
		}
		wire = append(wire, SpellMark{
			Locator:     m.Locator,
			Quote:       m.Quote,
			Occurrence:  m.Occurrence,
			Start:       m.Start,
			End:         m.End,
			Class:       m.Class,
			Suggestions: suggestions,
		})
	}
	return SpellMarksFrame{Type: TypeSpellMarks, BlockID: blockID, Marks: wire}
}

// TextReplaceFrame asks for one anchored run of a block's text to be replaced.
// It is the write the marks made possible: the client points at text it was
// shown and says what belongs there instead.
//
// The anchor is Quote plus Occurrence, and the server resolves it in the
// block's CURRENT text — so an edit that displaced the run since the client saw
// it costs nothing, and a run that has been typed over is not written to at
// all. Start and End are the offsets the client last saw: a hint the server may
// use to narrow a search, never a range it writes to on the client's word.
type TextReplaceFrame struct {
	Type        string `json:"type"`
	OpID        string `json:"opId"`
	BlockID     string `json:"blockId" doc:"the block whose text is being written"`
	Locator     string `json:"locator" doc:"which part of the block's payload, exactly as the mark carried it; opaque — only the block's processor reads it"`
	Quote       string `json:"quote" doc:"the exact text to replace; the anchor, not a label"`
	Occurrence  int    `json:"occurrence" doc:"0-based index among identical quotes in the same segment"`
	Start       int    `json:"start" doc:"byte offset hint into the segment as the client last saw it"`
	End         int    `json:"end" doc:"byte offset hint, exclusive"`
	Replacement string `json:"replacement" doc:"what to put in the quote's place; an empty string deletes the run"`
}

// Edit reads the frame as the edit the editor applies. The frame is the wire
// form and the edit is the domain form of one request, so the mapping lives
// here rather than at every call site that would otherwise copy nine fields.
func (f TextReplaceFrame) Edit() domain.TextEdit {
	return domain.TextEdit{
		BlockID:     f.BlockID,
		Locator:     f.Locator,
		Quote:       f.Quote,
		Occurrence:  f.Occurrence,
		Start:       f.Start,
		End:         f.End,
		Replacement: f.Replacement,
	}
}

// What a text-replace did. STALE is not a failure: the anchor named a run that
// is no longer there, the document was left exactly as it was, and the client's
// answer is to drop the mark it was acting on rather than to retry or report a
// fault.
const (
	TextReplaceOK     = "ok"
	TextReplaceStale  = "stale"
	TextReplaceFailed = "error"
)

// TextReplaceAckFrame is the correlated outcome of a text-replace. Like every
// ack it is emitted AFTER the operation, and therefore after the render-back
// the operation fired on the same socket.
//
// An applied edit reaches the client as the authoritative block, not as
// anything carried here: this frame reports only which of the three things
// happened.
type TextReplaceAckFrame struct {
	Type    string `json:"type"`
	OpID    string `json:"opId"`
	Outcome string `json:"outcome" doc:"ok — applied; stale — the quote no longer resolves at its occurrence and nothing changed; error — the request could not be run"`
	Error   string `json:"error,omitempty" doc:"present only when outcome is error"`
}

// NewTextReplaceAckFrame builds the outcome, reading a stale anchor out of the
// error the editor returned. The sentinel and the wire word are mapped in ONE
// place so they cannot drift apart.
func NewTextReplaceAckFrame(opID string, err error) TextReplaceAckFrame {
	switch {
	case err == nil:
		return TextReplaceAckFrame{Type: TypeTextReplaceAck, OpID: opID, Outcome: TextReplaceOK}
	case errors.Is(err, block.ErrTextStale):
		return TextReplaceAckFrame{Type: TypeTextReplaceAck, OpID: opID, Outcome: TextReplaceStale}
	default:
		return TextReplaceAckFrame{Type: TypeTextReplaceAck, OpID: opID, Outcome: TextReplaceFailed, Error: err.Error()}
	}
}
