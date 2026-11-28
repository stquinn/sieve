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

// ChatRenameRequest names a chat by hand: {id} is the chat. A name is kept by every later
// description, which describes the chat's summary, keywords and categories and leaves its name; a
// blank one hands naming back, the chat called by the opening words of its first question until it
// is next described. The tab and the Chats row follow on the chats and session topics. 204 is the
// chat renamed; 404 is no chat, with a plain-text body.
type ChatRenameRequest struct {
	Name string `json:"name" doc:"the chat's new name, trimmed; empty hands naming back"`
}

// ChatDescribeRequest names a chat now: {id} is the chat, and its name (unless a person named it),
// summary, keywords and categories are described again from its answered exchanges, whether or
// not it has grown since it was last described. 204 is the job submitted, or one already naming
// the chat. Otherwise the body is plain text a person can be shown: 404 for no chat, 409 when
// nothing can name it now (no AI is configured, or the chat has no answer yet), 503 when chats are
// unavailable. The request has no body.
type ChatDescribeRequest struct{}

// InkPageExportRequest reads one page of a synced Digital Note in the export shape of
// docs/ink-contract.md §4.2: {uuid} is the note's block container and {page} the page's index
// among the pages present, from 0. An unknown container, a container that is not a Digital Note
// and a page out of range are 404. The request has no body.
type InkPageExportRequest struct{}

// InkDescribeRequest names a synced Digital Note now: {uuid} is the note's block container, and
// its name, summary, keywords and categories are described again from its pages, whether or not
// they are of the note as it stands. 204 is the job submitted, or one already naming the note.
// Otherwise the body is plain text a person can be shown: 404 for a container that is not a held
// Digital Note, 409 when nothing can name it now (no AI is configured, the note has no ink, or
// nothing is open that can draw its pages), 503 when ink is unavailable. The request has no body.
type InkDescribeRequest struct{}

// InkResyncRequest syncs a synced Digital Note again from its first record: {uuid} is the note's
// block container, whose log is kept aside and pulled again from the tablet it came from. 204 is
// the resync begun, the sync then a job of its own. Otherwise the body is plain text a person can
// be shown: 404 for a container that is not a held Digital Note, 409 when the note's tablet is not
// connected or does not list it, 503 when ink is unavailable. The request has no body.
type InkResyncRequest struct{}

// InkOpenOnTabletRequest asks the tablet a synced Digital Note came from to open it, leaving the
// page to the tablet: {uuid} is the note's block container. It waits a few seconds at most for
// the tablet. A container that is not a Digital Note from a tablet is 404, with a plain-text body,
// and ink being unavailable 503. The request has no body.
type InkOpenOnTabletRequest struct{}

// InkOpenOnTabletResponse is what came of an InkOpenOnTabletRequest.
type InkOpenOnTabletResponse struct {
	Outcome string `json:"outcome" doc:"opened | no-tablet | other-tablet | refused | no-answer, as ink-open-on-tablet-result names them"`
	Reason  string `json:"reason,omitempty" doc:"refused only: the tablet's reason, not-foreground | not-offered | another"`
	Message string `json:"message" doc:"what came of it, in words a person can be shown"`
}

// InkLiveNoteRequest asks which synced Digital Note the Live view mirrors. The request has no
// body.
type InkLiveNoteRequest struct{}

// InkLiveNoteResponse names the note the Live view mirrors.
type InkLiveNoteResponse struct {
	Note string `json:"note" doc:"the uuid of the block container holding the mirrored note; empty when there is no Live view or no container holds its note yet"`
}

// InkDiaryTodayRequest asks where a device's diary opens today: the chunk whose month holds
// today, at its last page named today's date, else at its last page; the newest chunk, at its last
// page, when no chunk holds today. No diary chunk held is 404, with a plain-text body.
type InkDiaryTodayRequest struct {
	Device string `json:"device" query:"device" doc:"the id of the device whose diary opens; empty for the diary whose newest chunk is the newest held. A query parameter, not a body field"`
}

// InkDiaryTodayResponse is where a diary opens today.
type InkDiaryTodayResponse struct {
	Address string `json:"address" doc:"the address to open: sieve://{chunk}/{page}, or sieve://{chunk} when the chunk has no pages"`
}

// InkPageExport is one page of a Digital Note as the ink renderer takes it: the note's header,
// the page itself, and the page's strokes in the order they were added.
type InkPageExport struct {
	Note    InkExportNote     `json:"note"`
	Page    InkExportPage     `json:"page"`
	Strokes []InkExportStroke `json:"strokes"`
}

// InkExportPage is the page an export is of.
type InkExportPage struct {
	ID         string              `json:"id" doc:"the companion's page id"`
	Properties map[string][]string `json:"properties" doc:"the page's properties, each key to its values; {} when it has none"`
}

// InkExportNote is the header of the note a page belongs to.
type InkExportNote struct {
	ID         string              `json:"id" doc:"the companion's note id"`
	Created    string              `json:"created" doc:"RFC 3339 in UTC"`
	Title      string              `json:"title"`
	PageAspect float32             `json:"pageAspect" doc:"page width over page height"`
	Template   *InkExportTemplate  `json:"template" doc:"the note's default page template; null when it has none"`
	Device     InkExportDevice     `json:"device"`
	Properties map[string][]string `json:"properties" doc:"the note's properties, each key to its values; {} when it has none"`
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
