package domain

import (
	"strings"
	"unicode"
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

// TextSegment is a PROJECTION of text out of a block's payload, produced by the
// processor that owns that payload. It is not storage: a segment is minted on
// demand and discarded, and writing to one changes nothing.
//
// Text is the segment's bytes exactly as the block stores them. That identity is
// the invariant the whole text substrate rests on — every offset and every quote
// a consumer derives is meaningful only against the stored bytes, so a processor
// must never normalise, trim or re-render on the way out.
//
// Locator is an opaque handle the processor mints to name WHICH part of its
// payload the segment came from, and only that processor interprets it. A caller
// carries a locator back (to write, to re-read) without ever parsing it: no
// consumer may infer a payload shape, an attr name or a nesting from its
// spelling.
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
// This tokenisation is what an OCCURRENCE counts over, everywhere. Counting
// substrings instead would number "the" inside "there" and put every later
// occurrence one place out, so a mark minted by one reader and resolved by
// another only agrees while both count word runs.
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
// whether the segment holds that many. It is the anchor resolution the whole
// mark contract rests on: a caller finds the quote WHERE IT NOW SITS, so an
// edit earlier in the text displaces the run without invalidating the anchor,
// while a quote that has been typed over is simply absent.
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
// It names its target the way a mark does: Quote plus Occurrence, resolved in
// the located segment's CURRENT text. Start and End are the offsets the
// requester last saw and are hints only — a processor that trusted them would
// write over whatever had since moved into that range.
type TextEdit struct {
	BlockID     string
	Locator     string
	Quote       string
	Occurrence  int
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
// segment's text at the moment the mark was made, and they are HINTS: any edit
// before the mark displaces them, so a consumer resolves the quote at its
// occurrence and treats a matching range as a fast path rather than a truth.
type TextMark struct {
	BlockID     string
	Locator     string
	Quote       string
	Occurrence  int
	Start       int
	End         int
	Class       string
	Suggestions []string
}
