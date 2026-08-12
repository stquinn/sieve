// Package ident owns identity for everything Sieve persists — documents and
// blocks alike. It is a leaf: store/ does not import sieve/, so an id type in
// sieve/domain would be unreachable from filestore, and two copies of "mint a
// uuid" is exactly the divergence this package exists to prevent.
//
// Named ident rather than id because `id` shadows the commonest local variable
// in this codebase.
package ident

import "github.com/google/uuid"

// New mints a UUIDv7 — time-ordered, so ids sort chronologically and index
// locality is preserved. Falls back to v4 if the system clock read fails, which
// costs ordering but never uniqueness; an id-less block is unrecoverable, an
// unordered one is merely untidy.
func New() string {
	if u, err := uuid.NewV7(); err == nil {
		return u.String()
	}
	return uuid.NewString()
}

// Valid reports whether s is a UUID in the canonical 8-4-4-4-12 form. It is
// deliberately STRICTER than uuid.Parse, which also accepts the urn:, braced and
// hyphen-less spellings: this is the predicate that decides "has this id already
// been migrated", so a form we would never mint must answer false.
func Valid(s string) bool {
	if len(s) != 36 {
		return false
	}
	_, err := uuid.Parse(s)
	return err == nil
}
