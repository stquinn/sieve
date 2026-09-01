package services

import (
	_ "embed"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"sieve/sieve/domain"
)

// embeddedWordList is the shipped English dictionary — `word<space>frequency`,
// one entry per line. See spelldata/en-80k-LICENSE.txt for its provenance.
//
//go:embed spelldata/en-80k.txt
var embeddedWordList string

// Misspelling is one word Check did not recognise, located in the text it was
// found in. Start and End are BYTE offsets into that text, half-open, so
// text[Start:End] is exactly Word.
type Misspelling struct {
	Word  string
	Start int
	End   int
}

// UserDictionary is where the words a user taught the checker survive a
// restart. It is a port so the dictionary is persisted by whatever owns
// application state without this service knowing what a store is —
// StateService implements it structurally, the way PlantumlService's settings
// source mirrors block.StatePort.
type UserDictionary interface {
	LoadUserDictionary() []string
	SaveUserDictionary(words []string) error
}

// SpellService answers "is this a word this user writes" — the shipped
// 80,000-entry frequency dictionary, plus the two sets the user grows: words
// LEARNED (durable, persisted through the UserDictionary port) and words
// IGNORED (this run only). One question, one answerer, one folding of a word to
// the form it is looked up by: a learned word and a dictionary word are
// indistinguishable to Check, which is what stops a taught word squiggling on
// the strength of the apostrophe it was typed with.
//
// It is deliberately a SERVICE and not a block concern — nothing here knows what
// a block is. It takes a string and returns positions in that string; deciding
// which text is worth checking belongs to whoever owns the text.
//
// Check is safe to call concurrently with Learn and Ignore: the shipped
// dictionary is immutable after load, and the two user sets are guarded.
type SpellService struct {
	// words maps a lowercase word to its corpus frequency. The frequency is
	// unused by Check and carried for ranking, which is what makes a suggestion
	// list orderable.
	words map[string]int64

	store UserDictionary

	mu      sync.RWMutex
	learned map[string]struct{}
	ignored map[string]struct{}

	// saveMu serialises the read-modify-WRITE that persisting the learned set
	// is. Without it two concurrent Learns can each snapshot the set and write
	// in the other order, and the file ends up holding the earlier snapshot —
	// one of the two words silently unlearned at the next restart. It is a
	// second lock rather than a longer hold of mu because Check reads mu, and a
	// reader must never wait on a disk write.
	saveMu sync.Mutex
}

// NewSpellService loads the embedded dictionary and the user's own words from
// store, which may be nil (nothing persists; learning lasts the run). Construct
// it once — the parse walks 80,000 lines — and share the value.
func NewSpellService(store UserDictionary) *SpellService {
	s := &SpellService{
		words:   make(map[string]int64, 80_000),
		store:   store,
		learned: map[string]struct{}{},
		ignored: map[string]struct{}{},
	}
	s.load(embeddedWordList)
	if store != nil {
		for _, word := range store.LoadUserDictionary() {
			s.learned[s.lookupKey(word)] = struct{}{}
		}
	}
	return s
}

// Learn adds a word to the durable user dictionary and persists the whole set.
// A word already known is still written: the file is the set, and rewriting it
// is cheaper than reasoning about whether it changed.
func (s *SpellService) Learn(word string) error {
	key := s.lookupKey(strings.TrimSpace(word))
	if key == "" {
		return nil
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()

	s.mu.Lock()
	s.learned[key] = struct{}{}
	words := make([]string, 0, len(s.learned))
	for w := range s.learned {
		words = append(words, w)
	}
	s.mu.Unlock()

	if s.store == nil {
		return nil
	}
	sort.Strings(words) // the file is a set; a stable order keeps it diffable
	return s.store.SaveUserDictionary(words)
}

// Ignore stops flagging a word for the rest of this run. Nothing is written:
// ignoring is the answer to "not now", where learning is the answer to "not
// ever".
func (s *SpellService) Ignore(word string) {
	key := s.lookupKey(strings.TrimSpace(word))
	if key == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ignored[key] = struct{}{}
}

// accepted reports whether the user has put this key beyond flagging, by
// either route.
func (s *SpellService) accepted(key string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.learned[key]; ok {
		return true
	}
	_, ok := s.ignored[key]
	return ok
}

// load parses `word<space>frequency` lines into the dictionary, lowercasing
// every word so a lookup only ever needs the lowercase form. A line that is
// blank, unsplittable or carries an unparseable frequency is skipped rather than
// failing the load: a corrupt entry costs one word, not the whole dictionary.
func (s *SpellService) load(list string) {
	for _, line := range strings.Split(list, "\n") {
		word, freq, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || word == "" {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSpace(freq), 10, 64)
		if err != nil {
			continue
		}
		s.words[strings.ToLower(word)] = n
	}
}

// Check returns every word in text that is worth checking and that neither the
// dictionary nor the user's own two sets accept, in the order they appear. The word runs come from
// domain.TextSegment, which is also what a mark's occurrence is counted over
// and what resolves that occurrence again on the write side — one tokenisation,
// so a flagged word is the same word to everything that later acts on it.
func (s *SpellService) Check(text string) []Misspelling {
	addresses := s.addressSpans(text)
	var out []Misspelling
	for _, run := range (domain.TextSegment{Text: text}).Words() {
		if !s.checkable(run.Word) || s.spanned(addresses, run.Start) {
			continue
		}
		key := s.lookupKey(run.Word)
		if _, known := s.words[key]; known || s.accepted(key) {
			continue
		}
		out = append(out, Misspelling{Word: run.Word, Start: run.Start, End: run.End})
	}
	return out
}

// shortWordLength is where the edit-distance bound tightens. Below it, two
// edits can reach so much of the dictionary that the offers stop being about
// the word the user typed — "cta" is within two of half the three-letter words
// there are.
const shortWordLength = 5

// Suggest returns replacements for a misspelled word, best first and at most
// max of them. A candidate qualifies on edit distance — at most two edits, or
// one for a word shorter than shortWordLength, where an edit is an insertion, a
// deletion, a substitution or a transposition of adjacent characters.
//
// NEARNESS OUTRANKS COMMONNESS. A closer word is always offered first, and
// frequency orders the words that are equally close: "helllo" is one edit from
// "hello" and two from the far commoner "hell", and a writer who doubled a
// letter is not offered a different word first.
//
// The answer follows the CASE of the word it corrects: a Title-case
// misspelling gets Title-case offers, because a suggestion is inserted where
// the word stood and a sentence must still start with a capital.
func (s *SpellService) Suggest(word string, max int) []string {
	scan := newSuggestScan(s.lookupKey(word))
	if max <= 0 || len(scan.key) == 0 {
		return nil
	}
	type candidate struct {
		word     string
		freq     int64
		distance int
	}
	var found []candidate
	for w, freq := range s.words {
		distance, near := scan.within(w)
		if !near {
			continue
		}
		found = append(found, candidate{word: w, freq: freq, distance: distance})
	}
	// The word itself breaks a remaining tie — map iteration order is random, so
	// without a third key the same misspelling would offer the same words in a
	// different order each time.
	sort.Slice(found, func(i, j int) bool {
		if found[i].distance != found[j].distance {
			return found[i].distance < found[j].distance
		}
		if found[i].freq != found[j].freq {
			return found[i].freq > found[j].freq
		}
		return found[i].word < found[j].word
	})
	if len(found) > max {
		found = found[:max]
	}
	out := make([]string, 0, len(found))
	for _, c := range found {
		out = append(out, s.restoreCase(word, c.word))
	}
	return out
}

// restoreCase gives suggestion the shape of the word it replaces. Only
// Title-case is carried: a lowercase word takes lowercase offers, and an
// ALL-CAPS one never reaches here (checkable reads it as an acronym).
func (s *SpellService) restoreCase(original, suggestion string) string {
	runes := []rune(original)
	if len(runes) == 0 || suggestion == "" || !unicode.IsUpper(runes[0]) {
		return suggestion
	}
	for _, r := range runes[1:] {
		if unicode.IsUpper(r) {
			return suggestion
		}
	}
	out := []rune(suggestion)
	out[0] = unicode.ToUpper(out[0])
	return string(out)
}

// suggestScan is one Suggest call's working state: the word being corrected,
// the distance it allows, and the three dynamic-programming rows the distance
// walk rolls through — two back, because a transposition reads the row before
// last. The rows are allocated ONCE and reused for every
// candidate — the walk runs 80,000 times per call, so a per-candidate
// allocation is the whole cost of the answer.
type suggestScan struct {
	key   []rune
	bound int
	prev2 []int
	prev  []int
	cur   []int
	buf   []rune
}

func newSuggestScan(word string) *suggestScan {
	key := []rune(word)
	bound := 2
	if len(key) < shortWordLength {
		bound = 1
	}
	width := len(key) + 1
	return &suggestScan{
		key:   key,
		bound: bound,
		prev2: make([]int, width),
		prev:  make([]int, width),
		cur:   make([]int, width),
		buf:   make([]rune, 0, 32),
	}
}

// within returns how many edits separate candidate from the scanned word, and
// whether that is within the allowed number. It is the optimal string alignment
// distance — Levenshtein plus adjacent transposition — computed row by row and
// ABANDONED the moment every cell of a row exceeds the bound, since no later
// row can come back down.
func (sc *suggestScan) within(candidate string) (int, bool) {
	sc.buf = sc.buf[:0]
	for _, r := range candidate {
		sc.buf = append(sc.buf, r)
	}
	a, b := sc.buf, sc.key
	if len(a)-len(b) > sc.bound || len(b)-len(a) > sc.bound {
		return 0, false
	}
	for j := range sc.prev {
		sc.prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		sc.cur[0] = i
		rowMin := i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			best := sc.prev[j] + 1
			if v := sc.cur[j-1] + 1; v < best {
				best = v
			}
			if v := sc.prev[j-1] + cost; v < best {
				best = v
			}
			if i > 1 && j > 1 && a[i-1] == b[j-2] && a[i-2] == b[j-1] {
				if v := sc.prev2[j-2] + 1; v < best {
					best = v
				}
			}
			sc.cur[j] = best
			if best < rowMin {
				rowMin = best
			}
		}
		if rowMin > sc.bound {
			return 0, false
		}
		sc.prev2, sc.prev, sc.cur = sc.prev, sc.cur, sc.prev2
	}
	return sc.prev[len(b)], sc.prev[len(b)] <= sc.bound
}

// lookupKey folds a word to the form the dictionary is keyed by: lowercase, and
// with a typographic apostrophe read as the ASCII one the word list spells
// "don't" with. The learned and ignored sets are keyed by it TOO — a word
// taught as "Ruaraidh’s" has to stop flagging the "Ruaraidh's" typed next to
// it, and only one fold makes that so.
//
// Only the LOOKUP is folded — a mark's quote keeps the original bytes, because
// that is what it has to be found by again.
func (s *SpellService) lookupKey(word string) string {
	return strings.ToLower(strings.ReplaceAll(word, "’", "'"))
}

// addressSpans returns the byte ranges of the whitespace-delimited fields that
// are addresses rather than language — URLs, paths, filenames, domains.
//
// The unit of judgement is the WHOLE field, because the pieces are indefensible
// on their own: splitting https://github.com/wolfgarbe leaves "https",
// "github" and "wolfgarbe" as ordinary-looking tokens, and flagging those is the
// single loudest source of false squiggles. A field is an address if it carries
// a `/` or a `:`, or a `.` with a word character on both sides — the shapes a
// path, a scheme and a domain-or-filename take.
func (s *SpellService) addressSpans(text string) [][2]int {
	var spans [][2]int
	start := -1
	record := func(end int) {
		if s.isAddress(text[start:end]) {
			spans = append(spans, [2]int{start, end})
		}
		start = -1
	}
	for i, r := range text {
		switch {
		case unicode.IsSpace(r) && start >= 0:
			record(i)
		case !unicode.IsSpace(r) && start < 0:
			start = i
		}
	}
	if start >= 0 {
		record(len(text))
	}
	return spans
}

func (s *SpellService) isAddress(field string) bool {
	if strings.ContainsAny(field, "/:") {
		return true
	}
	runes := []rune(field)
	for i := 1; i < len(runes)-1; i++ {
		if runes[i] == '.' && s.isWordRune(runes[i-1]) && s.isWordRune(runes[i+1]) {
			return true
		}
	}
	return false
}

// spanned reports whether the byte offset falls inside any of the spans.
func (s *SpellService) spanned(spans [][2]int, offset int) bool {
	for _, span := range spans {
		if offset >= span[0] && offset < span[1] {
			return true
		}
	}
	return false
}

// isWordRune answers the ADDRESS rule's question — is this a character a
// filename or a domain puts either side of a dot — and only that. Word runs are
// tokenised by domain.TextSegment, which counts apostrophes in; a dot with an
// apostrophe beside it names nothing.
func (s *SpellService) isWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r)
}

// checkable reports whether word is worth looking up at all. It is a filter
// against FALSE POSITIVES, so every clause excludes a token that is not English
// prose rather than one that is merely unusual:
//
//   - a token containing a digit is an identifier, a version or a hash;
//   - a single letter is a bullet, an initial or a variable;
//   - a token with no lowercase ASCII letter is either an ALL-CAPS acronym or a
//     word in a script this dictionary does not cover — neither is checkable
//     against an English word list, and one clause excludes both.
func (s *SpellService) checkable(word string) bool {
	letters, lowerASCII := 0, false
	for _, r := range word {
		if unicode.IsDigit(r) {
			return false
		}
		if unicode.IsLetter(r) {
			letters++
		}
		if r >= 'a' && r <= 'z' {
			lowerASCII = true
		}
	}
	return letters > 1 && lowerASCII
}
