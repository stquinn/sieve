package block

import "strings"

// sieve_block.go — the SieveBlock data model: type, constructor, and value
// methods. No serialization, no parsing, and no per-kind names — the data model is
// kind-agnostic; those live in document_codec.go and the codec/processor files.

// SieveBlock is a node in the unified, ordered block tree (spec §2). EVERY kind —
// prose included — carries its payload in the single Attrs bag, addressed by id;
// kind is consulted only at render/serialise time. There is no per-kind payload
// field: prose's body is Attrs["content"] (read via Content()), exactly as code
// is Attrs["source"], web-clip Attrs["content"], ai Attrs["response"].
//
// There is no Children field: a block is a LEAF. Containers (columns) are a
// distinct structural type — they HOLD blocks but are not blocks (no payload, no
// content) — and arrive in Stage E behind a small Node interface (ID()/Kind())
// both implement. Until then nothing nests at runtime.
type SieveBlock struct {
	ID    string
	Kind  string
	Attrs map[string]interface{}
	// Aliases are additional handles this block answers to, accumulated when
	// other blocks merge into it (spec §7). ID is the primary handle; a ref
	// resolves against ID or any alias.
	Aliases []string
}

// NewSieveBlock is the sole sanctioned way to construct a block, and it enforces
// the invariant the type cannot enforce on its own (Go has no constructors): a
// block is GIVEN an id or it GENERATES one — it never exists id-less. Every
// construction site (the parser, ApplyOp create, split) routes through here, so
// the rule lives in ONE place instead of being swept after the fact. Pass id=""
// to mint (GenerateBlockIDFor honors a registered processor's prefix); pass a
// known id (a marker's handle, a frontend-minted blockId) to keep it. The
// serialize-time guard in DocumentCodec.Serialize is the runtime backstop
// for any future code path that bypasses this factory with a raw literal.
func NewSieveBlock(kind, id string, attrs map[string]interface{}) SieveBlock {
	if id == "" {
		id = GenerateBlockIDFor(kind)
	}
	return SieveBlock{ID: id, Kind: kind, Attrs: attrs}
}

// Content is the block's authored text payload (Attrs["content"]) — a prose
// block's verbatim markdown, a web-clip's clipped text. "" when absent. A nil-safe
// typed read of one attr key (sibling of Source/Status/Ref); whether this accessor
// family earns its keep over direct Attrs access is a separate question.
func (b SieveBlock) Content() string { return b.StringAttr("content") }

// Merge applies a patch onto this block: attrs merge additively (a partial patch
// keeps existing keys — a NodeView sending only {source} must not drop status),
// and aliases REPLACE the current set when the patch carries them (nil leaves
// them untouched). This is the single block-patch semantic, shared by
// ShadowDocument.MergeBlock and the update-block op. Content is just
// Attrs["content"], so prose needs no special handling here — the attr merge
// carries it like any other key.
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
// nil, or not a string. It is the single safe primitive the named accessors
// below are built on — replacing brittle b.Attrs["x"].(string) casts (spec #5)
// that panic or silently mis-type. Storage stays kind-agnostic (one Attrs bag);
// only the read is typed.
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

// answersTo returns every handle this block resolves to — its primary ID plus
// any aliases absorbed via merges (spec §7).
func (b SieveBlock) answersTo() []string {
	out := make([]string, 0, 1+len(b.Aliases))
	if b.ID != "" {
		out = append(out, b.ID)
	}
	return append(out, b.Aliases...)
}

// outgoingRefs returns this block's outgoing ref targets (Attrs["ref"]) as an
// ordered, whitespace-trimmed, non-empty slice — the tokenized form of the
// comma-separated Ref() string. Mirrors answersTo() for the outgoing direction.
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

// cloneDeep returns a value copy of b with a freshly-allocated Attrs map (and
// Aliases slice), so a caller can hand it to a processor / background job that
// mutates Attrs without racing the live tree. Content lives in Attrs, so the map
// copy carries it.
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

// The document is an ordered []SieveBlock — the in-memory form the serialization
// spine round-trips against markdown. There is no wrapper type: ShadowDocument
// holds the slice directly (no nested "document inside a document").
