package protocol

// The typed HTTP surface is small on purpose. An operation that participates in
// an open editing session lives on the document wire, and one that acts on the
// workspace's world lives as a command; what is left here is hypermedia, byte
// serving, and the single document operation with no channel to carry it.

// DocumentLoadRequest reads a channel-less pseudo-document's content.
//
// It is the read half of the pair DocumentSaveRequest closes, and serves PROMPT
// PSEUDO-DOCUMENTS exclusively: a prompt never opens a document channel, so it
// has no wire to load along either. A note always has one and always loads
// through the wire's load frame — which is why this answers a prompt id only.
type DocumentLoadRequest struct {
	UUID string `json:"uuid" query:"uuid" doc:"the prompt pseudo-document id (prompt:{name}); a query parameter, not a body field"`
}

// DocumentSaveRequest writes a document's buffer to disk.
//
// It is the write half of the channel-less pair, and serves PROMPT
// PSEUDO-DOCUMENTS exclusively: a prompt has no document channel, so it has no
// wire to flush along. A note always has one and always saves through it.
type DocumentSaveRequest struct {
	UUID string `json:"uuid" query:"uuid" doc:"the prompt pseudo-document id (prompt:{name}); a query parameter, not a body field"`
	Body string `json:"body" doc:"the whole buffer"`
	Mode string `json:"mode,omitempty" doc:"records which mode saved it; empty leaves the recorded mode alone"`
}

// DocumentSaveResponse reports the version the save produced. Its one caller
// saves a PROMPT, which the store writes as a plain file with no metadata, so
// the answer is always 0: this endpoint has no versioned container to describe.
// The saved-signal a client acts on is the container-saved fact, not this body.
type DocumentSaveResponse struct {
	Version int `json:"version" doc:"the saved document's new version number; 0 for a container that keeps no version history"`
}

// AssetDeleteRequest deletes one asset of a document, irreversibly: {uuid} is
// the document and {key} the asset's key, path-escaped. An asset a block of the
// document still holds is refused with 409, judged against the blocks the editor
// holds now; deleting the block that holds it is the way to free it. A deleted
// asset is announced as an invalidate of the notes topic. The request has no body.
type AssetDeleteRequest struct{}

// NotePatchRequest changes a note's properties.
type NotePatchRequest struct {
	Name string `json:"name" doc:"the new display name"`
}

// FolderPatchRequest changes a folder's properties. Both fields are POINTERS
// because this is a patch: absent must be distinguishable from empty-or-false, or
// renaming a folder would silently collapse it.
type FolderPatchRequest struct {
	Name *string `json:"name,omitempty" doc:"the new display name; absent leaves it alone"`
	// Open is the folder's expanded state in the tree. It is a folder property,
	// which is why it is patched here rather than hidden in a sidebar query
	// parameter.
	Open *bool `json:"open,omitempty" doc:"whether the folder is expanded in the tree; absent leaves it alone"`
}

// FolderCreateRequest makes a new folder.
type FolderCreateRequest struct {
	Name string `json:"name"`
}

// TabsCloseRequest closes every listed tab — the ONE close mechanism. A single
// close sends one id, Close All sends every id, Close Others sends the complement
// of the kept tab: the client computes the set, the server closes it.
type TabsCloseRequest struct {
	IDs []string `json:"ids" doc:"the tabs to close"`
}

// InkPageExportRequest reads one page of a synced Digital Note in the export shape of
// docs/ink-contract.md §4.2: {uuid} is the note's block container and {page} the page's index
// among the pages present, from 0. An unknown container, a container that is not a Digital Note
// and a page out of range are 404. The request has no body.
type InkPageExportRequest struct{}

// InkPageExport is one page of a Digital Note as the ink renderer takes it: the note's header and
// the page's strokes in the order they were added.
type InkPageExport struct {
	Note    InkExportNote     `json:"note"`
	Strokes []InkExportStroke `json:"strokes"`
}

// InkExportNote is the header of the note a page belongs to.
type InkExportNote struct {
	ID         string             `json:"id" doc:"the companion's note id"`
	Created    string             `json:"created" doc:"RFC 3339 in UTC"`
	Title      string             `json:"title"`
	PageAspect float32            `json:"pageAspect" doc:"page width over page height"`
	Template   *InkExportTemplate `json:"template" doc:"the note's default page template; null when it has none"`
	Device     InkExportDevice    `json:"device"`
}

// InkExportTemplate is a page template: its id and its parameters by name.
type InkExportTemplate struct {
	ID     string             `json:"id"`
	Params map[string]float64 `json:"params"`
}

// InkExportDevice is the tablet the note was written on.
type InkExportDevice struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Model string `json:"model"`
}

// InkExportStroke is one stroke on the page.
type InkExportStroke struct {
	ID          string           `json:"id"`
	Tool        string           `json:"tool"`
	WidthClass  uint8            `json:"widthClass"`
	StartMillis uint64           `json:"startMillis" doc:"milliseconds since the note's created"`
	Points      []InkExportPoint `json:"points"`
}

// InkExportPoint is one sampled pen point, in page units.
type InkExportPoint struct {
	X        float32 `json:"x"`
	Y        float32 `json:"y"`
	Pressure float32 `json:"pressure" doc:"0 to 1"`
	TMillis  uint32  `json:"tMillis" doc:"milliseconds from the stroke's first point"`
	TiltX    int8    `json:"tiltX"`
	TiltY    int8    `json:"tiltY"`
	Size     float32 `json:"size" doc:"always 0 in an export"`
}
