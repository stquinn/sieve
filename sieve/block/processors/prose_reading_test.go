package processors

import (
	"errors"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// What prose reads out of markdown. Each case states the whole reading, so a
// derivation that dropped a leaf or kept a marker fails on the string rather
// than on an offset somewhere downstream.
//
// THE WANT COLUMN IS WHAT THE SURFACE DRAWS. A mark is numbered in this reading
// and resolved again in the text the editor has on screen, so a character this
// reads that the surface does not draw — or draws and this does not read —
// numbers the two sides differently and a spend lands somewhere nobody pointed
// at. The surface parses the same markdown with html on, which is what decides
// the two cases that look alike: an autolink's address IS drawn and is read,
// and an inline html tag is interpreted rather than drawn and is not.
func TestProseReading_ReadsTheWordsAndNoneOfTheSyntax(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"plain text reads as itself", "Hello world", "Hello world"},
		{"emphasis markers are gone, the words are not", "a *one* and **two** here", "a one and two here"},
		{"a heading is its text", "# Title", "Title"},
		{"a link contributes its text and never its destination", "see [the docs](http://x.example/teh) now", "see the docs now"},
		{"a code span contributes its content", "run `git teh` now", "run git teh now"},
		{"an image contributes its alt text", "![alt words](i.png) after", "alt words after"},
		{"an autolink's address is drawn, so it reads as itself, brackets excepted", "see <https://x.example/teh> end", "see https://x.example/teh end"},
		{"an inline html tag is interpreted rather than drawn, so only what it wraps reads", "a <b>bold</b> word", "a bold word"},
		{"an angle-form destination is a destination, not the autolink beside it", "[t](<https://a.example>)<https://a.example>", "thttps://a.example"},
		{"…and so is one behind an alt text that reads as nothing", "![](<https://a.example>)<https://a.example>", "https://a.example"},
		{"…and so is one inside a title", `[t](x "<https://a.example>")<https://a.example>`, "thttps://a.example"},
		{"a softbreak reads as one space", "one\ntwo", "one two"},
		{"a hardbreak reads as a newline", "one  \ntwo", "one\ntwo"},
		{"block-level nodes join with a newline", "para one\n\npara two", "para one\npara two"},
		{"a list reads as its items, one per line", "- one\n- two", "one\ntwo"},
		{"a quote reads as what was quoted", "> quoted words", "quoted words"},
		{"a fence bears no inlines and so contributes nothing", "before\n```py\nx=1\n```\nafter", "before\nafter"},
		{"an html block contributes nothing", "<div>markup</div>\n\ntext", "text"},
		{"highlight markers are not markdown and stay", "The ==acute== onset.", "The ==acute== onset."},
		{"an entity is text like any other and reads verbatim", "a &amp; b", "a &amp; b"},
		{"four-space-indented content IS an indented code block, and bears no inlines", "    indented line", ""},
		{"a node contributing nothing leaves no blank line behind", "one\n\n![](i.png)\n\ntwo", "one\ntwo"},
		{"empty content reads as nothing", "", ""},
		{"whitespace-only content reads as nothing", "   \n\n  ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NewProseReading(tc.content).Text(); got != tc.want {
				t.Errorf("reading = %q, want %q", got, tc.want)
			}
		})
	}
}

// anchoredEdit mints an anchor the way the substrate does — read the segment,
// take its locator, name a quote at an occurrence in THAT reading — and hands
// back the edit a client would send with it. readAt is the content the anchor
// was read from, which is the content the locator vouches for. Every spend case
// below goes through it, so nothing in this file writes a locator by hand.
func anchoredEdit(t *testing.T, readAt, quote string, occurrence int, grain, replacement string) domain.TextEdit {
	t.Helper()
	var p ProseProcessor
	blk := p.newProseBlock("pr-1", readAt)
	segment := p.NormalisedText(&blk)[0]
	return domain.TextEdit{
		BlockID: blk.ID, Locator: segment.Locator, Quote: quote, Occurrence: occurrence,
		Grain: grain, Replacement: replacement,
	}
}

// spend applies edits to content and reports what the block now holds.
func spend(content string, edits ...domain.TextEdit) (string, error) {
	var p ProseProcessor
	blk := p.newProseBlock("pr-1", content)
	err := p.UpdateText(&blk, edits)
	return blk.Content(), err
}

// The whole round trip: an anchor named in the reading lands on exactly the
// stored bytes that reading came from. The grain is what decides the
// resolution, so each case states one — and both grains are driven, because
// they genuinely disagree about what an occurrence counts.
//
// The delimiter rows are the reason the range is not simply the leaves it
// touched: a splice that took only those would leave half of a formatting pair
// standing.
func TestProseReading_AnchorsSpendOnTheStoredBytes(t *testing.T) {
	cases := []struct {
		name        string
		content     string
		quote       string
		occurrence  int
		grain       string
		replacement string
		want        string
		wantStale   bool
	}{
		{
			name:    "a word grain replaces the word it named",
			content: "teh cat sat on teh mat",
			quote:   "teh", occurrence: 1, grain: domain.GrainWord, replacement: "the",
			want: "teh cat sat on the mat",
		},
		{
			name:    "a literal grain writes INSIDE a word, which no word grain reaches",
			content: "FIVE",
			quote:   "V", occurrence: 0, grain: domain.GrainLiteral, replacement: "R",
			want: "FIRE",
		},
		{
			name:    "a literal grain writes ACROSS a word boundary",
			content: "get along",
			quote:   "et alon", occurrence: 0, grain: domain.GrainLiteral, replacement: "oin",
			want: "going",
		},
		{
			name:    "a literal occurrence counts matches, not runs",
			content: "the other there",
			quote:   "the", occurrence: 2, grain: domain.GrainLiteral, replacement: "THE",
			want: "the other THEre",
		},
		{
			name:    "the same quote at word grain reaches only the one word run",
			content: "the other there",
			quote:   "the", occurrence: 1, grain: domain.GrainWord, replacement: "THE",
			want:      "the other there",
			wantStale: true,
		},
		{
			name:    "an occurrence the reading does not reach is stale",
			content: "teh cat sat",
			quote:   "teh", occurrence: 1, grain: domain.GrainWord, replacement: "the",
			want:      "teh cat sat",
			wantStale: true,
		},
		{
			name:    "an empty replacement deletes the run",
			content: "teh cat sat on teh mat",
			quote:   "teh", occurrence: 1, grain: domain.GrainWord, replacement: "",
			want: "teh cat sat on  mat",
		},
		{
			// The occurrence is the proof the count is over the reading: over the
			// stored bytes this run would be the SECOND "teh".
			name:    "the reading skips a link's destination, so an anchor past one still lands",
			content: "see [the docs](http://x.example/teh) then teh cat",
			quote:   "teh", occurrence: 0, grain: domain.GrainWord, replacement: "the",
			want: "see [the docs](http://x.example/teh) then the cat",
		},
		{
			// The reading holds the address, so the letters IN it are counted like
			// any others — which is what the reader sees highlighted, because the
			// surface draws the address too. A reading that skipped it numbered this
			// same anchor onto the trailing word instead.
			name:    "an anchor numbered inside a drawn address lands inside it",
			content: "a <https://x.example/a> a",
			quote:   "a", occurrence: 1, grain: domain.GrainLiteral, replacement: "X",
			want: "a <https://x.exXmple/a> a",
		},
		{
			name:    "and the word after the address takes the number the address left it",
			content: "a <https://x.example/a> a",
			quote:   "a", occurrence: 3, grain: domain.GrainLiteral, replacement: "Z",
			want: "a <https://x.example/a> Z",
		},
		{
			// The angle brackets are markers like any pair: they lie between runs, so
			// no cut reaches them and the autolink survives its address being rewritten.
			name:    "replacing a whole address keeps the autolink",
			content: "see <https://x.example> now",
			quote:   "https://x.example", occurrence: 0, grain: domain.GrainLiteral, replacement: "https://y.example",
			want: "see <https://y.example> now",
		},
		{
			// A DESTINATION IS NOT IN THE READING, whichever bytes it is spelled
			// with. An angle-form destination is spelled exactly like the autolink
			// after it, and a write that landed there would rewrite an address the
			// reader was never shown — the one thing this type promises cannot
			// happen.
			name:    "an angle-form destination is never mistaken for the autolink beside it",
			content: "[t](<https://a.example>)<https://a.example>",
			quote:   "https://a.example", occurrence: 0, grain: domain.GrainLiteral, replacement: "y",
			want: "[t](<https://a.example>)<y>",
		},
		{
			name:    "…nor is one behind an alt text that reads as nothing",
			content: "![](<https://a.example>)<https://a.example>",
			quote:   "https://a.example", occurrence: 0, grain: domain.GrainLiteral, replacement: "y",
			want: "![](<https://a.example>)<y>",
		},
		{
			name:    "…nor is one inside a title",
			content: `[t](x "<https://a.example>")<https://a.example>`,
			quote:   "https://a.example", occurrence: 0, grain: domain.GrainLiteral, replacement: "y",
			want: `[t](x "<https://a.example>")<y>`,
		},
		{
			name:    "an autolink emptied from outside loses its brackets",
			content: "see <https://x.example> now",
			quote:   "see https://x.example", occurrence: 0, grain: domain.GrainLiteral, replacement: "gone",
			want: "gone now",
		},
		{
			name:    "an anchor inside a code span writes inside the backticks",
			content: "run `git teh` now",
			quote:   "teh", occurrence: 0, grain: domain.GrainWord, replacement: "the",
			want: "run `git the` now",
		},
		{
			// A softbreak's space stands for the line ending, so a match covering it
			// covers the break: replacing across one joins the lines, exactly as
			// replacing a phrase does in anything that wraps text.
			name:    "an anchor spanning a softbreak merges the lines",
			content: "one\ntwo",
			quote:   "e t", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "onXwo",
		},
		{
			name:    "an anchor that does not reach the softbreak leaves the break alone",
			content: "one\ntwo",
			quote:   "one", occurrence: 0, grain: domain.GrainWord, replacement: "ONE",
			want: "ONE\ntwo",
		},
		{
			// The break's bytes are the whole line ending — the trailing space and
			// the next line's indent are structure the reader never saw either.
			name:    "merging takes the whole line ending, indent and all",
			content: "one \n  two",
			quote:   "e t", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "onXwo",
		},
		{
			// A hard break is deliberate structure, not a space, so its newline is
			// not a byte a match can reach.
			name:    "a hardbreak's newline is never spliced",
			content: "one  \ntwo",
			quote:   "one", occurrence: 0, grain: domain.GrainWord, replacement: "ONE",
			want: "ONE  \ntwo",
		},
		{
			name:    "an anchor reaching across two block-level nodes writes nothing",
			content: "first para\n\nsecond para",
			quote:   "para\nsecond", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want:      "first para\n\nsecond para",
			wantStale: true,
		},
		{
			name:    "a typo inside emphasis keeps the shell",
			content: "The **bolld** text",
			quote:   "olld", occurrence: 0, grain: domain.GrainLiteral, replacement: "old",
			want: "The **bold** text",
		},
		{
			// The whole of a pair's content, replaced: the replacement is inserted
			// where the match began, which is inside the pair, so the pair keeps it.
			name:    "replacing all of an emphasised word keeps the emphasis",
			content: "a **helllo** here",
			quote:   "helllo", occurrence: 0, grain: domain.GrainWord, replacement: "hello",
			want: "a **hello** here",
		},
		{
			// The match crosses the closing markers. Only the READ bytes are cut, so
			// the markers stay where they are and the replacement lands in the pair.
			name:    "a match straddling a pair cuts the words and never the markers",
			content: "**bold** text",
			quote:   "old te", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "**bX**xt",
		},
		{
			name:    "a match over a pair's whole content and past it",
			content: "**bold** text",
			quote:   "bold text", occurrence: 0, grain: domain.GrainLiteral, replacement: "plain",
			want: "**plain**",
		},
		{
			// The match begins OUTSIDE the pair, so the replacement lands outside it
			// and the pair is left with nothing inside — markers and all.
			name:    "a pair emptied by a match that began outside it loses its markers",
			content: "a **b** c",
			quote:   "a b c", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "X",
		},
		{
			name:    "an emptied pair goes even when the replacement is empty",
			content: "keep **b** end",
			quote:   "b", occurrence: 0, grain: domain.GrainLiteral, replacement: "",
			want: "keep  end",
		},
		{
			name:    "nested pairs empty outwards, one carrying the next",
			content: "**a *b* c**",
			quote:   "a b c", occurrence: 0, grain: domain.GrainLiteral, replacement: "",
			want: "",
		},
		{
			name:    "a match inside nested emphasis keeps both shells",
			content: "**a *b* c**",
			quote:   "b", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "**a *X* c**",
		},
		{
			// The link survives and its TEXT is edited: the destination is not in the
			// reading, so no cut can reach it.
			name:    "a match running out of a link's text keeps the link",
			content: "see [the docs](http://x.example) then teh cat",
			quote:   "docs then", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "see [the X](http://x.example) teh cat",
		},
		{
			name:    "replacing a link's whole text keeps the link",
			content: "see [the docs](http://x.example) now",
			quote:   "the docs", occurrence: 0, grain: domain.GrainLiteral, replacement: "them",
			want: "see [them](http://x.example) now",
		},
		{
			name:    "a link emptied from outside loses its brackets and destination",
			content: "see [the docs](http://x.example) now",
			quote:   "see the docs", occurrence: 0, grain: domain.GrainLiteral, replacement: "gone",
			want: "gone now",
		},
		{
			// A destination whose title carries a parenthesis: counting through the
			// title would close the link early and cut the user's own text.
			name:    "a quoted title holding a parenthesis does not fool the marker scan",
			content: `x [t](http://x.example "a (title)") y`,
			quote:   "x t y", occurrence: 0, grain: domain.GrainLiteral, replacement: "Z",
			want: "Z",
		},
		{
			// Raw html at the emphasis's edge puts ORDINARY TEXT where a marker would
			// be. Nothing may claim those bytes, so the pair is simply never trimmed.
			name:    "html at an emphasis edge is never mistaken for a marker",
			content: "*<b>helllo</b>*",
			quote:   "helllo", occurrence: 0, grain: domain.GrainWord, replacement: "hello",
			want: "*<b>hello</b>*",
		},
		{
			name:    "replacing a code span's whole content keeps the backticks",
			content: "run `git teh` now",
			quote:   "git teh", occurrence: 0, grain: domain.GrainLiteral, replacement: "it",
			want: "run `it` now",
		},
		{
			name:    "a code span emptied from outside loses its backticks",
			content: "run `git teh` now",
			quote:   "run git teh", occurrence: 0, grain: domain.GrainLiteral, replacement: "X",
			want: "X now",
		},
		{
			name:    "replacing an image's whole alt text keeps the image",
			content: "![alt words](i.png) after",
			quote:   "alt words", occurrence: 0, grain: domain.GrainLiteral, replacement: "gone",
			want: "![gone](i.png) after",
		},
		{
			name:    "an anchor in a list item writes in that item",
			content: "- one teh\n- two teh",
			quote:   "teh", occurrence: 1, grain: domain.GrainWord, replacement: "the",
			want: "- one teh\n- two the",
		},
		{
			name:    "an anchor in a heading writes past the heading's own markers",
			content: "# teh Title\n\nteh body",
			quote:   "teh", occurrence: 0, grain: domain.GrainWord, replacement: "the",
			want: "# the Title\n\nteh body",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			edit := anchoredEdit(t, tc.content, tc.quote, tc.occurrence, tc.grain, tc.replacement)
			got, err := spend(tc.content, edit)
			if tc.wantStale {
				if !errors.Is(err, block.ErrTextStale) {
					t.Errorf("err = %v, want ErrTextStale", err)
				}
			} else if err != nil {
				t.Errorf("UpdateText: %v", err)
			}
			if got != tc.want {
				t.Errorf("content = %q, want %q", got, tc.want)
			}
		})
	}
}

// THE LOCATOR IS WHAT VOUCHES FOR THE READING. A payload that has changed since
// it was read is a payload whose reading may number things differently, so
// every anchor into it is refused rather than resolved against a reading its
// maker never saw. That is whole-content coarse for prose, which reads its
// content as one piece: an edit anywhere in the block stales the marks
// everywhere in it, and the next read hands the client live ones.
func TestProseReading_AChangedPayloadStalesEveryAnchorIntoIt(t *testing.T) {
	cases := []struct {
		name    string
		readAt  string
		spendAt string
	}{
		{
			name:   "the quote itself was typed over",
			readAt: "teh cat sat", spendAt: "the cat sat",
		},
		{
			name:   "text before the quote changed, though the quote is still there",
			readAt: "teh cat sat", spendAt: "well, teh cat sat",
		},
		{
			// The reading is identical either way — only the markers moved — and
			// the anchor is still refused: the locator vouches for BYTES.
			name:   "a format-only edit elsewhere in the same block",
			readAt: "teh cat is *here*", spendAt: "teh cat is **here**",
		},
		{
			name:   "a paragraph inserted above, which the reading does renumber",
			readAt: "teh cat sat", spendAt: "inserted\n\nteh cat sat",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			edit := anchoredEdit(t, tc.readAt, "teh", 0, domain.GrainWord, "the")
			got, err := spend(tc.spendAt, edit)
			if !errors.Is(err, block.ErrTextStale) {
				t.Errorf("err = %v, want ErrTextStale", err)
			}
			if got != tc.spendAt {
				t.Errorf("content = %q, want it untouched: %q", got, tc.spendAt)
			}
		})
	}
}

// A batch is resolved against ONE reading and spliced back to front, so two
// anchors made at the same moment both land where they were read — the second
// is not displaced by the first.
func TestProseReading_ABatchLandsEveryEditWhereItWasRead(t *testing.T) {
	const content = "teh cat sat on teh mat"
	first := anchoredEdit(t, content, "teh", 0, domain.GrainWord, "the")
	second := anchoredEdit(t, content, "teh", 1, domain.GrainWord, "THE")

	got, err := spend(content, first, second)
	if err != nil {
		t.Fatalf("UpdateText: %v", err)
	}
	if want := "the cat sat on THE mat"; got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
}

// Replacements of different lengths across several block-level nodes, given in
// no particular order: back-to-front is what keeps a longer replacement in the
// first node from moving the range resolved for the last.
func TestProseReading_ABatchAcrossNodesIsOrderIndependent(t *testing.T) {
	const content = "teh first para\n\nteh second para\n\nteh third para"
	edits := []domain.TextEdit{
		anchoredEdit(t, content, "second", 0, domain.GrainWord, "MIDDLE ONE"),
		anchoredEdit(t, content, "first", 0, domain.GrainWord, "1"),
		anchoredEdit(t, content, "third", 0, domain.GrainWord, "LAST"),
	}
	got, err := spend(content, edits...)
	if err != nil {
		t.Fatalf("UpdateText: %v", err)
	}
	if want := "teh 1 para\n\nteh MIDDLE ONE para\n\nteh LAST para"; got != want {
		t.Errorf("content = %q, want %q", got, want)
	}
}

// ALL OR NOTHING. One anchor that does not resolve fails the whole batch, and
// the edits that WOULD have resolved are not written either: a half-applied
// replace-all is a document nobody asked for.
func TestProseReading_AStaleEditFailsTheWholeBatch(t *testing.T) {
	const content = "teh cat sat on teh mat"
	good := anchoredEdit(t, content, "teh", 0, domain.GrainWord, "the")
	stale := anchoredEdit(t, content, "wolrd", 0, domain.GrainWord, "world")

	got, err := spend(content, good, stale)
	if !errors.Is(err, block.ErrTextStale) {
		t.Fatalf("err = %v, want ErrTextStale", err)
	}
	if got != content {
		t.Errorf("content = %q, want it untouched: %q", got, content)
	}
}

// Two edits naming overlapping text is a malformed REQUEST — no reading makes
// it resolvable, and the order they were applied in would decide the answer.
func TestProseReading_OverlappingEditsAreMalformed(t *testing.T) {
	const content = "the other there"
	first := anchoredEdit(t, content, "the other", 0, domain.GrainLiteral, "A")
	second := anchoredEdit(t, content, "other there", 0, domain.GrainLiteral, "B")

	got, err := spend(content, first, second)
	if !errors.Is(err, block.ErrTextMalformed) {
		t.Fatalf("err = %v, want ErrTextMalformed", err)
	}
	if got != content {
		t.Errorf("content = %q, want it untouched: %q", got, content)
	}
}

// What a spend refuses as MALFORMED rather than stale: staleness invites the
// caller to re-read and try again, and none of these ever will resolve.
func TestProseReading_MalformedSpends(t *testing.T) {
	const content = "teh cat sat"
	anchored := anchoredEdit(t, content, "teh", 0, domain.GrainWord, "the")

	cases := []struct {
		name string
		edit domain.TextEdit
	}{
		{
			// What a client of the bare-slot contract used to send. It names no
			// reading, so it can never be honoured — not stale, malformed.
			name: "a locator naming only the slot",
			edit: domain.TextEdit{Locator: ProseContentSlot, Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "no locator at all",
			edit: domain.TextEdit{Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "a locator naming a slot prose does not bear",
			edit: domain.TextEdit{Locator: `{"slot":"source","hash":"abc"}`, Quote: "teh", Grain: domain.GrainWord, Replacement: "the"},
		},
		{
			name: "prose's own locator, but the anchor declares no grain",
			edit: domain.TextEdit{Locator: anchored.Locator, Quote: "teh", Replacement: "the"},
		},
		{
			name: "prose's own locator, but a grain nothing counts in",
			edit: domain.TextEdit{Locator: anchored.Locator, Quote: "teh", Grain: "sentence", Replacement: "the"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := spend(content, tc.edit)
			if !errors.Is(err, block.ErrTextMalformed) {
				t.Errorf("err = %v, want ErrTextMalformed", err)
			}
			if errors.Is(err, block.ErrTextStale) {
				t.Error("a malformed request reported as stale")
			}
			if got != content {
				t.Errorf("content = %q, want it untouched: %q", got, content)
			}
		})
	}
}

// A block with nothing to write to, and a batch with nothing to write.
func TestProseReading_NoBlockIsMalformedAndAnEmptyBatchIsANoOp(t *testing.T) {
	var p ProseProcessor
	if err := p.UpdateText(nil, []domain.TextEdit{{Grain: domain.GrainWord}}); !errors.Is(err, block.ErrTextMalformed) {
		t.Errorf("err = %v, want ErrTextMalformed", err)
	}
	blk := p.newProseBlock("pr-1", "untouched")
	if err := p.UpdateText(&blk, nil); err != nil {
		t.Errorf("an empty batch: %v", err)
	}
	if blk.Content() != "untouched" {
		t.Errorf("content = %q, want it untouched", blk.Content())
	}
}
