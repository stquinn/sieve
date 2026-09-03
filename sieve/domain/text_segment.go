package domain

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Text classes name what KIND of language a segment holds, so a consumer can
// decide whether its analysis applies at all: a spell checker reads prose and
// nothing else, while a future index reads all of them. The class travels with
// the segment and onto every mark derived from it.
const (
	TextClassProse   = "prose"   // sentences a human wrote to be read
	TextClassCode    = "code"    // source, a diagram's script, a query
	TextClassLabel   = "label"   // a title, a filename, a short name
	TextClassCaption = "caption" // descriptive text attached to something else
	TextClassKey     = "key"     // an identifier or a map key
)

// Text grains name how a quote's occurrence is counted, and so which resolver
// answers for an anchor: GrainWord counts among identical WORD RUNS (Locate),
// GrainLiteral among non-overlapping left-to-right LITERAL matches
// (LocateLiteral). The two genuinely disagree — "the" in "the other there" is
// one word-grain occurrence and three literal-grain ones — so a grain is
// declared where an anchor is minted and travels with it. There is no default:
// an empty grain is a malformed anchor, not a fallback.
const (
	GrainWord    = "word"
	GrainLiteral = "literal"
)

// Text features name the producers that read the substrate — one word per
// registered inspector. A feature word is DATA: it selects which producer a
// control frame is about, and it rides the marks a producer pushed so a consumer
// can draw each producer's findings its own way. It never reaches the write
// lane, which resolves an anchor without learning who made it.
const (
	FeatureSpellCheck = "spell-check"
	FeatureFind       = "find"
)

// TextSegment is a PROJECTION of text out of a block's payload, produced by the
// processor that owns that payload. It is not storage: a segment is minted on
// demand and discarded, and writing to one changes nothing.
//
// Text is THE KIND'S OWN READING of that part of its payload: whatever the
// processor considers its text for the purpose of searching it, checking it and
// anchoring into it. Every offset, quote, occurrence and grain a consumer
// derives is meaningful against THAT READING and against nothing else — not the
// stored bytes, unless the kind reads them as themselves, and not whatever a
// surface happens to draw. A kind that reads its payload one way today and
// another way tomorrow invalidates every anchor made in between, so a reading
// is a contract a processor keeps, not a convenience it re-chooses.
//
// Locator is an ARBITRARY PER-KIND PAYLOAD, minted by the processor and read
// back by nobody else. It is SELF-SUFFICIENT: it names whatever that processor
// needs in order to reach the stored bytes this segment was read from, and it
// vouches for those bytes being the ones the reading came from. The substrate
// promises only the pairing — a span carrying its kind's locator either
// recovers its bytes at the write, or the kind reports that the text moved on.
// A caller carries a locator back without ever parsing it: no consumer may
// infer a payload shape, an attr name or a nesting from its spelling.
type TextSegment struct {
	Locator string
	Text    string
	Class   string
}

// WordRun is one run of word characters inside a segment's text, with the byte
// offsets it occupies. Word is the run itself, so text[Start:End] == Word.
type WordRun struct {
	Word  string
	Start int
	End   int
}

// Words returns the segment's word runs in reading order. A run is letters,
// digits and apostrophes, with the apostrophes at its edges trimmed off; a run
// of nothing but apostrophes contributes none.
//
// This tokenisation is what a WORD-GRAIN occurrence counts over. Counting
// substrings instead would number "the" inside "there" and put every later
// occurrence one place out, so a word-grain mark minted by one reader and
// resolved by another only agrees while both count word runs.
func (s TextSegment) Words() []WordRun {
	var out []WordRun
	start := -1
	flush := func(end int) {
		if run, ok := s.wordRun(start, end); ok {
			out = append(out, run)
		}
		start = -1
	}
	for i, r := range s.Text {
		switch {
		case s.isWordRune(r) && start < 0:
			start = i
		case !s.isWordRune(r) && start >= 0:
			flush(i)
		}
	}
	if start >= 0 {
		flush(len(s.Text))
	}
	return out
}

// Occurrences numbers the segment's word runs the way an anchor is resolved:
// the result maps a run's Start offset to that run's index among identical
// words. It is the MINT side of what Locate resolves, so a reader that has
// found a run by offset can name it in the terms the resolver counts in.
//
// It is the whole tokenisation or nothing. Numbering only the runs a reader
// cares about counts them among themselves, and every anchor past the first
// then names an earlier run of the same word — one a reader never meant.
func (s TextSegment) Occurrences() map[int]int {
	runs := s.Words()
	out := make(map[int]int, len(runs))
	seen := map[string]int{}
	for _, run := range runs {
		out[run.Start] = seen[run.Word]
		seen[run.Word]++
	}
	return out
}

// Locate returns occurrence N of quote among the segment's word runs, and
// whether the segment holds that many. It is the GrainWord resolver: a caller
// finds the quote WHERE IT NOW SITS, so an edit earlier in the text displaces
// the run without invalidating the anchor, while a quote that has been typed
// over is simply absent. A quote that is not a whole word run does not resolve
// here at all, whatever the text contains.
func (s TextSegment) Locate(quote string, occurrence int) (WordRun, bool) {
	if quote == "" || occurrence < 0 {
		return WordRun{}, false
	}
	seen := 0
	for _, run := range s.Words() {
		if run.Word != quote {
			continue
		}
		if seen == occurrence {
			return run, true
		}
		seen++
	}
	return WordRun{}, false
}

// Resolve is the ONE place a grain is dispatched to its resolver, so every
// TextUpdater — prose's parsed reading, code's and diagram's identity ones —
// counts an occurrence exactly the way it was declared at mint time: GrainWord
// to Locate, GrainLiteral to LocateLiteral. found reports whether the segment
// currently holds that occurrence, exactly as the resolver it deferred to
// would; err is non-nil only when grain is neither, which no edit to the text
// could ever change.
//
// domain/ sits below block/, which is where ErrTextStale and ErrTextMalformed
// live, so Resolve cannot return them itself. Its two-outcome shape carries
// the same classification anyway: a caller treats err != nil as malformed and
// !found (err == nil) as stale, wrapping whichever sentinel applies.
func (s TextSegment) Resolve(grain, quote string, occurrence int) (WordRun, bool, error) {
	switch grain {
	case GrainWord:
		run, found := s.Locate(quote, occurrence)
		return run, found, nil
	case GrainLiteral:
		run, found := s.LocateLiteral(quote, occurrence)
		return run, found, nil
	default:
		return WordRun{}, false, fmt.Errorf("text: unknown grain %q", grain)
	}
}

// LocateLiteral returns occurrence N of quote among the NON-OVERLAPPING,
// left-to-right literal matches of quote in the segment's text, and whether the
// segment holds that many. It is the GrainLiteral resolver, and it counts what
// strings.Index finds: a match at i is followed by resuming the scan at
// i+len(quote), so "aa" occurs twice in "aaaa" and not three times. The
// returned run's Word is the quote and its offsets are the match's own, so it
// reads as its word-grain twin does.
func (s TextSegment) LocateLiteral(quote string, occurrence int) (WordRun, bool) {
	if quote == "" || occurrence < 0 {
		return WordRun{}, false
	}
	for at, seen := 0, 0; ; seen++ {
		found := strings.Index(s.Text[at:], quote)
		if found < 0 {
			return WordRun{}, false
		}
		start := at + found
		if seen == occurrence {
			return WordRun{Word: quote, Start: start, End: start + len(quote)}, true
		}
		at = start + len(quote)
	}
}

// LiteralMatches returns the runs of term in the segment's reading, scanned
// left to right and never overlapping — the MINT side of what LocateLiteral
// resolves. Each run carries the text actually matched, which under
// caseSensitive == false is not term: a mark's quote is the literal text it
// covers, so a reader that folded case still names bytes the reading holds.
//
// Folding compares rune for rune against the reading as it stands, so a match's
// offsets are into that reading and not into a lowered copy of it, whose runes
// need not occupy the same bytes.
func (s TextSegment) LiteralMatches(term string, caseSensitive bool) []WordRun {
	if term == "" {
		return nil
	}
	var out []WordRun
	for at := 0; at < len(s.Text); {
		matched := s.matchAt(at, term, caseSensitive)
		if matched <= 0 {
			_, size := utf8.DecodeRuneInString(s.Text[at:])
			at += size
			continue
		}
		out = append(out, WordRun{Word: s.Text[at : at+matched], Start: at, End: at + matched})
		at += matched
	}
	return out
}

// LiteralOccurrences numbers quote's literal matches the way an anchor at
// GrainLiteral is resolved: the result maps a match's Start offset to its index
// among the segment's non-overlapping, left-to-right matches of that quote. It
// is to LocateLiteral what Occurrences is to Locate, so a reader that has found
// a run can name it in the terms the resolver counts in.
//
// It counts the quote's OWN matches, never the matches a search happened to
// make: a case-folded search yields quotes whose earlier occurrences it never
// looked at, and numbering those among themselves would anchor each one on a
// run the reader never meant.
func (s TextSegment) LiteralOccurrences(quote string) map[int]int {
	out := map[int]int{}
	if quote == "" {
		return out
	}
	for at, seen := 0, 0; ; seen++ {
		found := strings.Index(s.Text[at:], quote)
		if found < 0 {
			return out
		}
		start := at + found
		out[start] = seen
		at = start + len(quote)
	}
}

// matchAt returns the byte length of term's match starting at offset at, or -1
// when the reading does not hold one there. Under caseSensitive == false a rune
// matches its case-folded twin, whose byte width may differ from the term's, so
// the length is measured and never assumed to be len(term).
func (s TextSegment) matchAt(at int, term string, caseSensitive bool) int {
	i := at
	for _, want := range term {
		if i >= len(s.Text) {
			return -1
		}
		got, size := utf8.DecodeRuneInString(s.Text[i:])
		if got != want && (caseSensitive || unicode.ToLower(got) != unicode.ToLower(want)) {
			return -1
		}
		i += size
	}
	return i - at
}

// wordRun builds the run text[start:end] with its edge apostrophes trimmed off,
// reporting false when nothing but apostrophes is left.
func (s TextSegment) wordRun(start, end int) (WordRun, bool) {
	run := s.Text[start:end]
	lead := len(run) - len(strings.TrimLeftFunc(run, s.isApostrophe))
	trimmed := strings.TrimRightFunc(run[lead:], s.isApostrophe)
	if trimmed == "" {
		return WordRun{}, false
	}
	return WordRun{Word: trimmed, Start: start + lead, End: start + lead + len(trimmed)}, true
}

func (s TextSegment) isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || s.isApostrophe(r)
}

func (s TextSegment) isApostrophe(r rune) bool { return r == '\'' || r == '’' }

// TextEdit is a request to replace one anchored run of a block's text with
// something else — the write half of the substrate the marks are the read half
// of.
//
// It names its target the way a mark does: Quote plus Occurrence at a declared
// Grain, resolved in the located segment's CURRENT reading. Start and End are
// offsets into the reading as the requester last saw it, and hints only — a
// processor that trusted them would write over whatever had since moved into
// that range.
type TextEdit struct {
	BlockID    string
	Locator    string
	Quote      string
	Occurrence int
	// Grain declares how Occurrence is counted: GrainWord among identical word
	// runs, GrainLiteral among non-overlapping literal matches. It is declared by
	// whoever minted the anchor and never inferred here — an empty grain is a
	// malformed request, and resolving one on a guess would write to a run the
	// requester never named.
	Grain       string
	Start       int
	End         int
	Replacement string
}

// TextMark is one flagged run inside a segment — a misspelling, and later
// anything else that points at a stretch of a block's text.
//
// It anchors by Quote plus Occurrence, NOT by offsets. Occurrence is the index
// among identical quotes within the same segment, 0-based, so ("teh", 1) names
// the second "teh" in that segment. Start and End are byte offsets into the
// segment's READING at the moment the mark was made, and they are HINTS: any
// edit before the mark displaces them, so a consumer resolves the quote at its
// occurrence and treats a matching range as a fast path rather than a truth.
type TextMark struct {
	BlockID    string
	Locator    string
	Quote      string
	Occurrence int
	// Grain declares how Occurrence is counted: GrainWord among identical word
	// runs, GrainLiteral among non-overlapping literal matches. Every consumer
	// that resolves this mark — the client that draws it, the processor that
	// writes through it — must count in the grain it was minted at, and a mark
	// carrying none resolves nowhere.
	Grain       string
	Start       int
	End         int
	Class       string
	Suggestions []string
}
