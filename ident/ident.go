// Package ident owns identity for everything Sieve persists — documents and
// blocks alike. It must stay a leaf: store/ cannot import sieve/, so an id type
// under sieve/domain would be unreachable from filestore.
package ident

import (
	"strings"

	"github.com/google/uuid"
)

// New mints a UUIDv7 — time-ordered, so ids sort chronologically. It falls back
// to v4 if the clock read fails, which costs ordering but never uniqueness.
func New() string {
	if u, err := uuid.NewV7(); err == nil {
		return u.String()
	}
	return uuid.NewString()
}

// Valid reports whether s is a UUID in the canonical 8-4-4-4-12 form. It is
// deliberately STRICTER than uuid.Parse, which also accepts the urn:, braced and
// hyphen-less spellings: this decides whether an id has already been migrated, so
// a form Sieve would never mint must answer false.
func Valid(s string) bool {
	if len(s) != 36 {
		return false
	}
	_, err := uuid.Parse(s)
	return err == nil
}

// Canonical returns the one spelling of an id — LOWERCASE, which is what Sieve
// mints — so two writings of the same uuid compare and index alike. RFC 4122
// makes hex case insignificant, so an uppercase spelling parses happily and then
// misses a lowercase-named directory on disk.
//
// Anything that is not a valid uuid comes back untouched: this normalises
// identity, it does not invent it. A caller wanting a refusal asks Valid.
func Canonical(s string) string {
	if !Valid(s) {
		return s
	}
	return strings.ToLower(s)
}
