package sieve

// sieve_block.go — the SieveBlock data model: type, constructor, value methods,
// and reserved-kind constants. No serialization, no parsing; those live in
// block_serde.go and the codec/processor files.

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

// Reserved kinds that are not registered BlockProcessors.
const (
	KindProse     = "prose"
	KindColumnRow = "column-row"
	KindColumn    = "column"
)

// newSieveBlock is the sole sanctioned way to construct a block, and it enforces
// the invariant the type cannot enforce on its own (Go has no constructors): a
// block is GIVEN an id or it GENERATES one — it never exists id-less. Every
// construction site (the parser, ApplyOp create, split) routes through here, so
// the rule lives in ONE place instead of being swept after the fact. Pass id=""
// to mint (GenerateBlockIDFor honors a registered processor's prefix); pass a
// known id (a marker's handle, a frontend-minted blockId) to keep it. The
// serialize-time guard in DocumentCodec.Serialize is the runtime backstop
// for any future code path that bypasses this factory with a raw literal.
func newSieveBlock(kind, id, content string, attrs map[string]interface{}) SieveBlock {
	if id == "" {
		id = GenerateBlockIDFor(kind)
	}
	b := SieveBlock{ID: id, Kind: kind, Attrs: attrs}
	if content != "" {
		b.setContent(content)
	}
	return b
}

// Content is the block's authored text payload (Attrs["content"]) — a prose
// block's verbatim markdown, a web-clip's clipped text. "" for kinds that carry
// no content attr. The typed read that replaces the old SieveBlock.Content field.
func (b SieveBlock) Content() string { return b.StringAttr("content") }

// setContent writes the authored text payload into the Attrs bag, lazily
// allocating it. The single write-side counterpart to Content().
func (b *SieveBlock) setContent(content string) {
	if b.Attrs == nil {
		b.Attrs = map[string]interface{}{}
	}
	b.Attrs["content"] = content
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

// The document is an ordered []SieveBlock — the in-memory form the serialization
// spine round-trips against markdown. There is no wrapper type: ShadowDocument
// holds the slice directly (no nested "document inside a document").
