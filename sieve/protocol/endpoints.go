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
