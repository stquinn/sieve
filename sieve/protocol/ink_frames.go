package protocol

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

// InkLiveFrame is live records in the order the tablet sent them.
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
