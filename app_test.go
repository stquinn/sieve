package main

import "testing"

// PickDirectory is a pure path picker (no side effects) used to fill form fields
// like a containment directory grant. The native dialog can't run headless, so
// the one unit-testable contract is its guard: with no app context it must error
// rather than call into a nil Wails runtime.
func TestPickDirectory_RequiresContext(t *testing.T) {
	_, err := (&App{}).PickDirectory()
	if err == nil {
		t.Fatal("PickDirectory with nil ctx = nil error, want an error (must not dereference a nil runtime ctx)")
	}
}
