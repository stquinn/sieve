package editor

import (
	"errors"
	"fmt"
	"strings"

	"sieve/sieve/domain"
)

// NodeSource is one container kind's face on the Router: what it can OFFER
// (Search) and what it can DEREFERENCE (Resolve).
//
// THE INVARIANT a source signs up to is that those two agree — it may only offer
// candidates that can actually be dereferenced downstream. Since MCP get_by_uri
// dereferences through this very Router, the invariant is now self-enforcing at
// the registry: a buffer, a chat or a Thing appears in a picker exactly when a
// source that resolves it is registered, and not before.
//
// Resolve must report a target it does not hold as domain.ErrNodeNotFound; any
// other error is a real failure and stops the federation.
type NodeSource interface {
	Name() string
	Search(query string, limit int) []domain.Candidate
	Resolve(uri string) (domain.NodeDescriptor, error)
}

// Router is the one address → NodeDescriptor resolver: a registry federating a source per
// container kind, with two faces — resolution and enumeration. Adding a kind is
// one Register call at the composition root; nothing outside Go learns what
// kinds exist.
//
// DocumentService.documentFromStoreable already switches on Category to build a
// Note or a Buffer — a router over two container kinds keyed by category. This
// is that, keyed by address instead.
type Router struct {
	sources []NodeSource
}

// The two refusals below are ROUTER POLICY, not grammar. domain.ParseAddress
// happily produces both forms — they are legal coordinates — but this router has
// nothing to resolve them with yet, and answering anyway would be a lie rather
// than a limitation.
var (
	// ErrSchemeUnsupported is a resolvability failure: the address is well formed
	// and its scheme is real, but no registered source answers that address space.
	// v1 registers container: only — a block: address needs a source that can
	// reach into a document, which is the next epic's work.
	ErrSchemeUnsupported = errors.New("router: no source answers for that scheme")
	// ErrVersionPinUnsupported refuses @v{n}. Versioned storables do not exist
	// yet, so the only thing the router could return for a pinned address is
	// current content — a snapshot that isn't one.
	ErrVersionPinUnsupported = errors.New("router: version pinning is not implemented")
	// ErrNoContainer refuses a bare block:{uuid} as a NAVIGATION target: it names
	// a block without naming where it lives, and nothing indexes blocks across
	// containers, so there is no document to open. The container-qualified form
	// is the one that navigates. Refusing is honest; guessing is not.
	ErrNoContainer = errors.New("router: a bare block address names no container to open")
)

// NewRouter builds the registry over its sources, in offer order.
func NewRouter(sources ...NodeSource) *Router {
	return &Router{sources: sources}
}

// Register appends a source. Registration order is offer order: the first source
// that resolves an address wins, and Search fills its budget in the same order.
func (r *Router) Register(source NodeSource) {
	if source != nil {
		r.sources = append(r.sources, source)
	}
}

// Resolve turns an address into the NodeDescriptor it points at, asking each source in
// registration order.
//
// Three refusals happen before any source is asked. The first belongs to the
// grammar — domain.ParseAddress rejects anything that is not a coordinate, so a
// malformed uri never reaches a store. The other two are this router's own
// policy over an address that parsed perfectly well: a scheme no source answers
// for (only container: is resolvable in v1), and a @v{n} pin, which is refused
// rather than resolved live.
//
// A target no source holds is domain.ErrNodeNotFound: dangling is normal. A
// source failing for any OTHER reason (an unreadable store) surfaces as-is, so a
// broken library is never mistaken for a deleted document.
func (r *Router) Resolve(uri string) (domain.NodeDescriptor, error) {
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		return domain.NodeDescriptor{}, err
	}
	if addr.Scheme != domain.SchemeContainer {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %q", ErrSchemeUnsupported, addr.Scheme)
	}
	if addr.IsPinned() {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", ErrVersionPinUnsupported, uri)
	}
	for _, source := range r.sources {
		node, err := source.Resolve(uri)
		if err == nil {
			return node, nil
		}
		if !errors.Is(err, domain.ErrNodeNotFound) {
			return domain.NodeDescriptor{}, fmt.Errorf("router: source %s: %w", source.Name(), err)
		}
	}
	return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, uri)
}

// Target answers WHERE a coordinate opens: the container to bring up, plus the
// block to reveal inside it when the address names one.
//
// It is the NAVIGATION face, and it is a different question from Resolve's. A
// block: address cannot be dereferenced — no source reaches inside a document
// yet — but it can still be NAVIGATED, because the container segment it carries
// is a container address the sources do answer for. So the split is not a
// loophole in Resolve's refusal: opening a document and reading a block out of
// one are different capabilities, and only the first is claimed here.
//
// Every refusal below is inherited rather than restated — the grammar's
// (ParseAddress), the pin's and the dangling case's are all Resolve's own — so
// there stays exactly one place that decides what an address means. The only
// judgement this method adds is ErrNoContainer.
func (r *Router) Target(uri string) (domain.OpenTarget, error) {
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		return domain.OpenTarget{}, err
	}
	if addr.Container == "" {
		return domain.OpenTarget{}, fmt.Errorf("%w: %s", ErrNoContainer, uri)
	}
	// The pin is carried onto the container address deliberately, NOT dropped: a
	// pinned address must be refused, and Resolve is what refuses it.
	container := domain.Address{Scheme: domain.SchemeContainer, Container: addr.Container, Version: addr.Version}
	node, err := r.Resolve(container.String())
	if err != nil {
		return domain.OpenTarget{}, err
	}
	return domain.OpenTarget{
		URI:     uri,
		UUID:    node.UUID,
		BlockID: addr.Block, // empty for a container address; an alias stays an alias
		Kind:    node.Kind,
		Title:   node.Title,
	}, nil
}

// Search fans the query out over every registered source and returns what is
// addressable. limit is a TOTAL across sources — each is asked only for the
// remaining budget, so a chatty first source cannot starve the rest of the list
// of its share beyond what the user can see anyway.
func (r *Router) Search(query string, limit int) []domain.Candidate {
	if strings.TrimSpace(query) == "" || limit <= 0 {
		return nil
	}
	var out []domain.Candidate
	for _, source := range r.sources {
		remaining := limit - len(out)
		if remaining <= 0 {
			break
		}
		offered := source.Search(query, remaining)
		if len(offered) > remaining {
			offered = offered[:remaining] // a source that ignores its budget
		}
		out = append(out, offered...)
	}
	return out
}
