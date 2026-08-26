package domain

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"sieve/ident"
)

// Scheme is the one internal scheme. Everything Sieve can name lives in it.
const Scheme = "sieve"

// versionParam is the pin's query key.
const versionParam = "version"

// Address is a Sieve coordinate — a reference to a container, or to one leaf
// inside one, in a form that survives leaving its document.
//
//	sieve://{container}                      — a container
//	sieve://{container}?version={n}          — pinned container
//	sieve://{container}/{leaf}               — a leaf within it
//	sieve://{container}/{leaf}?version={n}   — that leaf, as of container version n
//	/{leaf}                                  — relative, resolved against the
//	                                           container it was written in
//
// The container uuid is the RFC 3986 authority, not a path segment, so the
// relative form resolves by url.URL.ResolveReference rather than a bespoke
// rewriter.
//
// {leaf} names a block uuid, a local alias, or an asset key (a filename,
// extension included). Which of the three it is is decided container-side at
// lookup and must never be inferred from the address.
//
// A version belongs to the container, not to the leaf: the pin is a query on
// the whole coordinate and reads "this leaf, as of container version n".
//
// There is no absolute leaf production without an authority, so an alias —
// unique only within its container — cannot travel without it.
type Address struct {
	// Container is the container uuid — the naming authority. Every path that
	// produces an Address canonicalises it (ident.Canonical), so Equal compares
	// it exactly and String never emits a spelling that misses the
	// lowercase-named document directory.
	Container string
	// Leaf is a block uuid, a local alias, or an asset key; "" names the
	// container itself. Stored verbatim: an asset key is a filename on a
	// case-sensitive filesystem, so folding here names a file that does not
	// exist. Case never distinguishes two coordinates — Equal folds instead.
	Leaf    string
	Version int // 0 = live (unpinned); >0 pins the container version
}

// ErrBadAddress is the sentinel every parse failure wraps.
var ErrBadAddress = errors.New("domain: malformed address")

// NewContainerAddress builds the live (unpinned) address of a whole container.
func NewContainerAddress(uuid string) Address {
	return Address{Container: ident.Canonical(strings.TrimSpace(uuid))}
}

// NewLeafAddress builds the live address of one leaf inside a container. leaf is
// whatever the container will be asked to look up — a block uuid, a local alias
// or an asset key.
//
// It is total and validates nothing. A leaf containing "/" is a programming
// error, not a runtime one: it emits sieve://{container}/a/b, which
// ParseAddress rejects as naming more than one leaf.
func NewLeafAddress(container, leaf string) Address {
	return Address{
		Container: ident.Canonical(strings.TrimSpace(container)),
		Leaf:      strings.TrimSpace(leaf),
	}
}

// ParseAddress parses an ABSOLUTE coordinate, rejecting anything the grammar
// does not produce. A relative reference is not parsed here; ResolveAddress
// takes those.
func ParseAddress(s string) (Address, error) {
	u, err := url.Parse(s)
	if err != nil {
		return Address{}, fmt.Errorf("%w: %q: %s", ErrBadAddress, s, err)
	}
	if u.Scheme != Scheme {
		return Address{}, fmt.Errorf("%w: scheme %q is not %q in %q", ErrBadAddress, u.Scheme, Scheme, s)
	}
	return addressFromURL(u, s)
}

// ResolveAddress resolves a reference — absolute or relative — against the
// container it was written in. An absolute ref ignores the base entirely.
//
// A relative ref does NOT inherit the base's pin: RFC 3986 replaces the base's
// query whenever the ref carries a path, so "/{leaf}" written inside a frozen
// container names the LIVE leaf.
func ResolveAddress(ref string, base Address) (Address, error) {
	if base.Container == "" {
		return Address{}, fmt.Errorf("%w: no base container to resolve %q against", ErrBadAddress, ref)
	}
	if strings.TrimSpace(ref) == "" {
		return Address{}, fmt.Errorf("%w: empty reference", ErrBadAddress)
	}
	refURL, err := url.Parse(ref)
	if err != nil {
		return Address{}, fmt.Errorf("%w: %q: %s", ErrBadAddress, ref, err)
	}
	if refURL.IsAbs() {
		return ParseAddress(ref)
	}
	return addressFromURL(base.url().ResolveReference(refURL), ref)
}

// addressFromURL is the single validator, so an address reached by resolution
// is held to the same rules as a parsed one. raw is the caller's spelling, used
// for error messages and for the fragment check that survives url.Parse
// dropping a bare "#".
func addressFromURL(u *url.URL, raw string) (Address, error) {
	if u.Opaque != "" {
		return Address{}, fmt.Errorf("%w: %q has no // authority", ErrBadAddress, raw)
	}
	if u.User != nil {
		return Address{}, fmt.Errorf("%w: %q carries userinfo", ErrBadAddress, raw)
	}
	if u.Port() != "" {
		return Address{}, fmt.Errorf("%w: %q carries a port", ErrBadAddress, raw)
	}
	if u.Fragment != "" || strings.Contains(raw, "#") {
		return Address{}, fmt.Errorf("%w: %q carries a fragment", ErrBadAddress, raw)
	}
	if u.ForceQuery {
		return Address{}, fmt.Errorf("%w: %q carries an empty query", ErrBadAddress, raw)
	}
	if !ident.Valid(u.Host) {
		return Address{}, fmt.Errorf("%w: authority %q is not a uuid in %q", ErrBadAddress, u.Host, raw)
	}
	leaf := strings.TrimPrefix(u.Path, "/")
	if strings.Contains(leaf, "/") {
		return Address{}, fmt.Errorf("%w: %q names more than one leaf", ErrBadAddress, raw)
	}
	if u.Path == "/" {
		return Address{}, fmt.Errorf("%w: %q ends in a slash and so names no leaf", ErrBadAddress, raw)
	}
	version, err := parseVersion(u.RawQuery, raw)
	if err != nil {
		return Address{}, err
	}
	return Address{Container: ident.Canonical(u.Host), Leaf: leaf, Version: version}, nil
}

// parseVersion reads the pin off a query string. Versions are 1-based:
// version=0 is rejected because 0 is the live sentinel.
func parseVersion(rawQuery, raw string) (int, error) {
	if rawQuery == "" {
		return 0, nil
	}
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		return 0, fmt.Errorf("%w: bad query in %q: %s", ErrBadAddress, raw, err)
	}
	for key := range q {
		if key != versionParam {
			return 0, fmt.Errorf("%w: unknown query parameter %q in %q", ErrBadAddress, key, raw)
		}
	}
	values := q[versionParam]
	if len(values) != 1 {
		return 0, fmt.Errorf("%w: %s must appear exactly once in %q", ErrBadAddress, versionParam, raw)
	}
	n, err := strconv.Atoi(values[0])
	if err != nil || n < 1 {
		return 0, fmt.Errorf("%w: bad version pin %q in %q", ErrBadAddress, values[0], raw)
	}
	return n, nil
}

// url renders this address as a URI. It is shared by String and by relative
// resolution, so emission and the resolution base cannot drift apart.
func (a Address) url() *url.URL {
	u := &url.URL{Scheme: Scheme, Host: a.Container}
	if a.Leaf != "" {
		u.Path = "/" + a.Leaf
	}
	if a.Version > 0 {
		u.RawQuery = versionParam + "=" + strconv.Itoa(a.Version)
	}
	return u
}

// String renders the canonical spelling. ParseAddress(a.String()) == a for
// every address ParseAddress or ResolveAddress produced. The round trip does
// not extend to the constructors, which validate nothing; see NewLeafAddress.
func (a Address) String() string { return a.url().String() }

// IsPinned reports that this address names a frozen container version.
func (a Address) IsPinned() bool { return a.Version > 0 }

// IsContainer reports that this address names a whole container rather than
// something inside one.
func (a Address) IsContainer() bool { return a.Leaf == "" }

// ContainerAddress drops the leaf and keeps the pin — dropping the pin would
// silently turn a frozen reference live.
func (a Address) ContainerAddress() Address {
	return Address{Container: a.Container, Version: a.Version}
}

// Equal reports whether two addresses denote the same thing. All three fields
// are the identity, including the pin, so a live address and a frozen one are
// deliberately unequal. Case never distinguishes two coordinates: the authority
// arrives canonicalised and the leaf is folded here, so two Equal addresses may
// render different strings.
func (a Address) Equal(other Address) bool {
	return a.Container == other.Container &&
		strings.EqualFold(a.Leaf, other.Leaf) &&
		a.Version == other.Version
}
