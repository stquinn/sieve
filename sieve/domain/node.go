package domain

import "errors"

// NodeDescriptor is what an address resolves to. It is a projection, not the
// storable itself: every source flattens its own storage into this one shape, so
// a consumer never learns which service answered.
type NodeDescriptor struct {
	URI     string // the address it was resolved from
	UUID    string // the target's identity
	Kind    string // the source's own noun: "note"
	Title   string
	Summary string
	// Body is the resolved content; MCP get_by_uri is what returns it. No prompt
	// path reads it — a model dereferences what it decides it needs.
	Body string
}

// OpenTarget is where a coordinate NAVIGATES: the container to bring up and,
// when the address qualifies one, the block to reveal inside it.
//
// It exists so that no consumer takes an address apart itself — the frontend
// holds coordinates as opaque strings and asks for one of these, leaving the
// scheme, the pin rule and the container/leaf split decided in Go.
type OpenTarget struct {
	URI     string // the address it was derived from
	UUID    string // the container to open
	BlockID string // the block to reveal inside it; empty for a whole container
	Kind    string // the container's own noun: "note"
	Title   string
}

// Candidate is one offer from a source's enumeration face: what the picker shows
// and what an accepted mention persists. A source may only offer what it can
// also dereference.
//
// Summary and Detail are different sentences and neither substitutes for the
// other: Detail disambiguates (folder · match snippet) and is discarded once a
// candidate is picked, while Summary is the target's own description and is what
// an accepted mention persists into the block it mints.
type Candidate struct {
	URI     string `json:"uri"`     // sieve://{container}
	Title   string `json:"title"`   // what the picker shows / the @token echoes
	Kind    string `json:"kind"`    // the source's own noun: "note"
	Detail  string `json:"detail"`  // folder / snippet — how duplicate titles are told apart
	Summary string `json:"summary"` // the target's own one-liner; seeds a minted reference's face
}

// ErrNodeNotFound is the dangling case: a well-formed address no source holds —
// deleted, never addressable (an unfiled buffer), or in an address space this
// source does not answer for. Dangling is a NORMAL state, not a failure: callers
// render the cached title and carry on.
var ErrNodeNotFound = errors.New("node: address resolves to nothing")
