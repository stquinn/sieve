package domain

import (
	"errors"
	"fmt"
	"strings"
)

// Address is a parsed Sieve coordinate: a scheme plus the opaque part that
// scheme owns. `container:9f2b-…` is scheme + opaque part, so it is a URI —
// "address" stays the prose and type word (the Router resolves an address; the
// field that holds one is a `uri`).
//
// THE GRAMMAR IS #75's. This type consumes it and deliberately neither restates
// nor extends it. v1 emits and resolves the bare `container:` form, which is a
// LIVE EDGE: the target is read at job time, not snapshotted. The `@v{n}` pin is
// RESERVED, not implemented — it is recognised here only so a pinned address can
// be refused honestly (see Router.Resolve) instead of silently resolving live
// while claiming to be a snapshot.
type Address struct {
	Scheme  string // the address space the opaque part belongs to
	Opaque  string // scheme-owned identifier; for container: a document uuid
	Version string // the reserved @v{n} pin; "" = bare, i.e. a live edge
}

// SchemeContainer addresses a whole storable — a document today, a chat,
// workbench or Thing as those grow addresses. The only scheme v1 resolves.
const SchemeContainer = "container"

var (
	// ErrMalformedAddress is a shape failure: no scheme, or no opaque part.
	ErrMalformedAddress = errors.New("address: malformed")
	// ErrUnknownScheme is a resolvability failure: the shape is fine, but no
	// registered source answers for that address space.
	ErrUnknownScheme = errors.New("address: unknown scheme")
	// ErrVersionPinUnsupported is the honest refusal of the reserved @v{n} form.
	ErrVersionPinUnsupported = errors.New("address: version pinning is reserved, not implemented")
)

// NewContainerAddress builds the bare (live-edge) container address for a uuid.
// The one place the scheme is spelled, so no caller concatenates "container:".
func NewContainerAddress(uuid string) Address {
	return Address{Scheme: SchemeContainer, Opaque: strings.TrimSpace(uuid)}
}

// ParseAddress is the Address constructor: it splits a uri into scheme, opaque
// part and reserved version pin. It validates SHAPE only — whether a scheme can
// actually be resolved is the Router's question, not the grammar's, so
// "block:9f2b/co-1" parses cleanly and is refused later.
func ParseAddress(uri string) (Address, error) {
	raw := strings.TrimSpace(uri)
	i := strings.IndexByte(raw, ':')
	if i <= 0 {
		return Address{}, fmt.Errorf("%w: %q has no scheme", ErrMalformedAddress, uri)
	}
	a := Address{Scheme: raw[:i], Opaque: raw[i+1:]}
	// A uuid never contains '@', so the last '@' can only open the version pin.
	if at := strings.LastIndexByte(a.Opaque, '@'); at >= 0 {
		a.Version, a.Opaque = a.Opaque[at+1:], a.Opaque[:at]
	}
	if a.Opaque == "" {
		return Address{}, fmt.Errorf("%w: %q has no opaque part", ErrMalformedAddress, uri)
	}
	return a, nil
}

// URI renders the address back to its canonical string form — the inverse of
// ParseAddress, and what gets persisted in an attachment's `uri`.
func (a Address) URI() string {
	if a.Version == "" {
		return a.Scheme + ":" + a.Opaque
	}
	return a.Scheme + ":" + a.Opaque + "@" + a.Version
}

// IsPinned reports whether this address carries the reserved version pin. Bare =
// live edge; pinned = a frozen snapshot, which nothing implements yet.
func (a Address) IsPinned() bool { return a.Version != "" }
