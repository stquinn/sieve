package services

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

// One dictionary for the whole file: the parse walks 80,000 lines, and every
// case below reads it without changing it.
var spell = NewSpellService(nil)

// The embedded dictionary actually loaded — a Check that knows nothing would
// pass every "flags the misspelling" case below for the wrong reason.
func TestSpellService_DictionaryLoaded(t *testing.T) {
	if len(spell.words) < 79_000 {
		t.Fatalf("dictionary holds %d words; the embedded list has 80,000", len(spell.words))
	}
	if got := spell.words["the"]; got == 0 {
		t.Error(`"the" carries no frequency — the word/frequency split did not parse`)
	}
	if got := spell.Check("the quick brown fox jumps over the lazy dog"); len(got) != 0 {
		t.Errorf("common English flagged as misspelled: %+v", got)
	}
}

// The dialect variants ship too, so a British or Irish writer's spelling is a
// dictionary word rather than a squiggle.
func TestSpellService_VariantListLoaded(t *testing.T) {
	for _, word := range []string{"realisation", "colour", "behaviour", "organise", "recognise", "centre", "travelled"} {
		if _, ok := spell.words[word]; !ok {
			t.Errorf("%q is not in the dictionary — the variant list did not load", word)
		}
	}
}

// A word the second list repeats keeps the FIRST list's frequency.
func TestSpellService_LoadKeepsTheFirstListsEntry(t *testing.T) {
	s := &SpellService{words: map[string]int64{}}
	s.load("zzword 100\n")
	s.load("zzword 5\nzzother 7\n")
	if got := s.words["zzword"]; got != 100 {
		t.Errorf("zzword = %d, want 100 — the first list wins", got)
	}
	if got := s.words["zzother"]; got != 7 {
		t.Errorf("zzother = %d, want 7 — a word only the second list has is still added", got)
	}
}

// What Check flags and what it lets through. Each case is one rule; the want is
// the exact word list, so a rule that starts flagging extra tokens fails here.
func TestSpellService_Check(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"a dictionary word passes", "hello", nil},
		{"a misspelling is flagged", "helllo", []string{"helllo"}},
		{"case is folded before lookup", "Hello HELLO hello", nil},
		{"a capitalised misspelling is flagged", "Helllo", []string{"Helllo"}},
		{"every occurrence is reported", "teh cat and teh dog", []string{"teh", "teh"}},
		{"tokens with digits are skipped", "sha256 v2 x86 abc123", nil},
		{"single letters are skipped", "a b x + y = z", nil},
		{"ALL-CAPS acronyms are skipped", "HTML CSS JSON QWXZ", nil},
		{"non-Latin script is skipped", "привет κόσμε", nil},
		{"an internal apostrophe is part of the word", "don't isn't", nil},
		{"an apostrophe misspelling is flagged", "dont't", []string{"dont't"}},
		{"surrounding apostrophes are trimmed off", "'hello' 'helllo'", []string{"helllo"}},
		{"a typographic apostrophe reads as one", "don’t", nil},
		{"a possessive is accepted through its stem", "the object's edge and the cat's paw", nil},
		{"a typographic possessive too", "the object’s edge", nil},
		{"a plural possessive is unaffected", "the objects' edges", nil},
		{"a possessive with a misspelled stem is still flagged", "the objct's edge", []string{"objct's"}},
		{"British spellings are accepted", "realisation colour organise behaviour centre travelled", nil},
		{"American spellings are accepted too", "realization color organize behavior center traveled", nil},
		{"a url is an address, not words", "see https://github.com/wolfgarbe/SymSpell now", nil},
		{"a path is an address, not words", "open docs/design/specs/plan.md please", nil},
		{"a bare filename is an address", "read spellzz.txt today", nil},
		{"a domain is an address", "mail zzqx.example.com about it", nil},
		{"a sentence-ending period is not an address", "That is done. Helllo again.", []string{"Helllo"}},
		{"punctuation does not join words", "hello,world. hello;helllo", []string{"helllo"}},
		{"empty text flags nothing", "", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			for _, m := range spell.Check(tc.text) {
				got = append(got, m.Word)
			}
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Errorf("Check(%q) flagged %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

// What Suggest offers, rule by rule. Each case pins one thing: that the right
// correction is REACHED (it is in the list), that it LEADS (frequency ordering
// put it first), that the distance bound holds, or that the answer wears the
// case of the word it corrects.
func TestSpellService_Suggest(t *testing.T) {
	const unchecked = -1
	cases := []struct {
		name      string
		word      string
		max       int
		wantHead   string   // the first offer, when the ordering is the point
		wantAny    []string // offers that must appear somewhere in the list
		wantNone   []string // offers that must not
		wantSuffix string   // every offer ends with this, when the shape of the offer is the point
		wantCount  int      // exact number of offers; unchecked where the count is not the point
	}{
		{name: "a transposition is one edit", word: "teh", max: 5, wantHead: "the", wantCount: unchecked},
		{name: "a doubled letter is one edit", word: "helllo", max: 5, wantHead: "hello", wantCount: unchecked},
		{name: "a transposition mid-word", word: "recieve", max: 5, wantAny: []string{"receive"}, wantCount: unchecked},
		{name: "two edits are reachable in a long word", word: "recomend", max: 5, wantAny: []string{"recommend"}, wantCount: unchecked},
		{name: "a short word allows only one edit", word: "cta", max: 20, wantAny: []string{"cat"}, wantNone: []string{"acts", "cathy"}, wantCount: unchecked},
		{name: "the cap is honoured", word: "helllo", max: 2, wantCount: 2},
		{name: "a max of zero offers nothing", word: "helllo", max: 0, wantCount: 0},
		{name: "gibberish nothing is close to offers nothing", word: "xqzjvwk", max: 5, wantCount: 0},
		{name: "an empty word offers nothing", word: "", max: 5, wantCount: 0},
		{name: "a Title-case misspelling gets Title-case offers", word: "Helllo", max: 5, wantHead: "Hello", wantCount: unchecked},
		{name: "a lowercase misspelling keeps lowercase offers", word: "helllo", max: 5, wantHead: "hello", wantCount: unchecked},
		{name: "a misspelled possessive is corrected in its stem", word: "objct's", max: 5, wantHead: "object's", wantSuffix: "'s", wantCount: unchecked},
		{name: "a typographic possessive keeps the apostrophe it was typed with", word: "objct’s", max: 5, wantHead: "object’s", wantSuffix: "’s", wantCount: unchecked},
		{name: "a Title-case possessive gets Title-case offers", word: "Objct's", max: 5, wantHead: "Object's", wantSuffix: "'s", wantCount: unchecked},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := spell.Suggest(tc.word, tc.max)
			if len(got) > tc.max {
				t.Fatalf("Suggest(%q, %d) returned %d offers: %v", tc.word, tc.max, len(got), got)
			}
			if tc.wantCount != unchecked && len(got) != tc.wantCount {
				t.Errorf("Suggest(%q, %d) = %v, want %d offers", tc.word, tc.max, got, tc.wantCount)
			}
			if tc.wantHead != "" && (len(got) == 0 || got[0] != tc.wantHead) {
				t.Errorf("Suggest(%q) = %v, want %q first", tc.word, got, tc.wantHead)
			}
			for _, want := range tc.wantAny {
				if !slices.Contains(got, want) {
					t.Errorf("Suggest(%q) = %v, want it to offer %q", tc.word, got, want)
				}
			}
			if tc.wantSuffix != "" {
				for _, offer := range got {
					if !strings.HasSuffix(offer, tc.wantSuffix) {
						t.Errorf("Suggest(%q) offered %q, want every offer to end in %q", tc.word, offer, tc.wantSuffix)
					}
				}
			}
			for _, unwanted := range tc.wantNone {
				if slices.Contains(got, unwanted) {
					t.Errorf("Suggest(%q) = %v, must not offer %q — it is beyond the distance bound", tc.word, got, unwanted)
				}
			}
		})
	}
}

// A suggestion is computed while a reader waits for their squiggles, once per
// misspelling in a block. The whole 80,000-word dictionary is walked for each,
// so this pins the walk's cost: it stays a fraction of the debounce that
// scheduled it, and a change that makes it a per-word second fails here rather
// than in a document that goes quiet.
func TestSpellService_SuggestIsFastEnoughToRunPerMisspelling(t *testing.T) {
	const budget = 50 * time.Millisecond
	for _, word := range []string{"helllo", "recomend", "teh", "occurrance", "xqzjvwk"} {
		start := time.Now()
		spell.Suggest(word, 8) // the production count — the menu's inline three plus its flyout
		if elapsed := time.Since(start); elapsed > budget {
			t.Errorf("Suggest(%q) took %s, over the %s budget", word, elapsed, budget)
		}
	}
}

// The offsets a mark is anchored against must cut the flagged word back out of
// the text they came from — including behind multi-byte runes, where a rune
// count would silently drift.
func TestSpellService_OffsetsSliceTheWordBack(t *testing.T) {
	texts := []string{
		"helllo world",
		"a naïve résumé and helllo after multi-byte runes",
		"'helllo' in quotes",
		"line one\nhelllo on line two",
	}
	for _, text := range texts {
		t.Run(text, func(t *testing.T) {
			found := spell.Check(text)
			if len(found) == 0 {
				t.Fatalf("expected at least one misspelling in %q", text)
			}
			for _, m := range found {
				if text[m.Start:m.End] != m.Word {
					t.Errorf("text[%d:%d] = %q, want %q", m.Start, m.End, text[m.Start:m.End], m.Word)
				}
			}
		})
	}
}

// stubUserDictionary is a UserDictionary that keeps the words in memory and
// counts the writes, so a test can assert both what was persisted and that
// persisting happened at all.
type stubUserDictionary struct {
	words  []string
	writes int
	err    error
}

func (s *stubUserDictionary) LoadUserDictionary() []string { return s.words }

func (s *stubUserDictionary) SaveUserDictionary(words []string) error {
	s.writes++
	if s.err != nil {
		return s.err
	}
	s.words = append([]string(nil), words...)
	return nil
}

// The two ways a user puts a word beyond flagging, and the one thing they must
// share: the word is folded to the SAME key Check looks a word up by. A curly
// apostrophe is the case that proves it — a word taught in one apostrophe must
// stop flagging in the other, or a learned word squiggles forever.
func TestSpellService_LearnAndIgnoreAcceptAWord(t *testing.T) {
	cases := []struct {
		name    string
		teach   func(s *SpellService)
		text    string
		flagged []string
	}{
		{
			name:  "an ignored word is no longer flagged",
			teach: func(s *SpellService) { s.Ignore("zzblorp") },
			text:  "a zzblorp here",
		},
		{
			name:  "a learned word is no longer flagged",
			teach: func(s *SpellService) { _ = s.Learn("zzblorp") },
			text:  "a zzblorp here",
		},
		{
			name:  "case is folded, so a capitalised use is accepted too",
			teach: func(s *SpellService) { _ = s.Learn("zzblorp") },
			text:  "Zzblorp and zzblorp",
		},
		{
			name:  "a word taught with a typographic apostrophe accepts the ASCII one",
			teach: func(s *SpellService) { _ = s.Learn("zzblorp’s") },
			text:  "the zzblorp's thing",
		},
		{
			name:  "and the other way round",
			teach: func(s *SpellService) { s.Ignore("zzblorp's") },
			text:  "the zzblorp’s thing",
		},
		{
			name:  "a learned word accepts its possessive",
			teach: func(s *SpellService) { _ = s.Learn("Ruaraidh") },
			text:  "Ruaraidh's note and ruaraidh's other one",
		},
		{
			name:  "including the typographic possessive",
			teach: func(s *SpellService) { _ = s.Learn("Ruaraidh") },
			text:  "Ruaraidh’s note",
		},
		{
			name:  "an ignored word accepts its possessive too",
			teach: func(s *SpellService) { s.Ignore("zzblorp") },
			text:  "the zzblorp's thing",
		},
		{
			name:    "accepting one word does not accept its neighbours",
			teach:   func(s *SpellService) { _ = s.Learn("zzblorp") },
			text:    "a zzblorp and a zzblorpp",
			flagged: []string{"zzblorpp"},
		},
		{
			name:    "an empty word teaches nothing",
			teach:   func(s *SpellService) { _ = s.Learn("   ") },
			text:    "a zzblorp here",
			flagged: []string{"zzblorp"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := NewSpellService(&stubUserDictionary{})
			tc.teach(s)
			var got []string
			for _, m := range s.Check(tc.text) {
				got = append(got, m.Word)
			}
			if strings.Join(got, "|") != strings.Join(tc.flagged, "|") {
				t.Errorf("Check(%q) flagged %v, want %v", tc.text, got, tc.flagged)
			}
		})
	}
}

// Learning survives a restart and ignoring does not: the durable set is written
// through the port and read back at construction, while the session set is
// never written at all.
func TestSpellService_LearnedWordsRoundTripAndIgnoredOnesDoNot(t *testing.T) {
	store := &stubUserDictionary{}
	first := NewSpellService(store)
	if err := first.Learn("Zzblorp"); err != nil {
		t.Fatalf("Learn: %v", err)
	}
	first.Ignore("zzquux")

	if want := []string{"zzblorp"}; !slices.Equal(store.words, want) {
		t.Errorf("persisted %v, want %v — the folded key is what is written", store.words, want)
	}
	if store.writes != 1 {
		t.Errorf("%d writes, want 1 — ignoring must not touch the dictionary", store.writes)
	}

	restarted := NewSpellService(store)
	if got := restarted.Check("a Zzblorp and a zzquux"); len(got) != 1 || got[0].Word != "zzquux" {
		t.Errorf("after a restart Check flagged %+v; the learned word must survive and the ignored one must not", got)
	}
}

// The dictionary file is a set, written in a stable order so the file a user
// may open is diffable rather than reshuffled on every learn.
func TestSpellService_PersistsASortedSet(t *testing.T) {
	store := &stubUserDictionary{}
	s := NewSpellService(store)
	for _, word := range []string{"zzquux", "zzblorp", "zzquux"} {
		if err := s.Learn(word); err != nil {
			t.Fatalf("Learn(%q): %v", word, err)
		}
	}
	if want := []string{"zzblorp", "zzquux"}; !slices.Equal(store.words, want) {
		t.Errorf("persisted %v, want %v", store.words, want)
	}
}

// A store with no persistence behind it (and one that refuses the write) must
// still accept the word for this run: the user asked for it to stop flagging,
// and a failure to write is not a reason to keep flagging it in front of them.
func TestSpellService_LearningHoldsEvenWhenItCannotBeWritten(t *testing.T) {
	for name, s := range map[string]*SpellService{
		"no store":       NewSpellService(nil),
		"refusing store": NewSpellService(&stubUserDictionary{err: errors.New("read-only")}),
	} {
		t.Run(name, func(t *testing.T) {
			_ = s.Learn("zzblorp")
			if got := s.Check("a zzblorp here"); len(got) != 0 {
				t.Errorf("Check flagged %+v, want the word accepted in memory regardless", got)
			}
		})
	}
}
