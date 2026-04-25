package sieve

import (
	"path/filepath"
	"strings"
	"unicode"

	"sieve/store"
)

// ── Buffer type (Phase 3) — wraps store.MetaStorable ─────────────────────────

// Buffer is a working-copy document in the WorkingCopy category.
// It wraps a MetaStorable returned by the Store — never constructed directly.
// Use BufferService to create, load, save, and discard buffers.
type Buffer struct {
	s    store.MetaStorable
	slug string // key-derived short identifier, e.g. "buf-20240102-1504"
}

// newBuffer constructs a Buffer and derives the slug once from the Store key.
func newBuffer(s store.MetaStorable) *Buffer {
	buffer := &Buffer{
		s:    s,
		slug: strings.TrimSuffix(filepath.Base(s.Key()), filepath.Ext(s.Key())),
	}
	buffer.s.Meta()["status"] = "unfiled"
	return buffer
}

// Slug returns the key-derived short identifier without extension, e.g. "buf-20240102-1504".
// Derived once at construction — use for tab labels and sidebar display.
func (b *Buffer) Slug() string { return b.slug }

// UUID returns the frontmatter uuid field, which is the stable identity of
// this document across renames and history. Falls back to the Store key if the
// uuid field is absent (should not happen in practice).
func (b *Buffer) UUID() string {
	if u := b.s.Meta()["uuid"]; u != "" {
		return u
	}
	return b.s.Key()
}

// Path returns the store-relative path (ExternalRef) — e.g.
// "{hostname}/buffers/buf-20240102-1504.md". This is the identifier used by
// the frontend to address the buffer.
func (b *Buffer) Path() string { return b.s.ExternalRef() }

// Body returns the pure markdown content with frontmatter stripped.
func (b *Buffer) Body() []byte { return b.s.Body() }

// SetBody replaces the body content. The change is local until
// BufferService.Save is called.
func (b *Buffer) SetBody(v []byte) { b.s.SetBody(v) }

// Meta returns a typed view over the underlying meta map. Mutations through
// the returned DocumentMeta are visible immediately and persist on the next
// BufferService.Save call.
func (b *Buffer) Meta() DocumentMeta {
	return newDocumentMeta(b.s.Meta(), b.s.SetMeta)
}

// Versions returns lightweight history refs ordered newest-first. Fetch a
// snapshot with BufferService.RetrieveVersion.
func (b *Buffer) Versions() []store.VersionRef { return b.s.Versions() }

// Storable returns the underlying MetaStorable for direct Store operations.
func (b *Buffer) Storable() store.MetaStorable { return b.s }

// ── Shared string helpers used by BufferService and NoteService ───────────────

func toKebab(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			prevDash = false
		} else if !prevDash && b.Len() > 0 {
			b.WriteByte('-')
			prevDash = true
		}
	}
	result := strings.TrimRight(b.String(), "-")
	if result == "" {
		return "untitled"
	}
	if len(result) > 60 {
		result = result[:60]
	}
	return result
}

func cleanFolderPath(folder string) string {
	segments := strings.Split(filepath.ToSlash(folder), "/")
	var valid []string
	for _, seg := range segments {
		clean := cleanFolderSegment(seg)
		if clean != "" {
			valid = append(valid, clean)
		}
	}
	if len(valid) > 0 {
		return filepath.Join(valid...)
	}
	return ""
}

func cleanFolderSegment(s string) string {
	s = strings.TrimSpace(s)

	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
			prevSpace = false
		} else if r == ' ' {
			if !prevSpace {
				b.WriteRune(r)
				prevSpace = true
			}
		}
	}

	result := strings.TrimSpace(b.String())
	if result == "." || result == ".." {
		return ""
	}
	return result
}
