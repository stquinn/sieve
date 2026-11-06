// Package radio turns "a SieveInk companion is nearby" into a byte stream.
//
// It is the only package in the module that imports a Bluetooth library.
package radio

import (
	"context"
	"errors"
	"io"
	"time"
)

// The states of a host's Bluetooth that a person must change before a Dial can
// succeed. A Dial wraps one of these when it fails for that reason.
var (
	ErrBluetoothOff           = errors.New("Bluetooth is off")
	ErrBluetoothNotAuthorised = errors.New("Sieve is not authorised to use Bluetooth")
	ErrBluetoothUnsupported   = errors.New("Bluetooth ink is not supported on this computer")
)

// Radio finds a companion and opens a Link to it.
type Radio interface {
	// Dial returns a Link to the first companion found. Cancelling ctx stops a
	// scan in progress and makes Dial return promptly with ctx's error.
	Dial(ctx context.Context) (Link, error)
}

// Link is an open byte stream to one companion. Reads and writes may run
// concurrently with each other; Close ends both.
type Link interface {
	io.ReadWriteCloser
	// Identity is the companion's stable install identity.
	Identity() string
	// Elapsed is the time from the companion being seen to the stream being open.
	Elapsed() time.Duration
}
