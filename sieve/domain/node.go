package domain

import (
	"errors"
	"strings"
)

// NodeDescriptor is what an address resolves to. It is a projection, not the
// storable itself: every source flattens its own storage into this one shape, so
// a consumer never learns which service answered.
type NodeDescriptor struct {
	URI     string // the address it was resolved from
	ID      string // the target's identity: a document uuid, a block id or an asset key
	Kind    string // the source's own noun: "note", "buffer", a block kind, "asset"
	Title   string
	Summary string
	// Body is the resolved content; MCP get_by_uri is what returns it. No prompt
	// path reads it — a model dereferences what it decides it needs. Empty for an
	// asset, whose bytes are at Path.
	Body string
	// Path is where an asset's bytes are, relative to the library root; empty for
	// anything else.
	Path string
	// Bytes is an asset's size; zero for anything else.
	Bytes int
	// Attrs is the block's YAML map when the target is a block; nil otherwise. It
	// is shared with the source's copy of the block, so a consumer must not mutate
	// it.
	Attrs map[string]interface{}
	// Assets is every asset the container owns now, ordered by key, when the
	// address names a whole container; nil at leaf grain. A pin does not narrow
	// it: assets are immutable.
	Assets []NodeAsset
}

// NodeAsset is one asset a container owns, as a container's node lists it. URI
// resolves to the asset itself.
type NodeAsset struct {
	URI   string `json:"uri"`   // sieve://{container}/{key}
	Key   string `json:"key"`   // the asset's file name, extension included
	Path  string `json:"path"`  // where its bytes are, relative to the library root
	Bytes int    `json:"bytes"` // its size
}

// Block is the node as the one block a session over it holds: of the node's kind,
// with its id, carrying a copy of its attrs.
func (n NodeDescriptor) Block() SieveBlock {
	return NewSieveBlock(n.Kind, n.ID, n.Attrs).Clone()
}

// NodeResolver dereferences a Sieve coordinate: address in, NodeDescriptor out.
// editor.Router implements it; every consumer that resolves addresses takes it
// by injection. ErrNodeNotFound is the dangling case.
type NodeResolver interface {
	Resolve(addr Address) (NodeDescriptor, error)
}

// NodeClaimer knows, from an address alone and without reading any store, the
// addresses only it answers. A claimed address resolves through its claimer or
// not at all.
type NodeClaimer interface {
	Claims(addr Address) bool
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
	Kind    string // the container's own noun: "note", "buffer", a block kind
	Title   string
}

// Candidate is one hit of a search, and the one hit type every consumer reads:
// what the picker, the sidebar, the quick switcher and MCP show, and what an
// accepted mention persists. A source may only offer what it can also
// dereference.
//
// Summary and Detail are different sentences and neither substitutes for the
// other: Detail disambiguates (folder · match snippet) and is discarded once a
// candidate is picked, while Summary is the target's own description and is what
// an accepted mention persists into the block it mints.
type Candidate struct {
	URI     string `json:"uri"`     // sieve://{container}
	Title   string `json:"title"`   // what the picker shows / the @token echoes
	Kind    string `json:"kind"`    // the source's own noun: "note", "buffer", a block kind; what a consumer picks an icon from
	Detail  string `json:"detail"`  // folder / snippet — how duplicate titles are told apart
	Summary string `json:"summary"` // the target's own one-liner; seeds a minted reference's face
	// Folder is the folder the target is filed in; empty at the library root and
	// for anything not filed.
	Folder string `json:"folder,omitempty"`
	// Tags are the target's tags or keywords.
	Tags []string `json:"tags,omitempty"`
	// Modified is when the target last changed, RFC 3339; empty when its source
	// does not know.
	Modified string `json:"modified,omitempty"`
	// Matched is the fields the search's terms were found in; empty when the
	// search had no terms.
	Matched SearchFields `json:"matched,omitempty"`
}

// Container is the uuid of the container the candidate's address names, or
// empty when the address does not parse.
func (c Candidate) Container() string {
	addr, err := ParseAddress(c.URI)
	if err != nil {
		return ""
	}
	return addr.Container
}

// SearchField is one face of a thing that a search's terms are matched against.
type SearchField string

const (
	SearchName    SearchField = "NAME"    // what the thing is called
	SearchSummary SearchField = "SUMMARY" // its own one-line description
	SearchTags    SearchField = "TAGS"    // its tags or keywords
	SearchContent SearchField = "CONTENT" // what it holds
)

// searchFieldOrder is the order a hit's Matched lists its fields in.
var searchFieldOrder = [...]SearchField{SearchName, SearchSummary, SearchTags, SearchContent}

// SearchFields is a set of SearchField.
type SearchFields []SearchField

// Has reports whether field is in the set.
func (f SearchFields) Has(field SearchField) bool {
	for _, have := range f {
		if have == field {
			return true
		}
	}
	return false
}

// SearchCriteria is what one search asks for. A source answers for the fields
// its kind has and ignores the rest.
type SearchCriteria struct {
	// Terms is the free text, matched case-insensitively as one substring. Blank
	// asks for everything a source holds, still subject to every filter below.
	Terms string
	// Fields is what Terms are matched against. With Terms given and no field
	// named, nothing matches.
	Fields SearchFields
	// Kinds names the source nouns to include ("note", "buffer", a block kind);
	// none named includes every kind.
	Kinds []string
	// DurableOnly leaves out anything that has not proven durable. Whether a hit
	// is durable is a fact its source knows about it.
	DurableOnly bool
	// Folder keeps only what is filed in that folder or beneath it, compared
	// case-insensitively; anything with no folder is left out when one is given.
	Folder string
	// Limit caps the hits in total, across every source; zero or less is no cap.
	Limit int
}

// Includes reports whether a thing of kind, durable or not, is one this search
// asks for.
func (c SearchCriteria) Includes(kind string, durable bool) bool {
	if c.DurableOnly && !durable {
		return false
	}
	if len(c.Kinds) == 0 {
		return true
	}
	for _, k := range c.Kinds {
		if k == kind {
			return true
		}
	}
	return false
}

// InFolder reports whether a thing filed in folder ("" for none) passes the
// folder filter.
func (c SearchCriteria) InFolder(folder string) bool {
	want := strings.ToLower(strings.Trim(strings.TrimSpace(c.Folder), "/"))
	if want == "" {
		return true
	}
	have := strings.ToLower(strings.Trim(folder, "/"))
	return have == want || strings.HasPrefix(have, want+"/")
}

// Full reports whether n hits reach the limit.
func (c SearchCriteria) Full(n int) bool {
	return c.Limit > 0 && n >= c.Limit
}

// Match matches Terms against a thing's faces: each field the thing has, with
// the values it holds there; a field it lacks is absent from faces. It reports
// the fields the terms were found in and whether the thing is a hit. With blank
// Terms every thing is a hit and nothing is matched.
func (c SearchCriteria) Match(faces map[SearchField][]string) (SearchFields, bool) {
	terms := strings.ToLower(strings.TrimSpace(c.Terms))
	if terms == "" {
		return nil, true
	}
	var matched SearchFields
	for _, field := range searchFieldOrder {
		if !c.Fields.Has(field) {
			continue
		}
		for _, value := range faces[field] {
			if strings.Contains(strings.ToLower(value), terms) {
				matched = append(matched, field)
				break
			}
		}
	}
	return matched, len(matched) > 0
}

// SearchService finds things: the consumer says what it wants through the
// criteria and reads every hit as a Candidate. editor.Router implements it;
// every consumer that finds things takes it by injection.
type SearchService interface {
	Search(criteria SearchCriteria) []Candidate
}

// ErrNodeNotFound is the dangling case: a well-formed address no source holds —
// deleted, a version nobody wrote, or in an address space this source does not
// answer for. Any document resolves, filed or not. Dangling is a NORMAL state,
// not a failure: callers
// render the cached title and carry on.
var ErrNodeNotFound = errors.New("node: address resolves to nothing")
