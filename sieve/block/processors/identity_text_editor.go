package processors

import (
	"fmt"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sort"
)

// identityTextEditor is the batch-resolve-and-splice behaviour shared by every
// TextUpdater whose READING IS ITS STORED BYTES — no parse, no offset map back
// to markup, unlike prose's ProseReading (prose_reading.go). Code and diagram
// are its two members, both minting their locators through the shared
// slottedLocator (slotted_locator.go). Kind names the owner in error text;
// ReadLocator is that owner's own readLocator, closed over its live block, so
// this type never sees a block or an attrs map itself.
type identityTextEditor struct {
	Kind        string
	ReadLocator func(locator string) (slot, text string, err error)
}

// splice is one resolved edit within a single slot: the byte range it cuts
// and what replaces it.
type splice struct {
	start, stop int
	replacement string
}

// Apply resolves every edit against the CURRENT text of the slot its locator
// names and returns each touched slot's fully-spliced result — the whole
// batch, all validated and spliced, nothing written anywhere yet. It is the
// caller's job to write the result into its block's attrs, which is safe to
// do unconditionally once Apply has returned without error: every slot
// present has already been sorted, overlap-checked and spliced back to
// front, so a later slot's failure can never surface after an earlier one
// was accepted.
//
// EVERY EDIT'S LOCATOR IS READ FIRST, OVER THE WHOLE BATCH, BEFORE ANY EDIT
// IS RESOLVED — mirroring ProseProcessor.UpdateText's own two-phase shape
// (prose_processor.go). A malformed or stale locator therefore dominates a
// merely-stale anchor elsewhere in the same batch, whichever order the edits
// arrive in: the anchor-resolution phase never starts until every locator in
// the batch has already passed.
func (e identityTextEditor) Apply(edits []domain.TextEdit) (map[string]string, error) {
	slotText := map[string]string{}
	editSlot := make([]string, len(edits))
	for i, edit := range edits {
		slot, text, err := e.ReadLocator(edit.Locator)
		if err != nil {
			return nil, err
		}
		slotText[slot] = text
		editSlot[i] = slot
	}
	slotSplices := map[string][]splice{}
	for i, edit := range edits {
		slot := editSlot[i]
		run, found, resolveErr := (domain.TextSegment{Text: slotText[slot]}).Resolve(edit.Grain, edit.Quote, edit.Occurrence)
		if resolveErr != nil {
			return nil, fmt.Errorf("%w: %s: unknown text grain %q", block.ErrTextMalformed, e.Kind, edit.Grain)
		}
		if !found {
			return nil, fmt.Errorf("%w: %q at occurrence %d", block.ErrTextStale, edit.Quote, edit.Occurrence)
		}
		slotSplices[slot] = append(slotSplices[slot], splice{run.Start, run.End, edit.Replacement})
	}
	finalText := make(map[string]string, len(slotSplices))
	for slot, list := range slotSplices {
		sort.Slice(list, func(i, j int) bool { return list[i].start > list[j].start })
		for i := 1; i < len(list); i++ {
			if list[i].stop > list[i-1].start {
				return nil, fmt.Errorf("%w: %s: two edits name overlapping text", block.ErrTextMalformed, e.Kind)
			}
		}
		text := slotText[slot]
		for _, s := range list {
			text = text[:s.start] + s.replacement + text[s.stop:]
		}
		finalText[slot] = text
	}
	return finalText, nil
}
