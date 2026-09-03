package editor

import (
	"reflect"
	"strconv"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
)

// What find says about a reading: one mark per match, at literal grain, quoting
// the bytes the reading actually holds.
//
// Every case asserts the ROUND TRIP as the spell suite does, but through
// LocateLiteral — the resolver a literal-grain anchor is resolved by on both
// sides. A mint that numbered its findings among themselves passes the "what
// was found" assertion and lands a folded-case mark on an earlier spelling.
//
// The segments are written here rather than read out of a block because what is
// under test is the READING → MARKS step alone: which classes take part, how
// case is folded, and how a match is numbered. Which reading a kind hands out is
// the kind's own suite's business.
func TestFindInspector_MarksEveryMatchAtLiteralGrain(t *testing.T) {
	find := NewFindInspector(nil)

	cases := []struct {
		name       string
		segments   []domain.TextSegment
		parameters map[string]any
		want       []string // "quote@occurrence in class" per mark, in reading order
	}{
		{
			name:       "a term nothing holds finds nothing",
			segments:   []domain.TextSegment{{Text: "the cat sat", Class: domain.TextClassProse}},
			parameters: map[string]any{"term": "dog"},
			want:       []string{},
		},
		{
			name:       "an empty term finds nothing, which is the clear a freshly opened dialog draws",
			segments:   []domain.TextSegment{{Text: "the cat sat", Class: domain.TextClassProse}},
			parameters: map[string]any{"term": ""},
			want:       []string{},
		},
		{
			name:       "absent parameters find nothing rather than everything",
			segments:   []domain.TextSegment{{Text: "the cat sat", Class: domain.TextClassProse}},
			parameters: nil,
			want:       []string{},
		},
		{
			name:       "identical quotes are numbered in reading order",
			segments:   []domain.TextSegment{{Text: "the other there", Class: domain.TextClassProse}},
			parameters: map[string]any{"term": "the"},
			want:       []string{"the@0 in prose", "the@1 in prose", "the@2 in prose"},
		},
		{
			name:       "a match lands mid-word and crosses word boundaries — find is not word-aligned",
			segments:   []domain.TextSegment{{Text: "get along", Class: domain.TextClassProse}},
			parameters: map[string]any{"term": "et alon"},
			want:       []string{"et alon@0 in prose"},
		},
		{
			name:       "case is folded by default, and each mark quotes the bytes it covers",
			segments:   []domain.TextSegment{{Text: "The the THE", Class: domain.TextClassProse}},
			parameters: map[string]any{"term": "the"},
			want:       []string{"The@0 in prose", "the@0 in prose", "THE@0 in prose"},
		},
		{
			name:       "caseSensitive true matches one spelling only",
			segments:   []domain.TextSegment{{Text: "The the THE", Class: domain.TextClassProse}},
			parameters: map[string]any{"term": "the", "caseSensitive": true},
			want:       []string{"the@0 in prose"},
		},
		{
			name: "EVERY class takes part: a reader searching a document means all of it",
			segments: []domain.TextSegment{
				{Text: "a log line", Class: domain.TextClassCode},
				{Text: "log.txt", Class: domain.TextClassLabel},
				{Text: "the log", Class: domain.TextClassProse},
				{Text: "logged", Class: domain.TextClassCaption},
				{Text: "log", Class: domain.TextClassKey},
			},
			parameters: map[string]any{"term": "log"},
			want: []string{
				"log@0 in code", "log@0 in label", "log@0 in prose",
				"log@0 in caption", "log@0 in key",
			},
		},
		{
			name:       "occurrence restarts per segment, because a segment is what an anchor resolves in",
			segments:   []domain.TextSegment{{Text: "log log", Class: domain.TextClassProse}, {Text: "log", Class: domain.TextClassCode}},
			parameters: map[string]any{"term": "log"},
			want:       []string{"log@0 in prose", "log@1 in prose", "log@0 in code"},
		},
		{
			// A CAPTURED LOG BLOCK, not a hand-written segment: LogProcessor bears
			// text (TestLogProcessor_NormalisedText, log_processor_test.go) but is
			// deliberately not a TextUpdater (TestLogProcessor_IsNotATextUpdater) —
			// find must still surface a match inside it, because reading and writing
			// are separate participation predicates and a record worth finding is
			// still worth finding even though it can never be rewritten.
			name: "find surfaces a match inside a real log block's captured output",
			segments: processors.NewLogProcessor(block.BlockServices{}).NormalisedText(
				&block.SieveBlock{Kind: "log", Attrs: map[string]interface{}{"source": "2026-09-02 ERROR connection refused"}},
			),
			parameters: map[string]any{"term": "refused"},
			want:       []string{"refused@0 in code"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			marks := find.Inspect(tc.segments, tc.parameters)

			got := []string{}
			for _, m := range marks {
				got = append(got, m.Quote+"@"+strconv.Itoa(m.Occurrence)+" in "+m.Class)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("marks\n got: %v\nwant: %v", got, tc.want)
			}

			bySegment := map[string]domain.TextSegment{}
			for _, s := range tc.segments {
				bySegment[s.Class] = s
			}
			for _, m := range marks {
				if m.Grain != domain.GrainLiteral {
					t.Errorf("mark %q declares grain %q, want %q", m.Quote, m.Grain, domain.GrainLiteral)
				}
				if m.Suggestions == nil || len(m.Suggestions) != 0 {
					t.Errorf("mark %q carries suggestions %v; find offers none, and null is not an array", m.Quote, m.Suggestions)
				}
				segment := bySegment[m.Class]
				run, resolved := segment.LocateLiteral(m.Quote, m.Occurrence)
				if !resolved || run.Start != m.Start || run.End != m.End {
					t.Errorf("%q at occurrence %d resolved to %+v (found=%v), want [%d:%d]", m.Quote, m.Occurrence, run, resolved, m.Start, m.End)
				}
			}
		})
	}
}

// A locator is the minting kind's own opaque payload: find copies it onto every
// mark it makes from that segment and spells none of its own.
func TestFindInspector_CopiesTheSegmentLocatorVerbatim(t *testing.T) {
	find := NewFindInspector(nil)
	segments := []domain.TextSegment{
		{Locator: "prose-locator", Text: "log log", Class: domain.TextClassProse},
		{Locator: "code-locator", Text: "log", Class: domain.TextClassCode},
	}

	got := []string{}
	for _, m := range find.Inspect(segments, map[string]any{"term": "log"}) {
		got = append(got, m.Locator)
	}
	want := []string{"prose-locator", "prose-locator", "code-locator"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("locators\n got: %v\nwant: %v", got, want)
	}
}
