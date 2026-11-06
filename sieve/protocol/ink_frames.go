package protocol

import "sieve/sieve/block"

// The ink frames ride the document channel of a Digital Note's block container. The page list,
// the title and every other page-level fact are the block's attrs and arrive as the block's attrs
// frame; these carry what is drawn on a page. Every frame but the page answer is pushed, never
// replayed and never part of a load: a client that missed one asks for the page again.

// InkPageFrame asks for one page of this channel's Digital Note as it is drawn now.
type InkPageFrame struct {
	Type   string `json:"type"`
	OpID   string `json:"opId,omitempty" doc:"echoed on the ink-page-content reply"`
	PageID string `json:"pageId" doc:"the page's id, as the block's note.pages lists it"`
}

// InkPageContentFrame answers an ink-page: the page in the export shape and the seq of the last
// record it reflects, or why there is none. A client holding the page drops every stroke frame for
// it whose seq is at or below Seq; every later change to the page arrives as a stroke frame above
// it.
type InkPageContentFrame struct {
	Type   string         `json:"type"`
	OpID   string         `json:"opId,omitempty"`
	PageID string         `json:"pageId" doc:"the page asked for, echoed"`
	Seq    uint32         `json:"seq" doc:"the seq of the last record of the note's log the page reflects; 0 when refused"`
	Page   *InkPageExport `json:"page" doc:"the page's strokes in the export shape; null when refused"`
	Error  string         `json:"error,omitempty" doc:"present only when there is no page: the channel holds no Digital Note, or the note has no page of that id"`
}

// NewInkPageContentFrame builds the answer carrying page as it stood at seq.
func NewInkPageContentFrame(opID, pageID string, seq uint32, page InkPageExport) InkPageContentFrame {
	return InkPageContentFrame{Type: TypeInkPageContent, OpID: opID, PageID: pageID, Seq: seq, Page: &page}
}

// NewInkPageRefusedFrame builds the answer to an ink-page that names no page there is.
func NewInkPageRefusedFrame(opID, pageID string, err error) InkPageContentFrame {
	return InkPageContentFrame{Type: TypeInkPageContent, OpID: opID, PageID: pageID, Error: err.Error()}
}

// InkStrokeAddedFrame is a stroke now present on a page, committed by the record of Seq.
type InkStrokeAddedFrame struct {
	Type   string          `json:"type"`
	PageID string          `json:"pageId"`
	Seq    uint32          `json:"seq" doc:"the seq of the record that added the stroke"`
	Stroke InkExportStroke `json:"stroke" doc:"the stroke in the export shape a page's strokes take"`
}

// NewInkStrokeAddedFrame builds the added-stroke push.
func NewInkStrokeAddedFrame(pageID string, seq uint32, stroke InkExportStroke) InkStrokeAddedFrame {
	return InkStrokeAddedFrame{Type: TypeInkStrokeAdded, PageID: pageID, Seq: seq, Stroke: stroke}
}

// InkStrokeRemovedFrame is a stroke gone from a page, removed by the record of Seq.
type InkStrokeRemovedFrame struct {
	Type     string `json:"type"`
	PageID   string `json:"pageId"`
	Seq      uint32 `json:"seq" doc:"the seq of the record that removed the stroke"`
	StrokeID string `json:"strokeId"`
}

// NewInkStrokeRemovedFrame builds the removed-stroke push.
func NewInkStrokeRemovedFrame(pageID string, seq uint32, strokeID string) InkStrokeRemovedFrame {
	return InkStrokeRemovedFrame{Type: TypeInkStrokeRemoved, PageID: pageID, Seq: seq, StrokeID: strokeID}
}

// What an InkLiveRecord is.
const (
	InkLiveBegin  = "begin"
	InkLivePoint  = "point"
	InkLiveEnd    = "end"
	InkLiveRemove = "remove"
	InkLiveView   = "view"
)

// InkLiveRecord is one record about the stroke under the pen on the live page, or about the
// window a whiteboard is viewed through, in page units. It is never logged: the committed stroke
// arrives as an ink-stroke-added. A stroke is drawn from its begin; a point whose begin a client
// did not see is dropped.
type InkLiveRecord struct {
	Record     string  `json:"record" doc:"begin | point | end | remove | view"`
	Stroke     uint32  `json:"stroke" doc:"numbers the stroke within one connection to the tablet, not its id; 0 on a view"`
	Tool       string  `json:"tool,omitempty" doc:"begin only: pen | pencil"`
	WidthClass uint8   `json:"widthClass,omitempty" doc:"begin only: 1, 2 or 3"`
	X          float64 `json:"x" doc:"page units: a begin's origin, a point's place, a view's left edge; 0 otherwise"`
	Y          float64 `json:"y" doc:"page units: a begin's origin, a point's place, a view's top edge; 0 otherwise"`
	Pressure   float64 `json:"pressure" doc:"point only: 0 to 1"`
	TMillis    uint32  `json:"tMillis" doc:"point only: milliseconds since its stroke's begin"`
	TiltX      int8    `json:"tiltX" doc:"point only: degrees"`
	TiltY      int8    `json:"tiltY" doc:"point only: degrees"`
}

// InkLiveFrame is live records in the order the tablet sent them. On the Live view's channel, an
// answer for the live page is also followed, after its ink-live-page, by one carrying a single
// view: the tablet's window on that page, when it is known.
type InkLiveFrame struct {
	Type    string          `json:"type"`
	Records []InkLiveRecord `json:"records" doc:"never empty"`
}

// NewInkLiveFrame builds the live push.
func NewInkLiveFrame(records []InkLiveRecord) InkLiveFrame {
	return InkLiveFrame{Type: TypeInkLive, Records: records}
}

// InkLivePageFrame is which page of this channel's note the tablet shows as being written, or
// that none is, and the Live view that mirrors it. Live records reach the channel only while one
// is.
type InkLivePageFrame struct {
	Type   string `json:"type"`
	Live   bool   `json:"live" doc:"false when no page of this note is live any more"`
	PageID string `json:"pageId,omitempty" doc:"the live page; absent when live is false"`
	View   string `json:"view,omitempty" doc:"the uuid of the Live view mirroring the tablet; absent when live is false"`
}

// NewInkLivePageFrame builds the live-page push: pageID live in the Live view of uuid view, or
// none when pageID is "".
func NewInkLivePageFrame(pageID, view string) InkLivePageFrame {
	if pageID == "" {
		return InkLivePageFrame{Type: TypeInkLivePage}
	}
	return InkLivePageFrame{Type: TypeInkLivePage, Live: true, PageID: pageID, View: view}
}

// InkLogRestartedFrame is the note's log started again from its first record in this channel's
// container. Every page answer and seq a client holds for the note is void: it asks for its pages
// again, and the stroke frames that follow are numbered from the new log.
type InkLogRestartedFrame struct {
	Type string `json:"type"`
}

// NewInkLogRestartedFrame builds the restarted-log push.
func NewInkLogRestartedFrame() InkLogRestartedFrame {
	return InkLogRestartedFrame{Type: TypeInkLogRestarted}
}

// InkOpenOnTabletFrame asks the tablet this channel's Digital Note came from to open it at a page.
// Only the note's id and the page's reach the tablet.
type InkOpenOnTabletFrame struct {
	Type   string `json:"type"`
	OpID   string `json:"opId,omitempty" doc:"echoed on the ink-open-on-tablet-result reply"`
	PageID string `json:"pageId,omitempty" doc:"the page to open the note at, as the block's note.pages lists it; absent, or a page the note does not have, leaves the page to the tablet"`
}

// What came of an ink-open-on-tablet.
const (
	InkOpenOpened      = "opened"
	InkOpenNoTablet    = "no-tablet"
	InkOpenOtherTablet = "other-tablet"
	InkOpenRefused     = "refused"
	InkOpenNoAnswer    = "no-answer"
)

// InkOpenOnTabletResultFrame answers an ink-open-on-tablet with what came of it, or why it could
// not be asked.
type InkOpenOnTabletResultFrame struct {
	Type    string `json:"type"`
	OpID    string `json:"opId,omitempty"`
	Outcome string `json:"outcome,omitempty" doc:"opened (the tablet shows the note, live) | no-tablet | other-tablet (a tablet is connected that the note did not come from) | refused | no-answer; absent with error"`
	Reason  string `json:"reason,omitempty" doc:"refused only: the tablet's reason, not-foreground (SieveInk is not in front) | not-offered (the note is not in a folder this Sieve receives) | another"`
	Error   string `json:"error,omitempty" doc:"present only when nothing was asked: the channel holds no Digital Note from a tablet, or ink is unavailable"`
}

// NewInkOpenOnTabletResultFrame builds the answer carrying outcome and, when refused, reason.
func NewInkOpenOnTabletResultFrame(opID, outcome, reason string) InkOpenOnTabletResultFrame {
	return InkOpenOnTabletResultFrame{Type: TypeInkOpenOnTabletResult, OpID: opID, Outcome: outcome, Reason: reason}
}

// NewInkOpenOnTabletFailedFrame builds the answer to an ink-open-on-tablet that asked nothing.
func NewInkOpenOnTabletFailedFrame(opID string, err error) InkOpenOnTabletResultFrame {
	return InkOpenOnTabletResultFrame{Type: TypeInkOpenOnTabletResult, OpID: opID, Error: err.Error()}
}

// InkReadingFrame asks what is known of the reading of one page of this channel's Digital Note.
type InkReadingFrame struct {
	Type   string `json:"type"`
	OpID   string `json:"opId,omitempty" doc:"echoed on the ink-reading-content reply"`
	PageID string `json:"pageId" doc:"the page's id, as the block's note.pages lists it"`
}

// InkReadPageFrame asks for one page of this channel's Digital Note to be read, unless it has a
// reading of what it holds now or is being read. It is answered at once with what is then known of
// the page's reading; the reading's end arrives as an ink-reading-changed.
type InkReadPageFrame struct {
	Type   string `json:"type"`
	OpID   string `json:"opId,omitempty" doc:"echoed on the ink-reading-content reply"`
	PageID string `json:"pageId" doc:"the page's id, as the block's note.pages lists it"`
}

// InkReadingDocumentFrame asks for a new document made from the reading of one page of this
// channel's Digital Note: an ordinary untitled note holding a copy of the reading's blocks, linked
// to nothing. The note and its reading are not changed.
type InkReadingDocumentFrame struct {
	Type   string `json:"type"`
	OpID   string `json:"opId,omitempty" doc:"echoed on the ink-reading-document-result reply"`
	PageID string `json:"pageId" doc:"the page whose reading the document is made from"`
}

// The states of a page's reading.
const (
	InkReadingNone  = "none"
	InkReadingReady = "ready"
	InkReadingStale = "stale"
)

// InkReading is what is known of the reading of one page.
type InkReading struct {
	State       string                `json:"state" doc:"none | ready (a reading of the page as it is now) | stale (a reading of the page as it was before it changed)"`
	Key         string                `json:"key,omitempty" doc:"the page key the reading is of; absent with none"`
	Blocks      []block.FrontendBlock `json:"blocks,omitempty" doc:"the reading, in the page's order, in the shape a load's blocks take; absent with none"`
	Running     bool                  `json:"running" doc:"a reading of the page is under way"`
	Available   bool                  `json:"available" doc:"false while nothing can read a page"`
	Unavailable string                `json:"unavailable,omitempty" doc:"why nothing can read a page; present only when available is false"`
	Failed      string                `json:"failed,omitempty" doc:"what went wrong the last time the page was read; absent when nothing did"`
}

// InkReadingContentFrame answers an ink-reading or an ink-read-page with what is known of the
// page's reading, or why there is none to say.
type InkReadingContentFrame struct {
	Type    string      `json:"type"`
	OpID    string      `json:"opId,omitempty"`
	PageID  string      `json:"pageId" doc:"the page asked of, echoed"`
	Reading *InkReading `json:"reading" doc:"null when refused"`
	Error   string      `json:"error,omitempty" doc:"present only when refused: the channel holds no Digital Note, the note has no page of that id, or ink is unavailable"`
}

// NewInkReadingContentFrame builds the answer carrying reading.
func NewInkReadingContentFrame(opID, pageID string, reading InkReading) InkReadingContentFrame {
	return InkReadingContentFrame{Type: TypeInkReadingContent, OpID: opID, PageID: pageID, Reading: &reading}
}

// NewInkReadingRefusedFrame builds the answer to an ink-reading or ink-read-page that names no
// page there is.
func NewInkReadingRefusedFrame(opID, pageID string, err error) InkReadingContentFrame {
	return InkReadingContentFrame{Type: TypeInkReadingContent, OpID: opID, PageID: pageID, Error: err.Error()}
}

// InkReadingChangedFrame is what is known of the reading of a page of this channel's note now
// that it has changed: a reading began, or ended in a reading kept or in a failure.
type InkReadingChangedFrame struct {
	Type    string     `json:"type"`
	PageID  string     `json:"pageId"`
	Reading InkReading `json:"reading"`
}

// NewInkReadingChangedFrame builds the reading push.
func NewInkReadingChangedFrame(pageID string, reading InkReading) InkReadingChangedFrame {
	return InkReadingChangedFrame{Type: TypeInkReadingChanged, PageID: pageID, Reading: reading}
}

// InkReadingDocumentResultFrame answers an ink-reading-document with the new document's uuid, or
// why none was made.
type InkReadingDocumentResultFrame struct {
	Type  string `json:"type"`
	OpID  string `json:"opId,omitempty"`
	UUID  string `json:"uuid,omitempty" doc:"the new document; absent with error"`
	Error string `json:"error,omitempty" doc:"present only when no document was made: the page has no reading, or ink is unavailable"`
}

// NewInkReadingDocumentResultFrame builds the answer naming the new document uuid.
func NewInkReadingDocumentResultFrame(opID, uuid string) InkReadingDocumentResultFrame {
	return InkReadingDocumentResultFrame{Type: TypeInkReadingDocumentResult, OpID: opID, UUID: uuid}
}

// NewInkReadingDocumentFailedFrame builds the answer to an ink-reading-document that made nothing.
func NewInkReadingDocumentFailedFrame(opID string, err error) InkReadingDocumentResultFrame {
	return InkReadingDocumentResultFrame{Type: TypeInkReadingDocumentResult, OpID: opID, Error: err.Error()}
}

// InkDescribeFrame asks for this channel's Digital Note to be named now: its name, summary,
// keywords and categories described again from its pages, whether or not they are of the note as
// it stands. It is answered once the job is submitted, or with why it was not; the new name
// arrives as the note's container-named and the ink invalidation.
type InkDescribeFrame struct {
	Type string `json:"type"`
	OpID string `json:"opId,omitempty" doc:"echoed on the ink-describe-result reply"`
}

// InkDescribeResultFrame answers an ink-describe: the job submitted, or a note already being
// named, when Error is absent.
type InkDescribeResultFrame struct {
	Type  string `json:"type"`
	OpID  string `json:"opId,omitempty"`
	Error string `json:"error,omitempty" doc:"present only when nothing was submitted, in words a person can be shown: no AI is configured, the note has no ink, nothing is open that can draw its pages, or ink is unavailable"`
}

// NewInkDescribeResultFrame builds the answer to an ink-describe whose job was submitted.
func NewInkDescribeResultFrame(opID string) InkDescribeResultFrame {
	return InkDescribeResultFrame{Type: TypeInkDescribeResult, OpID: opID}
}

// NewInkDescribeRefusedFrame builds the answer to an ink-describe that submitted nothing, saying
// why in refusal.
func NewInkDescribeRefusedFrame(opID, refusal string) InkDescribeResultFrame {
	return InkDescribeResultFrame{Type: TypeInkDescribeResult, OpID: opID, Error: refusal}
}
