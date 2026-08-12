package block

import "sieve/sieve/domain"

// AttachmentsAttr is the attrs-bag key the attachment list lives under.
const AttachmentsAttr = domain.AttachmentsAttr

// Attachments is a block's ordered attachment list — the `attachments` attr,
// persisted as:
//
//	attachments:
//	    - uri: container:9f2b-…
//	      title: Auth Design
//
// THE TYPE ITSELF LIVES IN domain, and this is its block-side name. It has more
// than one carrier: a block attr, the command envelope (command.Context), and
// the ATTACHED DOCUMENTS section both paths render — and `command` and `ai`
// cannot import `block` (block → ai → command already exists, so the reverse
// edge would close a cycle). The value, its attrs-bag translation and its one
// prompt renderer therefore live in the leaf beside domain.Attachment, for
// exactly the reason that type was put there. What stays here is the pair of
// accessors that know WHICH attr key a SieveBlock keeps it under.
//
// An attachment is NOT a ref. `ref` stays the document-local chain the ai-block
// walks (resolveChain) and the GC prunes (outgoingRefs/gcRefs); an attachment is
// a global address that nothing walks and nothing GCs. One field could not be
// both — a three-turn chain where each turn attached different documents is
// where that breaks.
type Attachments = domain.Attachments

// Attachments is this block's attachment list — a typed read of one attr key,
// sibling of Ref()/Status().
func (b SieveBlock) Attachments() Attachments {
	return domain.DecodeAttachments(b.Attrs[AttachmentsAttr])
}

// SetAttachments writes the list in canonical form. An empty list REMOVES the
// key: absent IS the empty case, so a block that attached nothing serializes
// exactly as it did before this attr existed.
func (b *SieveBlock) SetAttachments(a Attachments) {
	if b.Attrs == nil && len(a) > 0 {
		b.Attrs = map[string]interface{}{}
	}
	a.StampAttrs(b.Attrs) // a nil bag with nothing to write is a no-op
}
