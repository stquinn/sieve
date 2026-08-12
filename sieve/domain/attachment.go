package domain

import "strings"

// Attachment is a live edge to another Node in the system: the address of
// something Sieve already holds, offered as context for one AI turn.
//
// URI IS THE TRUTH. TITLE IS A RENDER CACHE, never read back as truth: kind and
// summary are resolved fresh through the Router at job time, so a stale title
// can reach a chip but can never reach the model. It exists so a chip whose
// target was deleted still reads "Auth Design" instead of a bare address —
// dangling is a normal state, not an error.
//
// IT LIVES IN domain BECAUSE IT HAS TWO CARRIERS. An attachment is persisted as
// a block attr (block.Attachments owns that attrs-bag translation) AND it rides
// the command envelope onto command.Context — and `command` cannot import
// `block` (block → ai → command already exists, so the reverse edge would close
// a cycle). It is a leaf value like Node and Candidate, so the leaf is where it
// belongs; neither carrier owns it.
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
