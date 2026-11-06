//go:build !linux && !(darwin && cgo)

package radio

import "context"

type unsupported struct{}

// NewBluetooth returns the platform's Bluetooth Radio. On this platform every
// Dial fails.
func NewBluetooth() Radio { return unsupported{} }

func (unsupported) Dial(context.Context) (Link, error) {
	return nil, ErrBluetoothUnsupported
}
