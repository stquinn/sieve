package domain

import (
	"errors"

	"sieve/store"
)

// ErrNotADocument reports a storable whose .meta type is not store.TypeDocument,
// whatever category holds it.
var ErrNotADocument = errors.New("document: storable is not a document")

type DocumentKind string

const (
	KindBuffer DocumentKind = "buffer" // WorkingCopy category
	KindNote   DocumentKind = "note"   // Library category
)

// IsDocument reports whether k names a document kind.
func (k DocumentKind) IsDocument() bool { return k == KindNote || k == KindBuffer }

// FiledStatus maps the kind to the tab/meta presentation status: a Note lives in
// the Library (filed), everything else is an unfiled working copy. This is the
// single owner of the filed/unfiled mapping — tab and note handlers derive their
// display status from it rather than each re-deriving the string inline.
func (k DocumentKind) FiledStatus() string {
	if k == KindNote {
		return "filed"
	}
	return "unfiled"
}

type Document interface {
	Kind() DocumentKind
	UUID() string
	Slug() string
	Body() []byte
	SetBody(v []byte)
	Meta() DocumentMeta
	Versions() []store.VersionRef
	Storable() store.MetaStorable
}
