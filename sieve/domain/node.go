package domain

import "errors"

// Node is what an address resolves to — the Router's output and the second half
// of "address → Node".
//
// It is a PROJECTION, not the storable itself: each source flattens its own
// storage into this one shape, so a consumer (the AI manifest builder, a chip
// renderer) never learns which service answered or what it stores. That is what
// lets chats and Things register later without touching a single consumer.
//
// It lives in the leaf because its producer and its consumer must not have to
// know each other: editor.Router builds one, mcp's get_by_uri returns one, and
// domain/ is the package both can name (same reason as LinkPreviewResult).
type Node struct {
	URI     string // the address it was resolved from
	UUID    string // the target's identity
	Kind    string // the source's own noun: "note"
	Title   string
	Summary string
	// Body is the resolved content, and MCP get_by_uri is what returns it. No
	// PROMPT path reads it: an attachment renders as a MANIFEST — title + uri,
	// straight off the attachment — and the model dereferences what it decides it
	// needs, which is precisely the call that lands here.
	Body string
}

// Candidate is one offer from a source's enumeration face: what the picker shows
// and what an accepted mention persists. The invariant behind it is that a
// source may only offer what it can also dereference.
type Candidate struct {
	URI    string `json:"uri"`    // container:{uuid}
	Title  string `json:"title"`  // what the picker shows / the @token echoes
	Kind   string `json:"kind"`   // the source's own noun: "note"
	Detail string `json:"detail"` // folder / snippet — how duplicate titles are told apart
}

// ErrNodeNotFound is the dangling case: a well-formed address no source holds,
// because the target was deleted, was never addressable (an unfiled buffer), or
// belongs to an address space this source does not answer for. Dangling is a
// NORMAL state, not an error condition — callers render the cached title and
// carry on, which is why this is a typed sentinel rather than a panic or a nil.
var ErrNodeNotFound = errors.New("node: address resolves to nothing")
