package processors

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"sieve/sieve/block"
	"strconv"
)

// slottedLocator mints and reads the {slot, hash} locator shared by every
// TextUpdater whose reading IS its stored bytes, verbatim — code and diagram
// today. Kind names the owning processor in error text; everything else here
// is identical across every such kind, ONE hash primitive (fnv64a, the same
// one prose's proseLocator uses) included.
//
// Slot says which of the owner's slots a reading came from; Hash digests
// exactly the bytes read out of it. The owner supplies nothing but that slot
// name and, at Read, a lookup from a slot name back to its live text —
// everything about the locator's shape and its stale/malformed
// classification lives here once.
type slottedLocator struct {
	Kind string
}

// slotPayload is the locator's on-the-wire shape.
type slotPayload struct {
	Slot string `json:"slot"`
	Hash string `json:"hash"`
}

// hash digests text with the one primitive every slottedLocator uses. It is a
// check against that text having moved on, not against tampering, so speed is
// the only property that matters.
func (l slottedLocator) hash(text string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(text))
	return strconv.FormatUint(h.Sum64(), 16)
}

// Mint builds the locator for slot: the slot name and a digest of the bytes
// currently read out of it.
func (l slottedLocator) Mint(slot, text string) string {
	encoded, err := json.Marshal(slotPayload{Slot: slot, Hash: l.hash(text)})
	if err != nil {
		return ""
	}
	return string(encoded)
}

// Read answers which slot locator names and whether it still names that
// slot's CURRENT bytes. slotText is the owner's own lookup from a slot name
// to its live stored text, reporting false for a slot the owner has never
// minted a locator for.
//
// A locator this processor never minted — the wrong shape, or a slot
// slotText does not know — is MALFORMED: no text could make it resolve. One
// naming a real slot whose digest no longer matches is STALE: that slot's
// payload has moved on since it was read, and every anchor into it goes
// with it.
func (l slottedLocator) Read(locator string, slotText func(slot string) (text string, known bool)) (slot, text string, err error) {
	var payload slotPayload
	if jsonErr := json.Unmarshal([]byte(locator), &payload); jsonErr != nil || payload.Slot == "" || payload.Hash == "" {
		return "", "", fmt.Errorf("%w: %s: locator %q was not minted here", block.ErrTextMalformed, l.Kind, locator)
	}
	text, known := slotText(payload.Slot)
	if !known {
		return "", "", fmt.Errorf("%w: %s: locator names slot %q this block does not bear", block.ErrTextMalformed, l.Kind, payload.Slot)
	}
	if payload.Hash != l.hash(text) {
		return "", "", fmt.Errorf("%w: the text this anchor was read from has changed", block.ErrTextStale)
	}
	return payload.Slot, text, nil
}
