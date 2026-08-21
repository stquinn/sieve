//go:build linux && cgo

package clipboard

/*
#include <stdint.h>
*/
import "C"

import "unsafe"

// sieveClipboardOffer is what the GTK main loop calls when a clipboard read has
// an answer — or has none, which it says with a nil mime. It is a bare package
// function because cgo requires that of an //export, and it does nothing but
// hand the result to the registry: this file may hold no C definitions, so the
// C helpers that call it live in reader_linux.go.
//
// It runs ON THE MAIN LOOP and must not block. Delivery is a map lookup and a
// send to a buffered channel, neither of which can.
//
//export sieveClipboardOffer
func sieveClipboardOffer(id C.uint64_t, mime *C.char, data unsafe.Pointer, length C.int) {
	pendingReads.offer(uint64(id), mime, data, length)
}
