package domain

import "strings"

// AttachmentsAttr is the attrs-bag key an attachment list lives under, on a
// block and on the wire alike.
const AttachmentsAttr = "attachments"

// Attachment is a live edge to another NodeDescriptor in the system: the address
// of something Sieve already holds, offered as context for one AI turn.
//
// URI AND TITLE ARE THE WHOLE OF IT: the title labels the chip and names the
// document in the prompt, the uri carries the address a model needs to read it.
// NOTHING is fetched to use an attachment — the prompt path resolves no
// addresses at all.
//
// The title is the one it was attached under, so a document renamed or deleted
// since still reads under the name the turn recorded.
type Attachment struct {
	URI   string `json:"uri" yaml:"uri"`
	Title string `json:"title,omitempty" yaml:"title,omitempty"`
}

// Normalised trims the pair and reports whether what is left carries an address
// at all. Every carrier runs its input through this one door, so an address-less
// attachment is never built.
func (a Attachment) Normalised() (Attachment, bool) {
	a.URI = strings.TrimSpace(a.URI)
	a.Title = strings.TrimSpace(a.Title)
	return a, a.URI != ""
}

// Attachments is an ordered attachment list — the `attachments` attr, persisted
// as:
//
//	attachments:
//	    - uri: sieve://9f2b-…
//	      title: Auth Design
//
// It owns the translation between the loosely-typed attrs bag (what YAML and the
// wire hand over) and the typed form, so no caller reaches into
// Attrs["attachments"] and casts.
//
// An attachment is NOT a ref. `ref` is the document-local chain the ai-block
// walks and the GC prunes; an attachment is a global address that nothing walks
// and nothing GCs.
type Attachments []Attachment

// DecodeAttachments is the Attachments constructor: it reads whatever the attrs
// bag holds. A YAML parse and the JSON wire both produce []interface{} of
// map[string]interface{}; Go callers pass Attachments directly.
//
// Anything that is not uri or title is dropped, as is any entry with no uri.
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
// usable address.
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
// []interface{} of map[string]interface{}. It must stay this form and not
// []Attachment — a struct marshals its fields in declaration order and a map in
// sorted-key order, so mixing the two rewrites the YAML on the second save.
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
