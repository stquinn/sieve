//go:build !linux || !cgo

// Package clipboard reads the OS clipboard in the UI process, through GTK. This
// is its no-op half: GTK is the Linux desktop's clipboard, and a cgo-off build
// (tests, CI) has no webview and no desktop to read one from. Answering "the
// clipboard held nothing" is the honest degradation — a paste that reaches here
// does nothing, exactly as it did before #87.
package clipboard

import "sieve/sieve/block"

// Reader answers every read with an empty clipboard.
type Reader struct{}

// New builds the no-op Reader.
func New() *Reader { return &Reader{} }

// Entries reports that the clipboard held nothing this reader can use.
func (r *Reader) Entries() ([]block.ContentEntry, error) { return nil, nil }
