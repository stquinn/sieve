package domain

import (
	"reflect"
	"strconv"
	"testing"
)

// The two grains an anchor can be counted in, resolved side by side over the
// same text. They genuinely disagree, which is the whole reason the grain is
// declared: a quote inside a longer word is no word run at all, a phrase across
// a space is no word run either, and identical word runs are counted less often
// than identical substrings. Every case states BOTH answers, so a resolver that
// quietly stood in for the other one fails here.
//
// An offset of -1 is "this grain does not resolve it".
func TestTextSegment_TheTwoGrainsCountDifferentThings(t *testing.T) {
	cases := []struct {
		name       string
		text       string
		quote      string
		occurrence int
		wordAt     int
		literalAt  int
	}{
		{
			name: "a whole word both grains agree on",
			text: "teh cat sat", quote: "teh", occurrence: 0,
			wordAt: 0, literalAt: 0,
		},
		{
			name: "`the` in `the other there` is ONE word run and THREE literal matches: the first",
			text: "the other there", quote: "the", occurrence: 0,
			wordAt: 0, literalAt: 0,
		},
		{
			name: "…the second, inside `other`, which is no word run",
			text: "the other there", quote: "the", occurrence: 1,
			wordAt: -1, literalAt: 5,
		},
		{
			name: "…the third, inside `there`",
			text: "the other there", quote: "the", occurrence: 2,
			wordAt: -1, literalAt: 10,
		},
		{
			name: "an occurrence past the last match resolves in neither grain",
			text: "the other there", quote: "the", occurrence: 3,
			wordAt: -1, literalAt: -1,
		},
		{
			name: "literal matches do not overlap: `aa` in `aaaa` is the one at 0…",
			text: "aaaa", quote: "aa", occurrence: 0,
			wordAt: -1, literalAt: 0,
		},
		{
			name: "…and the one at 2, the overlapping match at 1 having been skipped",
			text: "aaaa", quote: "aa", occurrence: 1,
			wordAt: -1, literalAt: 2,
		},
		{
			name: "…and there is no third",
			text: "aaaa", quote: "aa", occurrence: 2,
			wordAt: -1, literalAt: -1,
		},
		{
			name: "a single letter inside a word is literal only",
			text: "FIVE", quote: "V", occurrence: 0,
			wordAt: -1, literalAt: 2,
		},
		{
			// An address a reading holds is text like any other, and both grains
			// count through it: the word after it takes the number the address's own
			// letters left it. A reading that skipped the address would answer this
			// question with the trailing word, and the client — which draws the
			// address — would answer it with the address.
			name: "an address is counted through, not over",
			text: "a https://x.example/a a", quote: "a", occurrence: 1,
			wordAt: 20, literalAt: 14,
		},
		{
			name: "a run crossing a word boundary is literal only",
			text: "get along", quote: "et alon", occurrence: 0,
			wordAt: -1, literalAt: 1,
		},
		{
			// Offsets are BYTES in Go and UTF-16 units in the client, so the one
			// thing that must agree is the ORDINAL: which match a given occurrence
			// names. These rows and their twins in frontend/test/spell-marks.test.js
			// are the same text asked the same question on both sides.
			name: "a multi-byte letter is a literal match like any other",
			text: "café au café", quote: "é", occurrence: 1,
			wordAt: -1, literalAt: 12,
		},
		{
			name: "a word run containing a multi-byte letter is still one run",
			text: "café au café", quote: "café", occurrence: 1,
			wordAt: 9, literalAt: 9,
		},
		{
			name: "a quote containing a non-BMP character counts as one match",
			text: "a 🎉 b 🎉 c", quote: "🎉", occurrence: 1,
			wordAt: -1, literalAt: 9,
		},
		{
			name: "a quote spanning a non-BMP character resolves at its own offsets",
			text: "say 🎉 now", quote: "y 🎉 n", occurrence: 0,
			wordAt: -1, literalAt: 2,
		},
		{
			name: "an empty quote names nothing in either grain",
			text: "the cat", quote: "", occurrence: 0,
			wordAt: -1, literalAt: -1,
		},
		{
			name: "a negative occurrence names nothing in either grain",
			text: "the cat", quote: "the", occurrence: -1,
			wordAt: -1, literalAt: -1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			segment := TextSegment{Text: tc.text}
			assertRun := func(grain string, run WordRun, found bool, want int) {
				t.Helper()
				if want < 0 {
					if found {
						t.Errorf("%s grain resolved %+v, want no resolution", grain, run)
					}
					return
				}
				if !found {
					t.Fatalf("%s grain did not resolve %q at occurrence %d, want offset %d", grain, tc.quote, tc.occurrence, want)
				}
				if run.Start != want || run.End != want+len(tc.quote) {
					t.Errorf("%s grain resolved [%d:%d], want [%d:%d]", grain, run.Start, run.End, want, want+len(tc.quote))
				}
				if run.Word != tc.quote || tc.text[run.Start:run.End] != tc.quote {
					t.Errorf("%s grain named %q at [%d:%d], which cuts %q out of the text", grain, run.Word, run.Start, run.End, tc.text[run.Start:run.End])
				}
			}

			word, foundWord := segment.Locate(tc.quote, tc.occurrence)
			assertRun(GrainWord, word, foundWord, tc.wordAt)
			literal, foundLiteral := segment.LocateLiteral(tc.quote, tc.occurrence)
			assertRun(GrainLiteral, literal, foundLiteral, tc.literalAt)
		})
	}
}

// The MINT side of the literal grain, checked against the resolver it mints
// for: every match LiteralMatches finds is numbered by LiteralOccurrences, and
// every numbered match must resolve back to the very offsets it was minted at.
// A mint that numbered its matches among themselves passes the first assertion
// and fails the second, which is the whole point of asserting both.
func TestTextSegment_LiteralMatchesMintWhatLocateLiteralResolves(t *testing.T) {
	cases := []struct {
		name          string
		text          string
		term          string
		caseSensitive bool
		want          []string // "quote@start" per match, in reading order
	}{
		{
			name: "a case-sensitive search matches its own spelling only",
			text: "The the THE", term: "the", caseSensitive: true,
			want: []string{"the@4"},
		},
		{
			name: "folded case matches every spelling, and each mark quotes the bytes it covers",
			text: "The the THE", term: "the",
			want: []string{"The@0", "the@4", "THE@8"},
		},
		{
			name: "matches never overlap, folded or not",
			text: "aAaA", term: "aa",
			want: []string{"aA@0", "aA@2"},
		},
		{
			name: "a match crosses word boundaries and lands mid-word",
			text: "get along", term: "et alon",
			want: []string{"et alon@1"},
		},
		{
			name: "identical quotes are numbered so the later one is still reachable",
			text: "the other there", term: "the",
			want: []string{"the@0", "the@5", "the@10"},
		},
		{
			// The quote "aa" occurs at 1 as well, where the folded scan never
			// looked: numbering the found matches among themselves would call the
			// one at 4 occurrence 0, and the resolver would answer 1.
			name: "a quote is numbered among ALL its occurrences, not the found ones",
			text: "Aaa aa", term: "aa",
			want: []string{"Aa@0", "aa@4"},
		},
		{
			name: "a multi-byte letter matches folded and keeps its own byte width",
			text: "CAFÉ café", term: "café",
			want: []string{"CAFÉ@0", "café@6"},
		},
		{
			name: "an empty term matches nothing",
			text: "the cat", term: "",
			want: nil,
		},
		{
			name: "a term the reading does not hold matches nothing",
			text: "the cat", term: "dog",
			want: nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			segment := TextSegment{Text: tc.text}
			matches := segment.LiteralMatches(tc.term, tc.caseSensitive)

			got := []string{}
			for _, m := range matches {
				got = append(got, m.Word+"@"+strconv.Itoa(m.Start))
			}
			want := tc.want
			if want == nil {
				want = []string{}
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("matches\n got: %v\nwant: %v", got, want)
			}

			for _, m := range matches {
				if tc.text[m.Start:m.End] != m.Word {
					t.Errorf("match %+v does not cut its own quote out of the text", m)
				}
				occurrence, numbered := segment.LiteralOccurrences(m.Word)[m.Start]
				if !numbered {
					t.Fatalf("match %+v was never numbered, so nothing could anchor on it", m)
				}
				run, resolved := segment.LocateLiteral(m.Word, occurrence)
				if !resolved || run.Start != m.Start {
					t.Errorf("%q at occurrence %d resolved to %+v (found=%v), want start %d", m.Word, occurrence, run, resolved, m.Start)
				}
			}
		})
	}
}

// Resolve is the ONE dispatch point every TextUpdater — prose, code, diagram
// — goes through instead of switching on grain itself. It must agree with
// Locate/LocateLiteral exactly (same found, same run) and must classify a
// grain neither of them answers to as an ERROR rather than a not-found, since
// no amount of re-reading the text would make an unknown grain resolve.
func TestTextSegment_ResolveDispatchesOnGrain(t *testing.T) {
	const text = "the other there"

	t.Run("GrainWord defers to Locate", func(t *testing.T) {
		segment := TextSegment{Text: text}
		want, wantFound := segment.Locate("the", 1)
		got, gotFound, err := segment.Resolve(GrainWord, "the", 1)
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if gotFound != wantFound || got != want {
			t.Errorf("Resolve(GrainWord) = %+v, %v; want %+v, %v", got, gotFound, want, wantFound)
		}
	})

	t.Run("GrainLiteral defers to LocateLiteral", func(t *testing.T) {
		segment := TextSegment{Text: text}
		want, wantFound := segment.LocateLiteral("the", 1)
		got, gotFound, err := segment.Resolve(GrainLiteral, "the", 1)
		if err != nil {
			t.Fatalf("Resolve: %v", err)
		}
		if gotFound != wantFound || got != want {
			t.Errorf("Resolve(GrainLiteral) = %+v, %v; want %+v, %v", got, gotFound, want, wantFound)
		}
	})

	for _, grain := range []string{"", "sentence"} {
		t.Run("grain "+grain+" is an error, not a not-found", func(t *testing.T) {
			segment := TextSegment{Text: text}
			run, found, err := segment.Resolve(grain, "the", 0)
			if err == nil {
				t.Fatal("Resolve: want an error for an unknown grain")
			}
			if found || run != (WordRun{}) {
				t.Errorf("Resolve returned %+v, found=%v alongside its error, want the zero value", run, found)
			}
		})
	}
}
