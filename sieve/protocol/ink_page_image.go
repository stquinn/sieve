package protocol

// InkPageKeyHeader is the response header that carries the page key an ink page image was drawn
// at.
const InkPageKeyHeader = "X-Sieve-Ink-Page-Key"

// InkDrawPageFrame asks one workspace client to draw a page of a Digital Note as a PNG, and is
// answered by an ink-page-drawn carrying the same correlation id. It carries everything the
// drawing needs: the client fetches nothing and needs no tab open. A fixed page is drawn whole,
// 1404 pixels wide; an unbounded page is drawn framed to all its ink with a margin, its longer
// side at most 4096 pixels. Only committed ink is drawn.
type InkDrawPageFrame struct {
	Type          string        `json:"type"`
	CorrelationID string        `json:"correlationId" doc:"echoed on the ink-page-drawn answer"`
	Container     string        `json:"container" doc:"the uuid of the note's block container"`
	PageID        string        `json:"pageId" doc:"the page's id, as the block's note.pages lists it"`
	PageKey       string        `json:"pageKey" doc:"the hash of what is on the page, which the image is kept under"`
	Bounds        string        `json:"bounds" doc:"fixed | unbounded"`
	Page          InkPageExport `json:"page" doc:"the page in the export shape"`
}

// NewInkDrawPageFrame builds the request to draw page, whose id is pageID and key pageKey, of the
// note in container.
func NewInkDrawPageFrame(correlationID, container, pageID, pageKey, bounds string, page InkPageExport) InkDrawPageFrame {
	return InkDrawPageFrame{Type: TypeInkDrawPage, CorrelationID: correlationID, Container: container,
		PageID: pageID, PageKey: pageKey, Bounds: bounds, Page: page}
}

// InkPageDrawnFrame answers an ink-draw-page with the page as a PNG, or why it could not be drawn.
// Only the client that was asked may answer.
type InkPageDrawnFrame struct {
	Type          string `json:"type"`
	CorrelationID string `json:"correlationId" doc:"the ink-draw-page's, echoed"`
	PNG           string `json:"png,omitempty" doc:"the image, base64; absent with error"`
	Error         string `json:"error,omitempty" doc:"present only when the page could not be drawn"`
}

// InkPageImageRequest reads one page of a synced Digital Note as a PNG, drawn by the app's window
// when no image of the page as it stands is kept: {uuid} is the note's block container and {page}
// the page's index among the pages present, from 0. The page key the image was drawn at is the
// X-Sieve-Ink-Page-Key header. An unknown container, a container that is not a Digital Note and
// a page out of range are 404; no window connected to draw it is 503, and a window that does not
// answer in time is 504. The request has no body.
type InkPageImageRequest struct{}
