package mcp

import "sieve/sieve/domain"

// NodeResolver is the address surface this server needs: one method, Sieve
// coordinate → NodeDescriptor. editor.Router implements it and the composition
// root injects it.
//
// It takes a domain.Address, NOT a string, and that is CONTAINMENT: an Address
// can only spell sieve:// coordinates, so a model cannot reach a web address
// through this port however it phrases its input.
//
// The resolver's refusals are part of this contract and are surfaced by
// get_by_uri rather than re-checked there:
//
//	leaf unsupported       a legal address no registered source reaches inside
//	domain.ErrNodeNotFound a well-formed address nothing holds (deleted, unfiled,
//	                       or a ?version={n} nobody wrote)
//
// domain.ErrBadAddress is raised BEFORE this port, at get_by_uri's own door,
// where untrusted input is parsed.
type NodeResolver interface {
	Resolve(addr domain.Address) (domain.NodeDescriptor, error)
}
