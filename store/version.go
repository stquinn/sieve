package store

import (
	"errors"
	"time"
)

// VersionRef is a lightweight reference to a stored snapshot. It carries
// enough information to display a history list without loading content.
// Call Store.RetrieveVersion to fetch the full snapshot.
type VersionRef struct {
	// ID uniquely identifies this snapshot within the Storable's history.
	ID string
	// Created is when this snapshot was written.
	Created time.Time
	// Size is the byte size of the snapshot body.
	Size int64
}

// VersionedStorable is a deserialized snapshot of a Storable at a point in
// time. It deliberately does not embed the Storable interface: Key, Category,
// ExternalRef, and Versions have no meaning on a historical snapshot, and a
// VersionedStorable cannot be accidentally passed to Store.Save.
//
// A Buffer that was later filed as a Note will have history entries spanning
// both states — VersionedStorable is untyped by design.
type VersionedStorable struct {
	// Ref identifies which snapshot this is.
	Ref VersionRef
	// Body is the raw content at the time of the snapshot, with frontmatter
	// stripped for MetaStorables.
	Body []byte
	// Meta is the metadata map at the time of the snapshot. Nil for plain
	// Storables (settings, session).
	Meta map[string]string
	// Owns lists the assets owned by this document at the time of the snapshot.
	// Nil for Storables that do not own assets.
	Owns []Storable
}

// ErrStaleStorable is returned by Store.Save when the incoming Storable is
// based on a version that is no longer the latest in the Store. The caller
// should reload from Store, reapply their changes, and retry.
var ErrStaleStorable = errors.New("storable is stale — reload and retry")
