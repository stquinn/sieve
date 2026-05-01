package sieve

import "sieve/store"

type DocumentKind string

const (
	KindBuffer DocumentKind = "buffer" // WorkingCopy category
	KindNote   DocumentKind = "note"   // Library category
)

type Document interface {
	Kind() DocumentKind
	UUID() string
	Path() string
	Slug() string
	Body() []byte
	SetBody(v []byte)
	Meta() DocumentMeta
	Versions() []store.VersionRef
	Storable() store.MetaStorable
}
