package mcp

import "sieve/sieve/domain"

// NodeResolver is the address surface this server needs: one method, coordinate
// → NodeDescriptor. editor.Router is the implementation, and the composition root injects
// it — the CONSUMER declares the interface, so mcp/ depends on "something that
// dereferences an address" rather than on all of editor/ (which would drag the
// codec, the sweeper and the editor service in behind it).
//
// The Router's REFUSALS are part of this contract and are surfaced by get_by_uri
// rather than re-checked here — there is exactly one place that decides what a
// coordinate means:
//
//	domain.ErrBadAddress   the string is not a coordinate at all
//	scheme unsupported     a legal address no registered source answers for
//	version pin refused    @v{n}, which no storable can honour yet
//	domain.ErrNodeNotFound a well-formed address nothing holds (deleted, unfiled)
type NodeResolver interface {
	Resolve(uri string) (domain.NodeDescriptor, error)
}
