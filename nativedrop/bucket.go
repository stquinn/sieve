// Package nativedrop holds the paths of the most recent OS file drop, caught at
// the GTK layer by Wails' OnFileDrop. It exists because WebKitGTK starves the
// page of drop content (#86): the DOM sees the gesture but can read nothing, so
// the frontend redeems "a drop just landed here" and the bytes' ADDRESSES come
// from this bucket — never from the wire.
package nativedrop

import (
	"sync"
	"time"
)

// Default is the process's one bucket: one window, one drag at a time. The
// composition root wires it into the editor; app startup feeds it from
// OnFileDrop. A package-level instance because both ends live in different
// packages that must see the SAME slot.
var Default = NewBucket()

// freshFor is how long a caught drop stays redeemable. The redeem arrives on
// the next WS frame after the gesture — milliseconds — so anything old is a
// drop nobody claimed.
const freshFor = 5 * time.Second

type Bucket struct {
	mu      sync.Mutex
	paths   []string
	at      time.Time
	arrived chan struct{}
}

func NewBucket() *Bucket {
	return &Bucket{arrived: make(chan struct{}, 1)}
}

// Put stores one drop's paths, replacing anything unclaimed.
func (b *Bucket) Put(paths []string) {
	b.mu.Lock()
	b.paths = append([]string(nil), paths...)
	b.at = time.Now()
	b.mu.Unlock()
	select {
	case b.arrived <- struct{}{}:
	default:
	}
}

// TakeDrop returns the pending drop's paths, waiting up to maxWait for one to
// arrive — the DOM's redeem and GTK's callback race on the same gesture, and
// neither order is guaranteed. Single-use: a taken drop is gone.
func (b *Bucket) TakeDrop(maxWait time.Duration) []string {
	if paths := b.take(); paths != nil {
		return paths
	}
	select {
	case <-b.arrived:
		return b.take()
	case <-time.After(maxWait):
		return nil
	}
}

func (b *Bucket) take() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.paths == nil || time.Since(b.at) > freshFor {
		b.paths = nil
		return nil
	}
	paths := b.paths
	b.paths = nil
	// Drain a signal this take already consumed, so a stale token cannot answer
	// the NEXT redeem instantly with nothing.
	select {
	case <-b.arrived:
	default:
	}
	return paths
}
