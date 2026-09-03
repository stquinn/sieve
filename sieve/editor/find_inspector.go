package editor

import (
	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// The parameters find is enabled with. The term and the case flag are STATE —
// they say what the feature is looking for, and every drain reads them again.
// The replacement and the replace-all flag are an IMPERATIVE: they say what to
// do once, now, and are consumed the moment they arrive.
const (
	findTerm          = "term"
	findCaseSensitive = "caseSensitive"
	findReplacement   = "replacement"
	findReplaceAll    = "replaceAll"
)

// FindInspector is the find producer: literal matching over every class of text
// an open document bears, and the one imperative — replace every current match
// — that its parameters can carry.
//
// It is a document-scoped feature. A term belongs to the dialog that is asking,
// so it lives on that document's channel and dies with it, and one reader
// searching is not every reader searching.
type FindInspector struct {
	documents *EditorService
}

// NewFindInspector binds find to the service that owns the open documents.
// Reading a document is what an inspector is handed segments for; the service
// comes in because replace-all is not an inspection — it walks the whole open
// document itself and writes to it.
func NewFindInspector(documents *EditorService) *FindInspector {
	return &FindInspector{documents: documents}
}

// Feature implements Inspector.
func (f *FindInspector) Feature() string { return domain.FeatureFind }

// Inspect implements Inspector: one mark per match, at literal grain.
//
// EVERY CLASS PARTICIPATES. A reader searching a document means the whole
// document — a filename, a log line, a diagram's script — so unlike spelling
// there is no class this skips.
//
// Matching folds case unless the parameters ask it not to. The fold is entirely
// this producer's: a mark's quote is always the literal text the reading holds,
// so the write lane resolves what a reader can see and never learns that a
// search was case-blind.
//
// An absent or empty term finds nothing, which is a mark set of none — the
// ordinary clear, so a dialog opened with nothing typed in it draws nothing.
func (f *FindInspector) Inspect(segments []domain.TextSegment, parameters map[string]any) []domain.TextMark {
	term, caseSensitive := f.query(parameters)
	marks := []domain.TextMark{}
	if term == "" {
		return marks
	}
	for _, segment := range segments {
		marks = append(marks, f.marksIn(segment, term, caseSensitive)...)
	}
	return marks
}

// Control implements FeatureController: find's parameters can carry an
// imperative, and this is where it is obeyed and then consumed.
//
// replaceAll replaces every match the document holds RIGHT NOW. Nothing is
// spent and no mark is consulted: the search and the writes read one live
// shadow inside one frame's handling, so there is no window in which a match
// could go stale. The ordinary op observer re-queues each rewritten block, so
// the refreshed marks arrive by themselves.
//
// What is returned is the search alone. BOTH halves of the imperative are
// stripped, whether or not this frame carried the flag: a replacement is what to
// write when told to write, and remembering one would leave the feature holding
// an instruction nobody has given. Stripping is also what makes a second Replace
// All act a second time rather than read as a restatement of what is already
// true.
func (f *FindInspector) Control(uuid string, enabled bool, parameters map[string]any) map[string]any {
	if !enabled {
		return parameters
	}
	if f.flag(parameters, findReplaceAll) {
		f.replaceAll(uuid, parameters)
	}
	return f.searchOnly(parameters)
}

// marksIn is one segment's matches as marks. Each match is numbered among ALL
// the reading's occurrences of the text it matched, which is what the resolver
// on the far side counts — a match numbered among the search's own findings
// would anchor a folded-case hit on an earlier spelling of it.
//
// A match the reading cannot number is dropped rather than anchored on a guess:
// an unresolvable anchor is a squiggle over text nobody found and a write to
// bytes nobody pointed at.
func (f *FindInspector) marksIn(segment domain.TextSegment, term string, caseSensitive bool) []domain.TextMark {
	var marks []domain.TextMark
	numbering := map[string]map[int]int{}
	for _, match := range segment.LiteralMatches(term, caseSensitive) {
		counted, known := numbering[match.Word]
		if !known {
			counted = segment.LiteralOccurrences(match.Word)
			numbering[match.Word] = counted
		}
		occurrence, numbered := counted[match.Start]
		if !numbered {
			continue
		}
		marks = append(marks, domain.TextMark{
			Locator:    segment.Locator,
			Quote:      match.Word,
			Occurrence: occurrence,
			Grain:      domain.GrainLiteral,
			Start:      match.Start,
			End:        match.End,
			Class:      segment.Class,
			// Find offers no alternatives: the reader has already said what
			// belongs there. The empty list travels because the frame promises an
			// array, and null is not one.
			Suggestions: []string{},
		})
	}
	return marks
}

// replaceAll rewrites every current match in every block of uuid that accepts
// text edits, one batch per block.
//
// ONE BATCH PER BLOCK, never a loop of single edits: the first write moves the
// text every later anchor was read against, so a loop would stale itself after
// its first success. One batch is also one merge, one echo and one undo step,
// which is what makes a block's worth of replacing a single thing to undo.
//
// WRITE PARTICIPATION IS THE PROCESSOR'S ANSWER. A kind that bears text but
// accepts no edits — a captured log, which came from somewhere and would be
// falsified by editing — is searched and highlighted and silently skipped here.
// Whether it is skipped is never this feature's decision.
func (f *FindInspector) replaceAll(uuid string, parameters map[string]any) {
	term, caseSensitive := f.query(parameters)
	if term == "" {
		return
	}
	shadow := f.documents.shadowFor(uuid)
	if shadow == nil {
		return
	}
	replacement, _ := parameters[findReplacement].(string)
	for _, blk := range shadow.SnapshotBlocks() {
		if _, writable := block.TextUpdaterFor(blk.Kind); !writable {
			continue
		}
		edits := f.editsFor(blk, term, caseSensitive, replacement)
		if len(edits) == 0 {
			continue
		}
		if err := f.documents.ReplaceTextBatch(uuid, blk.ID, edits); err != nil {
			logger.Warn("find: replace-all left a block untouched", "uuid", uuid, "block", blk.ID, "err", err)
		}
	}
}

// editsFor is one block's matches as edits — the same marks Inspect mints, each
// asking for the same replacement. Minting them all from ONE reading is what
// stops a replacement that contains the term from cascading: the matches are
// the ones that were there before any of them was written.
func (f *FindInspector) editsFor(blk block.SieveBlock, term string, caseSensitive bool, replacement string) []domain.TextEdit {
	segments, bearsText := f.documents.readingOf(blk)
	if !bearsText {
		return nil
	}
	var edits []domain.TextEdit
	for _, segment := range segments {
		for _, mark := range f.marksIn(segment, term, caseSensitive) {
			edits = append(edits, domain.TextEdit{
				BlockID:     blk.ID,
				Locator:     mark.Locator,
				Quote:       mark.Quote,
				Occurrence:  mark.Occurrence,
				Grain:       mark.Grain,
				Start:       mark.Start,
				End:         mark.End,
				Replacement: replacement,
			})
		}
	}
	return edits
}

// query reads the search out of the parameters: what to look for, and whether
// case matters. Case-insensitive is the default, so a reader who has said
// nothing about case is searching for the word rather than for a spelling of it.
func (f *FindInspector) query(parameters map[string]any) (term string, caseSensitive bool) {
	term, _ = parameters[findTerm].(string)
	return term, f.flag(parameters, findCaseSensitive)
}

// flag reads a boolean parameter, absent reading as false. A value of any other
// type is not a flag that was set, so it reads as false too.
func (f *FindInspector) flag(parameters map[string]any, name string) bool {
	set, _ := parameters[name].(bool)
	return set
}

// searchOnly is the parameters with the imperative taken out — what the engine
// remembers after a replace-all has been obeyed.
func (f *FindInspector) searchOnly(parameters map[string]any) map[string]any {
	kept := make(map[string]any, len(parameters))
	for name, value := range parameters {
		if name == findReplacement || name == findReplaceAll {
			continue
		}
		kept[name] = value
	}
	return kept
}
