package domain

import "sieve/store"

// Note is a filed document in the Library category.
// It wraps a MetaStorable returned by the Store — never constructed directly.
// The business type (Note vs Buffer) is the authoritative signal for filed
// status; the status frontmatter field is a pass-through for external editors.
type Note struct {
	s    store.MetaStorable
	slug string // key-derived short identifier, e.g. "my-note"
	kind DocumentKind
}

// NewNote constructs a Note and derives the slug once from the Store key.
func NewNote(s store.MetaStorable) *Note {
	return &Note{
		s:    s,
		slug: NewDocumentMeta(s.Meta(), s.SetMeta).DisplayName(),
		kind: KindNote,
	}
}

// Slug returns the key-derived short identifier without extension, e.g. "my-note".
// Derived once at construction — use for tab labels and sidebar display.
func (n *Note) Slug() string { return n.slug }

// UUID returns the frontmatter uuid field, which is the stable identity of
// this document across renames, moves, and history. Falls back to the Store
// key if the uuid field is absent (should not happen in practice).
func (n *Note) UUID() string {
	if u := n.s.Meta()["uuid"]; u != "" {
		return u
	}
	return n.s.Key()
}

// Body returns the pure markdown content with frontmatter stripped.
func (n *Note) Body() []byte { return n.s.Body() }

// SetBody replaces the body content. The change is local until NoteService.Save
// is called.
func (n *Note) SetBody(v []byte) { n.s.SetBody(v) }

// Meta returns a typed view over the underlying meta map. Mutations through
// the returned DocumentMeta are visible immediately and persist on the next
// NoteService.Save call.
func (n *Note) Meta() DocumentMeta {
	return NewDocumentMeta(n.s.Meta(), n.s.SetMeta)
}

// Versions returns lightweight history refs ordered newest-first. Fetch a
// snapshot with NoteService.RetrieveVersion.
func (n *Note) Versions() []store.VersionRef { return n.s.Versions() }

// Storable returns the underlying MetaStorable for direct Store operations.
func (n *Note) Storable() store.MetaStorable { return n.s }

func (n *Note) Kind() DocumentKind { return n.kind }
