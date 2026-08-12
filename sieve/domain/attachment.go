package domain

import "strings"

// AttachmentsAttr is the attrs-bag key an attachment list lives under, on a
// block and on the wire alike.
const AttachmentsAttr = "attachments"

// Attachment is a live edge to another Node in the system: the address of
// something Sieve already holds, offered as context for one AI turn.
//
// URI AND TITLE ARE THE WHOLE OF IT, and between them they are enough for
// everything an attachment does: the title labels the chip and names the document
// in the prompt, and the uri carries the uuid a model needs to read it. NOTHING
// is fetched to use an attachment — the prompt path resolves no addresses at all,
// which is what keeps it free of the document store.
//
// The title is the one it was attached under. A document renamed since then shows
// its old name paired with a uuid that still resolves — for a historical turn the
// more faithful record, not a stale one — and a document DELETED since then still
// reads "Auth Design" rather than a bare address.
//
// IT LIVES IN domain BECAUSE IT HAS SEVERAL CARRIERS. An attachment is persisted
// as a block attr (block/ names the key) AND it rides the command envelope onto
// command.Context — and `command` and `ai` cannot import `block` (block → ai →
// command already exists, so the reverse edge would close a cycle). It is a leaf
// value like Node and Candidate, so the leaf is where it belongs; no carrier owns
// it.
type Attachment struct {
	URI   string `json:"uri" yaml:"uri"`
	Title string `json:"title,omitempty" yaml:"title,omitempty"`
}

// Normalised trims the pair and reports whether what is left carries an address
// at all. An address-less attachment is not an attachment — there is nothing to
// resolve and nothing the title alone could stand for. Both carriers run their
// input through this one door, so "what counts as an attachment" is answered in
// exactly one place.
func (a Attachment) Normalised() (Attachment, bool) {
	a.URI = strings.TrimSpace(a.URI)
	a.Title = strings.TrimSpace(a.Title)
	return a, a.URI != ""
}

// Attachments is an ordered attachment list — the `attachments` attr, persisted
// as:
//
//	attachments:
//	    - uri: container:9f2b-…
//	      title: Auth Design
//
// It owns the translation between the loosely-typed attrs bag (what YAML and the
// wire hand over) and the typed form, so no caller reaches into
// Attrs["attachments"] and casts.
//
// An attachment is NOT a ref. `ref` stays the document-local chain the ai-block
// walks (resolveChain) and the GC prunes (outgoingRefs/gcRefs); an attachment is
// a global address that nothing walks and nothing GCs. One field could not be
// both — a three-turn chain where each turn attached different documents is
// where that breaks.
type Attachments []Attachment

// DecodeAttachments is the Attachments constructor: it reads whatever the attrs
// bag holds. A YAML parse and the JSON wire both produce []interface{} of
// map[string]interface{}; Go callers pass Attachments directly.
//
// This is also the DOOR: anything that is not uri or title is dropped, so a
// chip's transient decoration can never be persisted and later mistaken for
// truth. Entries with no uri are dropped too: an address-less attachment is not
// an attachment.
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
	case []Attachment:
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
// usable address. Attachment.Normalised is the shared door — the command
// envelope runs its own input through the same one.
func (a Attachments) decodeEntry(entry any) (Attachment, bool) {
	var out Attachment
	switch e := entry.(type) {
	case Attachment:
		out = e
	case map[string]any:
		out = Attachment{URI: a.stringField(e["uri"]), Title: a.stringField(e["title"])}
	case map[string]string:
		out = Attachment{URI: e["uri"], Title: e["title"]}
	default:
		return Attachment{}, false
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
