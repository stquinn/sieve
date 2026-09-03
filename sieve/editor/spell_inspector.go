package editor

import (
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// spellSuggestionCount is how many replacements a mark offers. The menu shows
// the first few inline and hangs the rest in a flyout, so the number is what a
// reader might still scan once they have looked past the obvious answer — not
// everything within two edits.
const spellSuggestionCount = 8

// SpellInspector is the spelling producer: the dictionary lookup, the
// suggestions a mark offers, and the two verbs by which a reader accepts a word.
//
// It is a workspace-scoped feature — one answer for the whole app, persisted in
// settings — and the engine owns everything about WHEN it runs. What is left
// here is what only spelling can say.
type SpellInspector struct {
	spell  *services.SpellService
	engine *InspectionEngine
}

// NewSpellInspector binds the dictionary to the engine that will run it. The
// engine comes in because Ignore and Learn change an answer the engine has
// already pushed, and re-seeding is how a changed answer reaches every document
// that was told the old one.
func NewSpellInspector(spell *services.SpellService, engine *InspectionEngine) *SpellInspector {
	return &SpellInspector{spell: spell, engine: engine}
}

// Feature implements Inspector.
func (s *SpellInspector) Feature() string { return domain.FeatureSpellCheck }

// Inspect implements Inspector: one mark per misspelling, anchored the way the
// segment counts.
//
// Only prose-class segments are checked — a dictionary lookup over code or a key
// is noise — but every class is walked, so a kind that grows a prose segment
// joins in without a change here. Spelling takes no parameters: it is on or off.
func (s *SpellInspector) Inspect(segments []domain.TextSegment, _ map[string]any) []domain.TextMark {
	marks := []domain.TextMark{}
	for _, segment := range segments {
		if segment.Class != domain.TextClassProse {
			continue
		}
		// Occurrence is minted over ALL of the segment's word runs, never over
		// the misspelled ones alone: it is resolved by counting every run, so a
		// tally that skipped the words nothing flagged would anchor each mark on
		// an earlier run of the same word.
		occurrence := segment.Occurrences()
		for _, miss := range s.spell.Check(segment.Text) {
			// A word nothing is close to still travels as an empty list: the
			// frame promises an array, and null is not one.
			suggestions := s.spell.Suggest(miss.Word, spellSuggestionCount)
			if suggestions == nil {
				suggestions = []string{}
			}
			marks = append(marks, domain.TextMark{
				Locator: segment.Locator,
				Quote:   miss.Word,
				// The tally above counts word runs, so the grain this declares is
				// the one the occurrence was actually counted at.
				Occurrence:  occurrence[miss.Start],
				Grain:       domain.GrainWord,
				Start:       miss.Start,
				End:         miss.End,
				Class:       segment.Class,
				Suggestions: suggestions,
			})
		}
	}
	return marks
}

// Ignore stops flagging word for the rest of this run; Learn adds it to the
// user's durable dictionary. Both re-check every open document, because the
// answer they change is not local to the block the word was accepted in: the
// same word squiggling in three documents must stop squiggling in all three.
//
// They are feature-owned verbs and not lifecycle: a judgement about one word is
// not the feature being switched on or off, so neither rides the control frame.
func (s *SpellInspector) Ignore(word string) {
	s.spell.Ignore(word)
	s.engine.RecheckAll()
}

// Learn adds word to the user's durable dictionary and re-checks. A dictionary
// that could not be written is logged and the word still holds for this run:
// the user asked for the word to be accepted, and failing to persist that is
// not a reason to keep flagging it in front of them.
func (s *SpellInspector) Learn(word string) {
	if err := s.spell.Learn(word); err != nil {
		logger.Error("spell: could not persist the user dictionary", "err", err)
	}
	s.engine.RecheckAll()
}
