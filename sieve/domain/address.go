package domain

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"sieve/ident"
)

// Address is a Sieve coordinate — a reference to a container, or to one block
// inside one, in a form that survives leaving its document.
//
//	container:{uuid}[@v{n}]
//	block:{uuid}
//	block:{container-uuid}[@v{n}]/{handle}
//
// where handle is a block uuid (identity) or a local alias (name).
//
// The scheme names SHAPE, not service. container:/block: rather than
// document:/chat:/thing: because the latter encode LOCATION, and location is
// mutable: a block born in a document and later published as a Thing would change
// address, and every citation to it would die. Container KINDS live in .meta,
// exactly as Note and Buffer do today.
//
// Versions belong to storables, not blocks: a block has no version of its own,
// its container does. So block:{uuid}@v{n} is meaningless and the pin attaches to
// the CONTAINER segment. That is also why the container-qualified form is not a
// redundant locator hint — it is the only form that can express a FROZEN block
// reference.
//
// An alias may never appear in a cross-document coordinate, because aliases are
// unique only within their own document. The grammar enforces that structurally:
// there is no bare block:{alias} production, so the rule cannot be expressed
// wrongly. A reference leaving a document resolves alias → uuid at the boundary.
type Address struct {
	Scheme    string // SchemeContainer or SchemeBlock
	Container string // container uuid; empty for a bare block: address
	Block     string // block uuid or local alias; empty for a container: address
	Version   int    // 0 = live (unpinned); >0 pins the container version
}

const (
	SchemeContainer = "container"
	SchemeBlock     = "block"
)

// ErrBadAddress is the sentinel every parse failure wraps.
var ErrBadAddress = errors.New("domain: malformed address")

// ParseAddress parses a coordinate, rejecting anything the grammar does not
// produce. Strictness is the feature: an address that parses leniently becomes a
// dangling reference nobody notices until the thing it names is gone.
func ParseAddress(s string) (Address, error) {
	scheme, rest, ok := strings.Cut(s, ":")
	if !ok || rest == "" {
		return Address{}, fmt.Errorf("%w: %q", ErrBadAddress, s)
	}
	switch scheme {
	case SchemeContainer:
		return parseContainerAddress(rest, s)
	case SchemeBlock:
		return parseBlockAddress(rest, s)
	default:
		return Address{}, fmt.Errorf("%w: unknown scheme %q in %q", ErrBadAddress, scheme, s)
	}
}

func parseContainerAddress(rest, full string) (Address, error) {
	if strings.Contains(rest, "/") {
		return Address{}, fmt.Errorf("%w: a container address names no block: %q", ErrBadAddress, full)
	}
	uuid, version, err := splitVersion(rest, full)
	if err != nil {
		return Address{}, err
	}
	if !ident.Valid(uuid) {
		return Address{}, fmt.Errorf("%w: container segment %q is not a uuid in %q", ErrBadAddress, uuid, full)
	}
	return Address{Scheme: SchemeContainer, Container: uuid, Version: version}, nil
}

func parseBlockAddress(rest, full string) (Address, error) {
	head, handle, qualified := strings.Cut(rest, "/")
	if !qualified {
		// block:{uuid} — live and unqualified. No version pin is legal here: a
		// block has no version of its own, only its container does.
		if !ident.Valid(head) {
			return Address{}, fmt.Errorf(
				"%w: bare block address %q must be a uuid (an alias may never leave its container)", ErrBadAddress, full)
		}
		return Address{Scheme: SchemeBlock, Block: head}, nil
	}
	if handle == "" || strings.Contains(handle, "/") {
		return Address{}, fmt.Errorf("%w: bad block segment in %q", ErrBadAddress, full)
	}
	container, version, err := splitVersion(head, full)
	if err != nil {
		return Address{}, err
	}
	if !ident.Valid(container) {
		return Address{}, fmt.Errorf("%w: container segment %q is not a uuid in %q", ErrBadAddress, container, full)
	}
	return Address{Scheme: SchemeBlock, Container: container, Block: handle, Version: version}, nil
}

// splitVersion peels an optional @v{n} pin off a segment. n is 1-based: @v0 is
// rejected because 0 is the live sentinel and no storable has a version zero.
func splitVersion(segment, full string) (string, int, error) {
	head, tail, ok := strings.Cut(segment, "@")
	if !ok {
		return segment, 0, nil
	}
	if !strings.HasPrefix(tail, "v") {
		return "", 0, fmt.Errorf("%w: bad version pin %q in %q", ErrBadAddress, tail, full)
	}
	n, err := strconv.Atoi(tail[1:])
	if err != nil || n < 1 {
		return "", 0, fmt.Errorf("%w: bad version pin %q in %q", ErrBadAddress, tail, full)
	}
	return head, n, nil
}

// String renders the canonical spelling: ParseAddress(a.String()) == a.
func (a Address) String() string {
	var b strings.Builder
	b.WriteString(a.Scheme)
	b.WriteByte(':')
	if a.Scheme == SchemeBlock && a.Container == "" {
		b.WriteString(a.Block)
		return b.String()
	}
	b.WriteString(a.Container)
	if a.Version > 0 {
		b.WriteString("@v")
		b.WriteString(strconv.Itoa(a.Version))
	}
	if a.Scheme == SchemeBlock {
		b.WriteByte('/')
		b.WriteString(a.Block)
	}
	return b.String()
}

// IsPinned reports that this address names a frozen container version.
func (a Address) IsPinned() bool { return a.Version > 0 }

// IsAlias reports that the block segment is a local NAME rather than an identity.
// Such an address must be resolved against its container before it can be
// compared or followed.
func (a Address) IsAlias() bool {
	return a.Scheme == SchemeBlock && a.Block != "" && !ident.Valid(a.Block)
}

// Equal reports whether two addresses denote the same thing. Equality is
// POST-RESOLUTION: two addresses are equal iff they resolve to the same uuid AND
// the same pin state — so a live block: and a frozen block:…@v7/… are
// deliberately unequal. An unresolved alias cannot be compared at all and always
// answers false; resolve it against its container first.
func (a Address) Equal(other Address) bool {
	if a.IsAlias() || other.IsAlias() {
		return false
	}
	if a.Scheme != other.Scheme || a.Version != other.Version {
		return false
	}
	if a.Scheme == SchemeBlock {
		// For a uuid-addressed block the container segment is a LOCATOR HINT, not
		// part of identity — block:{uuid} and block:{c}/{uuid} name the same block.
		// It is load-bearing only when pinned, and Version is compared above.
		return a.Block == other.Block
	}
	return a.Container == other.Container
}
