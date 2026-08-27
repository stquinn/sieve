package block

import (
	"encoding/json"

	"sieve/ident"
)

// QuestionAttr is the attrs-bag key an ai-block's question elements live under.
const QuestionAttr = "question"

// Elements is an ordered list of child blocks held inside one parent block's
// attrs. An element IS a SieveBlock — the same kind vocabulary, the same attrs
// bag, the same two-sided id invariant (the ID field AND Attrs["id"]) — and
// differs only in where it lives: inside its parent's payload and nowhere else.
// The document tree never contains one, so no document-level id, alias or ref
// resolves to it; an element id is unique within its parent.
//
// ONE ENCODING FOR EVERY KIND. An element persists as a kind/attrs pair,
// whatever its kind carries:
//
//	question:
//	    - kind: prose
//	      attrs:
//	          id: 0198a1b2-…
//	          content: What does this mean?
//	    - kind: reference
//	      attrs:
//	          id: 0198a1b2-…
//	          uri: sieve://9f2b…/0197…
//	          rel: target
//
// `kind` sits outside the bag because it is not an attr; everything else a kind
// owns rides inside it, so a new element kind needs no encoding of its own.
//
// A caller reads the list through SieveBlock.Elements and writes it through
// SieveBlock.SetElements — nothing reaches into the attr and casts.
type Elements []SieveBlock

// elementKindKey and elementAttrsKey are the two keys of the encoding.
const (
	elementKindKey  = "kind"
	elementAttrsKey = "attrs"
)

// DecodeElements is the Elements constructor: it reads whatever the attrs bag
// holds. A YAML parse and the JSON wire both produce []interface{} of
// map[string]interface{}; Go callers pass Elements directly.
//
// An entry naming no kind is dropped — the encoding cannot say what it is. An
// id-less entry is minted one IN PLACE, written into the stored entry before the
// element is built: the id must be the same on every read, and the element must
// keep carrying the stored attrs map rather than a copy NewSieveBlock would make
// to hold a differing id. That mint is the BACKSTOP — a list entering through
// MintElementIDs is already identified and no read of it writes anything.
func DecodeElements(v any) Elements {
	var raw []any
	switch list := v.(type) {
	case nil:
		return nil
	case Elements:
		return list
	case []SieveBlock:
		return Elements(list)
	case []any:
		raw = list
	default:
		return nil
	}

	out := make(Elements, 0, len(raw))
	for _, entry := range raw {
		if e, ok := out.decodeEntry(entry); ok {
			out = append(out, e)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// decodeEntry reads one loosely-typed entry, reporting whether it described an
// element at all. It WRITES the identity it had to mint back into the entry, so
// the stored payload and the element agree on both sides of the id invariant.
func (e Elements) decodeEntry(entry any) (SieveBlock, bool) {
	switch v := entry.(type) {
	case SieveBlock:
		return v, true
	case map[string]any:
		kind, _ := v[elementKindKey].(string)
		if kind == "" {
			return SieveBlock{}, false
		}
		attrs, _ := v[elementAttrsKey].(map[string]any)
		if attrs == nil {
			attrs = map[string]any{}
			v[elementAttrsKey] = attrs
		}
		id, _ := attrs["id"].(string)
		if id == "" {
			id = ident.New()
			attrs["id"] = id
		}
		return NewSieveBlock(kind, id, attrs), true
	default:
		return SieveBlock{}, false
	}
}

// MintElementIDs gives every id-less element under key the identity it keeps,
// written into the STORED entry on both sides of the id invariant.
//
// It is NewSieveBlock's birth rule applied to elements at the same moment: a
// processor's InitAttrs runs it over the attrs bag it has just composed, so a
// composed list is identified before the block carrying it enters the tree. A
// caller holding a bag and no block yet has nowhere else to apply it.
//
// A LIST IDENTIFIED HERE IS NEVER WRITTEN TO AGAIN BY A READ, which is what
// makes it safe to fold one out of a job snapshot: such a snapshot shares its
// element payloads with the live tree, and a read that minted would be writing
// into them without the document's lock.
//
// The mint is DecodeElements' own, performed as it reads; the list it returns is
// not what this is called for.
func MintElementIDs(attrs map[string]interface{}, key string) {
	DecodeElements(attrs[key])
}

// attrValue renders the list into the canonical attrs-bag form: []interface{}
// of map[string]interface{}. It must stay this form and not []SieveBlock — a
// struct marshals its fields in declaration order and a map in sorted-key order,
// so mixing the two rewrites the YAML on the second save.
func (e Elements) attrValue() []interface{} {
	if len(e) == 0 {
		return nil
	}
	out := make([]interface{}, 0, len(e))
	for _, el := range e {
		attrs := el.Attrs
		if attrs == nil {
			attrs = map[string]interface{}{}
		}
		out = append(out, map[string]interface{}{
			elementKindKey:  el.Kind,
			elementAttrsKey: attrs,
		})
	}
	return out
}

// MarshalYAML persists the list in the canonical encoding, so a list held in the
// typed form and the same list as it came off disk produce identical bytes.
func (e Elements) MarshalYAML() (interface{}, error) { return e.attrValue(), nil }

// MarshalJSON sends the list in the canonical encoding, so the wire and disk
// carry one element shape.
func (e Elements) MarshalJSON() ([]byte, error) { return json.Marshal(e.attrValue()) }

// Elements returns the child blocks this block holds under key, in order, or nil
// when it holds none.
//
// Each element's Attrs IS the map the block holds, so an attr written through a
// returned element lands on the block. The LIST is read fresh, so adding,
// removing or reordering elements goes through SetElements.
//
// Reading never rewrites the stored payload — a read-only DocView snapshot,
// whose blocks share their attrs maps with the live tree, can ask a block for
// its children. An entry arriving id-less is the one thing a read still writes,
// because an element whose id changed per read would be no identity at all; it
// is a backstop for a door that skipped MintElementIDs, not a path anything in
// the tree takes.
func (b SieveBlock) Elements(key string) []*SieveBlock {
	if b.Attrs == nil {
		return nil
	}
	decoded := DecodeElements(b.Attrs[key])
	if len(decoded) == 0 {
		return nil
	}
	out := make([]*SieveBlock, len(decoded))
	for i := range decoded {
		out[i] = &decoded[i]
	}
	return out
}

// SetElements writes the list under key. An empty list REMOVES the key: absent
// is the empty case.
func (b *SieveBlock) SetElements(key string, e Elements) {
	if b.Attrs == nil {
		if len(e) == 0 {
			return
		}
		b.Attrs = map[string]interface{}{}
	}
	if len(e) == 0 {
		delete(b.Attrs, key)
		return
	}
	b.Attrs[key] = e
}
