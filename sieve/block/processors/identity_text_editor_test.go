package processors

import (
	"errors"
	"fmt"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// identityTextEditor.Apply's error PRECEDENCE across a whole batch, mirroring
// ProseProcessor.UpdateText's own two-phase shape (prose_processor.go): every
// edit's locator is validated first, over the whole batch, and only once
// every locator has passed is any edit's anchor resolved. A malformed locator
// therefore DOMINATES a stale anchor elsewhere in the same batch, whichever
// order the edits arrive in — the anchor-resolution phase for the edit that
// would merely be stale never runs, because the malformed one fails the
// locator phase first.
func TestIdentityTextEditor_AMalformedLocatorDominatesAStaleAnchorInTheSameBatch(t *testing.T) {
	const text = "teh cat"
	editor := identityTextEditor{Kind: "test", ReadLocator: func(locator string) (string, string, error) {
		if locator != "ok" {
			return "", "", fmt.Errorf("%w: test: locator %q was not minted here", block.ErrTextMalformed, locator)
		}
		return "slot", text, nil
	}}
	stale := domain.TextEdit{Locator: "ok", Quote: "wolrd", Grain: domain.GrainWord, Replacement: "world"}
	malformed := domain.TextEdit{Locator: "not-ours", Quote: "teh", Grain: domain.GrainWord, Replacement: "the"}

	for _, edits := range [][]domain.TextEdit{{stale, malformed}, {malformed, stale}} {
		_, err := editor.Apply(edits)
		if !errors.Is(err, block.ErrTextMalformed) {
			t.Errorf("edits %v: err = %v, want ErrTextMalformed", edits, err)
		}
		if errors.Is(err, block.ErrTextStale) {
			t.Errorf("edits %v: a malformed batch reported as stale", edits)
		}
	}
}

// Two edits, one per slot, one of them stale: the batch fails all-or-nothing
// across slots, not just within one — neither slot's finalText is ever
// returned to a caller to write.
func TestIdentityTextEditor_ACrossSlotBatchIsAllOrNothing(t *testing.T) {
	slots := map[string]string{"a": "teh cat", "b": "teh dog"}
	editor := identityTextEditor{Kind: "test", ReadLocator: func(locator string) (string, string, error) {
		text, ok := slots[locator]
		if !ok {
			return "", "", fmt.Errorf("%w: test: locator %q was not minted here", block.ErrTextMalformed, locator)
		}
		return locator, text, nil
	}}
	good := domain.TextEdit{Locator: "a", Quote: "teh", Occurrence: 0, Grain: domain.GrainWord, Replacement: "the"}
	stale := domain.TextEdit{Locator: "b", Quote: "wolrd", Occurrence: 0, Grain: domain.GrainWord, Replacement: "world"}

	got, err := editor.Apply([]domain.TextEdit{good, stale})
	if !errors.Is(err, block.ErrTextStale) {
		t.Fatalf("err = %v, want ErrTextStale", err)
	}
	if got != nil {
		t.Errorf("a failed batch returned a result to write: %#v", got)
	}
}
