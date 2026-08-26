package block

import (
	"strings"

	"sieve/ident"
	"sieve/sieve/domain"
)

// SieveBlock is a node in the unified, ordered block tree. EVERY kind — prose
// included — carries its payload in the single Attrs bag, addressed by id; kind
// is consulted only at render/serialise time. There is no per-kind payload
// field: prose's body is Attrs["content"], code's is Attrs["source"], ai's is
// Attrs["response"].
//
// A block is a LEAF: there is no Children field and nothing nests.
type SieveBlock struct {
	ID    string
	Kind  string
	Attrs map[string]interface{}
	// Aliases are additional handles this block answers to, accumulated when other
	// blocks merge into it. ID is the primary handle; a ref resolves against ID or
	// any alias.
	Aliases []string
}

// NewSieveBlock is the sole sanctioned way to construct a block: a block is
// GIVEN an id or it GENERATES one and never exists id-less. Pass id="" to mint
// (ident.New — ids are opaque and carry no kind); pass a known id to keep it.
// DocumentCodec.Serialize carries the runtime backstop for any path that
// bypasses this factory.
func NewSieveBlock(kind, id string, attrs map[string]interface{}) SieveBlock {
	if id == "" {
		id = ident.New()
	}
	// The invariant is TWO-SIDED: the id is mirrored into Attrs["id"]. The WYSIWYG
	// wire and the fenced serializer both read the id out of Attrs and never off
	// the ID field, so an id written to only one side drops the block on load and
	// on save. Copy-on-write, because callers pass live attrs maps.
	if attrs == nil {
		attrs = map[string]interface{}{"id": id}
	} else if existing, _ := attrs["id"].(string); existing != id {
		cloned := make(map[string]interface{}, len(attrs)+1)
		for k, v := range attrs {
			cloned[k] = v
		}
		cloned["id"] = id
		attrs = cloned
	}
	return SieveBlock{ID: id, Kind: kind, Attrs: attrs}
}

// Content is the block's authored text payload (Attrs["content"]) — a prose
// block's verbatim markdown, a web-clip's clipped text. "" when absent.
func (b SieveBlock) Content() string { return b.StringAttr("content") }

// Merge applies a patch onto this block: attrs merge additively, so a partial
// patch keeps existing keys, and aliases REPLACE the current set when the patch
// carries them (nil leaves them untouched).
func (b *SieveBlock) Merge(patch SieveBlock) {
	if b.Attrs == nil {
		b.Attrs = make(map[string]interface{}, len(patch.Attrs))
	}
	for k, v := range patch.Attrs {
		b.Attrs[k] = v
	}
	if patch.Aliases != nil {
		b.Aliases = patch.Aliases
	}
}

// StringAttr reads a string-valued attr, returning "" when the key is absent,
// nil, or not a string. It is the safe primitive the named accessors below are
// built on.
func (b SieveBlock) StringAttr(key string) string {
	s, _ := b.Attrs[key].(string)
	return s
}

// Source is the code/log/diagram authored payload (Attrs["source"]).
func (b SieveBlock) Source() string { return b.StringAttr("source") }

// Ref is the AI-chain reference list (Attrs["ref"]), comma-separated block ids.
func (b SieveBlock) Ref() string { return b.StringAttr("ref") }

// Status is the job lifecycle state (Attrs["status"]): PENDING/DISPATCHED/…
func (b SieveBlock) Status() string { return b.StringAttr("status") }

// AttachmentsAttr is the attrs-bag key the attachment list lives under.
const AttachmentsAttr = domain.AttachmentsAttr

// Attachments is a block's ordered attachment list — the `attachments` attr,
// persisted as:
//
//	attachments:
//	    - uri: sieve://9f2b-…
//	      title: Auth Design
//
// The type itself lives in domain (it has several carriers, including the
// command envelope); this is its block-side name.
//
// An attachment is a per-turn MANIFEST ENTRY, not a block: it records one
// document an ai-block turn was handed and lives only in that turn's attrs.
//
// An attachment is NOT a ref. `ref` is the document-local chain the ai-block
// walks and the GC prunes; an attachment is a global address that nothing walks
// and nothing GCs.
type Attachments = domain.Attachments

// Attachments is this block's attachment list.
func (b SieveBlock) Attachments() Attachments {
	return domain.DecodeAttachments(b.Attrs[AttachmentsAttr])
}

// SetAttachments writes the list in canonical form. An empty list REMOVES the
// key: absent is the empty case.
func (b *SieveBlock) SetAttachments(a Attachments) {
	if b.Attrs == nil && len(a) > 0 {
		b.Attrs = map[string]interface{}{}
	}
	a.StampAttrs(b.Attrs) // a nil bag with nothing to write is a no-op
}

// answersTo returns every handle this block resolves to — its primary ID plus
// any aliases absorbed via merges.
func (b SieveBlock) answersTo() []string {
	out := make([]string, 0, 1+len(b.Aliases))
	if b.ID != "" {
		out = append(out, b.ID)
	}
	return append(out, b.Aliases...)
}

// outgoingRefs returns this block's outgoing ref targets (Attrs["ref"]) as an
// ordered, whitespace-trimmed, non-empty slice — the tokenized form of the
// comma-separated Ref() string.
func (b SieveBlock) outgoingRefs() []string {
	ref := b.Ref()
	if ref == "" {
		return nil
	}
	var out []string
	for _, raw := range strings.Split(ref, ",") {
		r := strings.TrimSpace(raw)
		if r != "" {
			out = append(out, r)
		}
	}
	return out
}

// cloneDeep returns a value copy of b with a freshly-allocated Attrs map and
// Aliases slice, so a caller can hand it to a background job that mutates Attrs
// without racing the live tree.
func (b SieveBlock) cloneDeep() SieveBlock {
	cp := SieveBlock{ID: b.ID, Kind: b.Kind, Attrs: make(map[string]interface{}, len(b.Attrs))}
	for k, v := range b.Attrs {
		cp.Attrs[k] = v
	}
	if len(b.Aliases) > 0 {
		cp.Aliases = append([]string(nil), b.Aliases...)
	}
	return cp
}

// reidentify returns a copy of b carrying newID on BOTH sides of the id
// invariant — the ID field AND Attrs["id"]. Writing only one side drops the
// block on load and on save. Aliases ride along.
func (b SieveBlock) reidentify(newID string) SieveBlock {
	cp := b.cloneDeep()
	cp.ID = newID
	cp.Attrs["id"] = newID
	return cp
}

// withRefs returns a copy of b whose outgoing ref list is refs, in the
// comma-separated Attrs["ref"] form outgoingRefs tokenizes.
func (b SieveBlock) withRefs(refs []string) SieveBlock {
	cp := b.cloneDeep()
	cp.Attrs["ref"] = strings.Join(refs, ",")
	return cp
}
