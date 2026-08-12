package block

import (
	"strings"

	"sieve/sieve/domain"
)

// AttachmentsAttr is the attrs-bag key the attachment list lives under.
const AttachmentsAttr = "attachments"

// Attachments is a block's ordered attachment list — the `attachments` attr,
// persisted as:
//
//	attachments:
//	    - uri: container:9f2b-…
//	      title: Auth Design
//
// The VALUE is domain.Attachment (it has a second carrier — the command
// envelope — and `command` cannot import `block`). What this type owns is the
// translation between the loosely-typed attrs bag (what YAML and the wire hand
// over) and the typed form, so no caller reaches into Attrs["attachments"] and
// casts; and the rendering of a turn's attachments into the prompt.
//
// An attachment is NOT a ref. `ref` stays the document-local chain the ai-block
// walks (resolveChain) and the GC prunes (outgoingRefs/gcRefs); an attachment is
// a global address that nothing walks and nothing GCs. One field could not be
// both — a three-turn chain where each turn attached different documents is
// where that breaks.
type Attachments []domain.Attachment

// DecodeAttachments is the Attachments constructor: it reads whatever the attrs
// bag holds. A YAML parse and the JSON wire both produce []interface{} of
// map[string]interface{}; Go callers pass Attachments directly.
//
// This is also the DOOR: anything that is not uri or title is dropped, so a
// chip's transient fields (kind, summary — resolved fresh at job time) can never
// be persisted and later mistaken for truth. Entries with no uri are dropped
// too: an address-less attachment is not an attachment.
func DecodeAttachments(v any) Attachments {
	var raw []any
	switch list := v.(type) {
	case nil:
		return nil
	case Attachments:
		raw = make([]any, 0, len(list))
		for _, a := range list {
			raw = append(raw, a)
		}
	case []domain.Attachment:
		raw = make([]any, 0, len(list))
		for _, a := range list {
			raw = append(raw, a)
		}
	case []any:
		raw = list
	default:
		return nil
	}

	out := make(Attachments, 0, len(raw))
	for _, entry := range raw {
		if a, ok := out.decodeEntry(entry); ok {
			out = append(out, a)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// decodeEntry reads one loosely-typed entry, reporting whether it carried a
// usable address. domain.Attachment.Normalised is the shared door — the command
// envelope runs its own input through the same one.
func (a Attachments) decodeEntry(entry any) (domain.Attachment, bool) {
	var out domain.Attachment
	switch e := entry.(type) {
	case domain.Attachment:
		out = e
	case map[string]any:
		out = domain.Attachment{URI: a.stringField(e["uri"]), Title: a.stringField(e["title"])}
	case map[string]string:
		out = domain.Attachment{URI: e["uri"], Title: e["title"]}
	default:
		return domain.Attachment{}, false
	}
	return out.Normalised()
}

// stringField is the nil-safe read of one loosely-typed field.
func (a Attachments) stringField(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

// AttrValue renders the list back into the canonical attrs-bag form:
// []interface{} of map[string]interface{}.
//
// ONE form in and out is what keeps the fenced YAML byte-stable across a
// serialize → parse → serialize round trip: a []Attachment marshals its fields
// in struct order while a map marshals in sorted-key order — two spellings of
// the same data, and the second save would rewrite the first.
func (a Attachments) AttrValue() []interface{} {
	if len(a) == 0 {
		return nil
	}
	out := make([]interface{}, 0, len(a))
	for _, att := range a {
		entry := map[string]interface{}{"uri": att.URI}
		if att.Title != "" {
			entry["title"] = att.Title
		}
		out = append(out, entry)
	}
	return out
}

// Attachments is this block's attachment list — a typed read of one attr key,
// sibling of Ref()/Status().
func (b SieveBlock) Attachments() Attachments {
	return DecodeAttachments(b.Attrs[AttachmentsAttr])
}

// SetAttachments writes the list in canonical form. An empty list REMOVES the
// key: absent IS the empty case, so a block that attached nothing serializes
// exactly as it did before this attr existed.
func (b *SieveBlock) SetAttachments(a Attachments) {
	value := a.AttrValue()
	if len(value) == 0 {
		delete(b.Attrs, AttachmentsAttr)
		return
	}
	if b.Attrs == nil {
		b.Attrs = map[string]interface{}{}
	}
	b.Attrs[AttachmentsAttr] = value
}
