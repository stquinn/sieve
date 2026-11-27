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
type NodeResolver = domain.NodeResolver

// SearchService is the finding surface this server needs: criteria in, hits out.
// editor.Router implements it and the composition root injects it; search asks
// it and holds no matching of its own.
type SearchService = domain.SearchService

// AnswerVocabulary is what add_to_answer and describe_answer need of the kinds
// an answer can be written in: their cards, and an element built from a content
// type and the map a model supplied, through the kind's own processor, for an
// answer held in document container ("" when none holds it). A refusal
// is an error whose text the model is shown. block.Registry implements it and the
// composition root injects it.
//
// Waits reports whether an element it built lands waiting on work its kind's
// job does.
type AnswerVocabulary interface {
	AnswerCards() []domain.AnswerCard
	BuildAnswerElement(container, contentType string, attrs map[string]any) (domain.SieveBlock, error)
	Waits(el domain.SieveBlock) bool
}

// AnswerWriter appends one element to the answer of an exchange being answered,
// in whatever holds its block; startOver makes the element the whole answer. A
// refusal (the holder no longer holds the block, or it is not being answered) is
// an error whose text the model is shown. Each AnswerHolder has its own writer:
// editor.EditorService writes a block held in an open document, command.Registry
// one held by a running command, and the composition root injects both.
//
// AnswerHolding declares what an answer the writer holds can take, which
// decides the content types a run answering into it is offered.
type AnswerWriter interface {
	AppendToAnswer(ex domain.Exchange, el domain.SieveBlock, startOver bool) error
	AnswerHolding() domain.AnswerHolding
}
