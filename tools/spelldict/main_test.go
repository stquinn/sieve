package main

import (
	"slices"
	"strings"
	"testing"
)

// Which forms on a varcon line the generator will ship, rule by rule. The
// fixtures are literal varcon lines rather than reads of the vendored file, so
// a case says what the rule is instead of what the 2020.12.07 data happens to
// hold.
func TestGenerator_QualifyingForms(t *testing.T) {
	cases := []struct {
		name string
		line string
		want []string
	}{
		{"a comment is not data", "# acknowledgment <verified> (level 35)", nil},
		{"a blank line is not data", "   ", nil},
		{
			name: "preferred spellings on both sides",
			line: "A Cv: acknowledgment / Av B C: acknowledgement",
			want: []string{"acknowledgment", "acknowledgement"},
		},
		{
			name: "the ise/ize pair",
			line: "A Z: abnormalize / B: abnormalise",
			want: []string{"abnormalize", "abnormalise"},
		},
		{
			name: "an equal-variant indicator qualifies",
			line: "A B C: coloration / B. Cv: colouration",
			want: []string{"coloration", "colouration"},
		},
		{
			name: "a seldom-used variant still qualifies",
			line: "A Cv DV: color / B C D: colour",
			want: []string{"color", "colour"},
		},
		{
			name: "an improper variant is dropped",
			line: "A: definitely / Ax: definately",
			want: []string{"definitely"},
		},
		{
			name: "a should-not-use variant is dropped",
			line: "A: judgment / B-: judgement",
			want: []string{"judgment"},
		},
		{
			name: "the other category carries no dialect and is dropped",
			line: "_: yak / _V: yaks",
			want: nil,
		},
		{
			name: "a column number beside the tags is not a category",
			line: "A 1: sake / Av B Cv 1: saki",
			want: []string{"sake", "saki"},
		},
		{
			name: "a usage note is stripped before the entries are read",
			line: "A C: prize / B: prise | otherwise",
			want: []string{"prize", "prise"},
		},
		{
			name: "case is folded",
			line: "A: Anglicize / B: Anglicise",
			want: []string{"anglicize", "anglicise"},
		},
		{
			name: "a possessive form is a word run and is kept",
			line: "A Cv DV: color's / B C D: colour's",
			want: []string{"color's", "colour's"},
		},
		{
			name: "a hyphenated form can never match a word run",
			line: "A: co-operate / B: co-óperate",
			want: nil,
		},
		{
			name: "and neither can a multi-word one",
			line: "A: fire fighter / B: firefighter",
			want: []string{"firefighter"},
		},
	}
	g := &Generator{}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := g.qualifyingForms(tc.line); !slices.Equal(got, tc.want) {
				t.Errorf("qualifyingForms(%q) = %v, want %v", tc.line, got, tc.want)
			}
		})
	}
}

// What reaches the generated list, given a base frequency list. A variant is
// shipped only where the base list already knows the word in some spelling, and
// it inherits that word's frequency so the two spellings rank alike.
func TestGenerator_Variants(t *testing.T) {
	base := map[string]int64{"color": 500, "colors": 400, "organize": 300, "judgment": 200}
	varcon := strings.Join([]string{
		"# color <verified> (level 35)",
		"A Cv DV: color / B C D: colour",
		"A Cv DV: colors / B C D: colours",
		"A Z: organize / B: organise",
		"A Z: unheardofize / B: unheardofise",
		"A: judgment / B-: judgement",
		"A Z: organize / B: organise",
	}, "\n")

	got := (&Generator{}).variants(varcon, base)
	want := map[string]int64{"colour": 500, "colours": 400, "organise": 300}
	if len(got) != len(want) {
		t.Fatalf("variants = %v, want %v", got, want)
	}
	for word, freq := range want {
		if got[word] != freq {
			t.Errorf("variants[%q] = %d, want %d", word, got[word], freq)
		}
	}
}

// A form both lists hold is never re-emitted: the generated file is what the
// frequency list is MISSING, and a duplicate would only ever lose at load.
func TestGenerator_VariantsSkipsFormsTheBaseListAlreadyHas(t *testing.T) {
	base := map[string]int64{"color": 500, "colour": 9}
	if got := (&Generator{}).variants("A Cv DV: color / B C D: colour", base); len(got) != 0 {
		t.Errorf("variants = %v, want nothing — both spellings are already in the base list", got)
	}
}

// The same variant reached from two lines keeps the higher frequency: the
// commonest use of a spelling is the one that should rank it.
func TestGenerator_VariantsKeepsTheHighestFrequency(t *testing.T) {
	base := map[string]int64{"color": 500, "recolor": 12}
	varcon := "A: recolor / B: colour\nA Cv DV: color / B C D: colour"
	if got := (&Generator{}).variants(varcon, base)["colour"]; got != 500 {
		t.Errorf("variants[colour] = %d, want 500", got)
	}
}

// The artifact is deterministic: alphabetical, one `word<space>frequency` per
// line, trailing newline — so a regeneration that changes nothing diffs as
// nothing.
func TestGenerator_Render(t *testing.T) {
	got := (&Generator{}).render(map[string]int64{"colour": 500, "analyse": 12, "organise": 300})
	want := "analyse 12\ncolour 500\norganise 300\n"
	if got != want {
		t.Errorf("render = %q, want %q", got, want)
	}
}

// The base list parses the same `word<space>frequency` lines the service loads,
// and a line it cannot read costs one word rather than the file.
func TestGenerator_Frequencies(t *testing.T) {
	got := (&Generator{}).frequencies("the 100\nColor 50\n\nbroken\nalso bad\n")
	want := map[string]int64{"the": 100, "color": 50}
	if len(got) != len(want) {
		t.Fatalf("frequencies = %v, want %v", got, want)
	}
	for word, freq := range want {
		if got[word] != freq {
			t.Errorf("frequencies[%q] = %d, want %d", word, got[word], freq)
		}
	}
}
