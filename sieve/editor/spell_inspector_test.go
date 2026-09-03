package editor

import (
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// marksFor is what a drain computes for one block, without the queue: the
// block's own reading through one inspector. It is how a test asks the read lane
// for an anchor instead of writing a locator by hand — a locator is the block
// kind's own, and nothing outside it may spell one.
func marksFor(t *testing.T, es *EditorService, uuid, blockID string, inspector Inspector) []domain.TextMark {
	t.Helper()
	shadow := es.shadowFor(uuid)
	if shadow == nil {
		t.Fatalf("no open document for %q", uuid)
	}
	blk, found := shadow.SnapshotBlock(blockID)
	if !found {
		t.Fatalf("no block %q in %q", blockID, uuid)
	}
	bearer, bears := block.TextBearerFor(blk.Kind)
	if !bears {
		t.Fatalf("kind %q bears no text", blk.Kind)
	}
	marks := inspector.Inspect(bearer.NormalisedText(&blk), nil)
	for i := range marks {
		marks[i].BlockID = blk.ID
	}
	return marks
}

// theMarkOn returns the one spelling mark made for blockID.
func theMarkOn(t *testing.T, es *EditorService, inspector Inspector, uuid, blockID string) domain.TextMark {
	t.Helper()
	marks := marksFor(t, es, uuid, blockID, inspector)
	if len(marks) == 0 {
		t.Fatalf("no mark was made on %s", blockID)
	}
	return marks[0]
}

// A mark's anchor is quote plus occurrence at a declared grain, and its offsets
// cut the quote back out of THE READING THE BLOCK'S KIND HANDED OUT — not out of
// the bytes on disk, which for prose carry syntax nobody wrote to be read.
// Occurrence restarts per segment and counts only identical quotes, so two
// DIFFERENT misspellings both start at 0 — and it is minted over EVERY word run,
// so a run that went unflagged still takes its number.
//
// Every case asserts the ROUND TRIP: domain.TextSegment.Locate — the word-grain
// resolver the squiggle and the write both go through — finds the mark back at
// the run it was minted from, and the mark says word grain, so the resolver a
// consumer picks is the one it was counted at. A mint counted over the
// misspellings alone passes the first case and lands the second on the filename.
//
// reading is what the block's kind reads out of content; empty means the two are
// the same string, which is what plain prose gives.
func TestSpellInspector_ComposesMarksAnchoredByQuoteAndOccurrence(t *testing.T) {
	type anchor struct {
		quote      string
		occurrence int
	}
	cases := []struct {
		name    string
		content string
		reading string
		want    []anchor
	}{
		{
			name:    "identical quotes number in reading order; different ones each start at 0",
			content: "teh cat sat on teh mat with a helllo",
			want:    []anchor{{"teh", 0}, {"teh", 1}, {"helllo", 0}},
		},
		{
			name:    "a run inside an address is never flagged, but it is still counted",
			content: "see recieve.go then recieve here",
			want:    []anchor{{"recieve", 1}},
		},
		{
			// A url is not prose, so prose does not read it out — and a checker that
			// never sees it cannot flag it. The occurrence is the proof the count is
			// over the reading: over the stored bytes this same run would be the
			// SECOND "recieve" and every consumer would resolve it inside the url.
			name:    "a word inside a link's destination is not read, so it is neither flagged nor counted",
			content: "see [the docs](http://x.example/recieve) then recieve here",
			reading: "see the docs then recieve here",
			want:    []anchor{{"recieve", 0}},
		},
		{
			// An autolink's address IS read — a surface draws it — so its words are
			// counted, and it is the DICTIONARY that declines to check them: a field
			// carrying a scheme or a path is an address rather than language. The
			// occurrence is the proof of both halves at once — the flagged word is
			// the SECOND "recieve" the reading holds, and the first squiggles at
			// nobody.
			name:    "an address the reading does hold is counted and still never flagged",
			content: "see <https://x.example/recieve> then recieve here",
			reading: "see https://x.example/recieve then recieve here",
			want:    []anchor{{"recieve", 1}},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRegistry()
			_, inspector, es, uuids := openInspectedDocs(t, testSpell, 0, proseRegion(proseA, tc.content))

			reading := tc.reading
			if reading == "" {
				reading = tc.content
			}
			marks := marksFor(t, es, uuids[0], proseA, inspector)
			if len(marks) != len(tc.want) {
				t.Fatalf("want %d marks, got %d: %+v", len(tc.want), len(marks), marks)
			}
			segment := domain.TextSegment{Text: reading}
			for i, w := range tc.want {
				m := marks[i]
				if m.Quote != w.quote || m.Occurrence != w.occurrence {
					t.Errorf("mark %d = (%q,%d), want (%q,%d)", i, m.Quote, m.Occurrence, w.quote, w.occurrence)
				}
				if m.Class != domain.TextClassProse {
					t.Errorf("mark %d class = %q, want prose", i, m.Class)
				}
				if m.Grain != domain.GrainWord {
					t.Errorf("mark %d grain = %q, want %q — a misspelling is counted among word runs", i, m.Grain, domain.GrainWord)
				}
				// The mark carries the segment's own minted locator, copied unread —
				// it is what the write will be resolved through.
				if m.Locator == "" || m.Locator == "content" {
					t.Errorf("mark %d locator = %q, want the segment's minted locator", i, m.Locator)
				}
				if m.Start < 0 || m.End > len(reading) || reading[m.Start:m.End] != m.Quote {
					t.Fatalf("mark %d offsets [%d:%d] do not cut %q out of the reading %q", i, m.Start, m.End, m.Quote, reading)
				}
				if m.Suggestions == nil {
					t.Errorf("mark %d suggestions is nil; the wire needs an empty list, not null", i)
				}
				run, found := segment.Locate(m.Quote, m.Occurrence)
				if !found || run.Start != m.Start || run.End != m.End {
					t.Errorf("mark %d resolves to %+v (found=%v), want the run it was minted from, [%d:%d]", i, run, found, m.Start, m.End)
				}
			}
		})
	}
}

// sourceTextBearerProcessor is a TextBearer whose segments are NOT prose — a
// stand-in for the source-bearing kinds (code, diagram) that hand out their
// text for a reader to index without being written prose.
type sourceTextBearerProcessor struct {
	testRunJobProcessor
}

func (p *sourceTextBearerProcessor) NormalisedText(blk *block.SieveBlock) []domain.TextSegment {
	source, _ := blk.Attrs["source"].(string)
	return []domain.TextSegment{
		{Locator: "source", Text: source, Class: domain.TextClassCode},
		{Locator: "title", Text: "teh helllo title", Class: domain.TextClassLabel},
	}
}

// PARTICIPATING IS NOT BEING CHECKED. A kind may bear text — and code and
// diagram now do — without a word of it ever squiggling: the class decides, so
// a diagram's script and a code block's identifiers are walked and skipped
// rather than excluded by naming their kinds.
func TestSpellInspector_ChecksProseSegmentsOnly(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(&sourceTextBearerProcessor{
		testRunJobProcessor{FencedDeserializer: block.FencedDeserializer{Kind: "sourcey"}},
	})
	body := proseRegion(proseA, "a helllo here") + "\n\n" +
		"```sourcey\nid: " + probeC + "\nsource: teh recieve wolrd\nstatus: COMPLETE\n```"
	_, inspector, es, uuids := openInspectedDocs(t, testSpell, 0, body)

	if _, bears := block.TextBearerFor("sourcey"); !bears {
		t.Fatal("the stand-in kind does not bear text; the test proves nothing")
	}
	if marks := marksFor(t, es, uuids[0], probeC, inspector); len(marks) != 0 {
		t.Errorf("a non-prose block produced %+v; only prose is checked", marks)
	}
	if marks := marksFor(t, es, uuids[0], proseA, inspector); len(marks) != 1 {
		t.Errorf("the prose block produced %+v, want the one misspelling", marks)
	}
}

// Accepting a word is a workspace-wide change of mind, so it clears that word
// in EVERY open document rather than in the one it was accepted from. Both
// routes are the same act with different durability, so both are driven here.
func TestSpellInspector_AcceptingAWordClearsItInEveryOpenDocument(t *testing.T) {
	cases := []struct {
		name   string
		accept func(inspector *SpellInspector, word string)
	}{
		{name: "Ignore", accept: func(s *SpellInspector, word string) { s.Ignore(word) }},
		{name: "Learn", accept: func(s *SpellInspector, word string) { s.Learn(word) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetRegistry()
			// Its own dictionary: Learn teaches the service it is given, and the
			// package-wide one is shared by every other test here.
			engine, inspector, _, uuids := openInspectedDocs(t, services.NewSpellService(nil), 0,
				proseRegion(proseA, "a zzblorp here"),
				proseRegion(proseB, "another zzblorp there"))
			clock, notifier := staged(engine)

			for _, uuid := range uuids {
				engine.CheckAndPush(uuid)
			}
			if ran := clock.fire(); ran != len(uuids) {
				t.Fatalf("seed: fire ran %d drains, want one per document (%d)", ran, len(uuids))
			}
			for i, uuid := range uuids {
				pushes := notifier.forDocument(uuid)
				if len(pushes) != 1 || len(pushes[0].marks) != 1 || pushes[0].marks[0].Quote != "zzblorp" {
					t.Fatalf("document %d was pushed %+v, want one zzblorp mark", i, pushes)
				}
			}

			tc.accept(inspector, "zzblorp")
			if ran := clock.fire(); ran != len(uuids) {
				t.Fatalf("accept: fire ran %d drains, want one per open document (%d)", ran, len(uuids))
			}
			for i, uuid := range uuids {
				pushes := notifier.forDocument(uuid)
				if len(pushes) != 2 {
					t.Fatalf("document %d heard %d pushes, want 2 (flag, then clear)", i, len(pushes))
				}
				if len(pushes[1].marks) != 0 {
					t.Errorf("document %d clear push = %+v, want an EMPTY set", i, pushes[1].marks)
				}
			}
		})
	}
}
