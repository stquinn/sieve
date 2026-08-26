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
// THE INVARIANT a source signs up to is that those two agree: it may only offer
// candidates it can also dereference.
//
// Resolve takes a domain.Address, never text — a source must not decode the
// grammar itself, so parsing happens once, at whichever door the coordinate
// arrived through.
//
// Resolve must report a target it does not hold as domain.ErrNodeNotFound; any
// other error is a real failure and stops the federation.
type NodeSource interface {
	Name() string
	Search(query string, limit int) []domain.Candidate
	Resolve(addr domain.Address) (domain.NodeDescriptor, error)
}

// Router is the one address → NodeDescriptor resolver: a registry federating a
// source per container kind, with two faces — resolution and enumeration. Adding
// a kind is one Register call at the composition root; nothing outside Go learns
// what kinds exist.
type Router struct {
	sources []NodeSource
}

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

// Resolve turns an address into the NodeDescriptor it points at, asking each
// source in registration order.
//
// Neither the grain nor a ?version={n} pin is a router concern: the address
// travels to the sources whole, and the source holding the container is what
// reaches inside it and reads its history.
//
// A target no source holds is domain.ErrNodeNotFound. A source failing for any
// other reason surfaces as-is, so a broken library is never mistaken for a
// deleted document.
func (r *Router) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	for _, source := range r.sources {
		node, err := source.Resolve(addr)
		if err == nil {
			return node, nil
		}
		if !errors.Is(err, domain.ErrNodeNotFound) {
			return domain.NodeDescriptor{}, fmt.Errorf("router: source %s: %w", source.Name(), err)
		}
	}
	return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, addr.String())
}

// Target answers WHERE a coordinate opens: the container to bring up, plus the
// block to reveal inside it when the address names one.
//
// What opens is always a container, so a leaf address is resolved at its
// container grain and the leaf travels on as the handle to reveal. Reading a
// block's content is Resolve's job.
//
// It takes a string because every caller is a wire frame carrying a uri, and
// this is that door: the parse happens here.
func (r *Router) Target(uri string) (domain.OpenTarget, error) {
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		return domain.OpenTarget{}, err
	}
	// The pin is CHECKED, never opened: OpenTarget carries no version and the
	// shell opens by uuid, so a pin to a version nobody wrote must dangle here
	// rather than quietly report a target.
	node, err := r.Resolve(addr.ContainerAddress())
	if err != nil {
		return domain.OpenTarget{}, err
	}
	return domain.OpenTarget{
		URI:     uri,
		UUID:    node.UUID,
		BlockID: addr.Leaf, // empty for a container address; an alias stays an alias
		Kind:    node.Kind,
		Title:   node.Title,
	}, nil
}

// Search fans the query out over every registered source and returns what is
// addressable. limit is a TOTAL across sources: each is asked only for the
// remaining budget, in registration order.
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
