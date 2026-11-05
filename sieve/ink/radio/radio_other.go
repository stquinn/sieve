//go:build !linux

package radio

import (
	"context"
	"errors"
)

type unsupported struct{}

// NewBluetooth returns the platform's Bluetooth Radio. On this platform every
// Dial fails.
func NewBluetooth() Radio { return unsupported{} }

func (unsupported) Dial(context.Context) (Link, error) {
	return nil, errors.New("Bluetooth ink is not supported on this platform")
}
