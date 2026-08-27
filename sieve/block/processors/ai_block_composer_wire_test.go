package processors

import (
	"encoding/json"
	"os"
	"testing"

	"sieve/sieve/block"
)

// THE COMPOSER'S WIRE SHAPE, held to the fold that reads it.
//
// The composer and the fold live either side of a socket, in two suites sharing
// no runtime, so what binds them is a FILE both read. Each case in it carries a
// `gesture` — the composer verbs about / ask / attach — and the `attrs` that
// gesture is required to produce: a create-block op's attrs bag as it arrives
// off the wire.
//
//   - HERE: each case's `attrs` goes through the create path and is folded, and
//     the slots it reaches are asserted.
//   - frontend/test/question-list.test.js: each case's `gesture` is replayed
//     through QuestionList and its output asserted equal to that same
//     `attrs.question`.
//
// WHAT THAT GUARANTEES. Neither side can restate the shape alone. A composer
// that mints something else fails the JS suite even if its own unit assertions
// were rewritten to agree with it, because those assertions are not what it is
// measured against — the file is. Restating the file is the deliberate act that
// re-states the contract, and it puts the new spelling straight in front of the
// fold here.
//
// WHAT IT DOES NOT. The fold is deliberately tolerant of an undeclared `rel`
// (the address rule is what a hand-authored fence relies on), so a dropped role
// stamp reaches the same slots and no assertion over the slots would see it.
// That invariant is asserted on the fixture directly instead — see
// TestComposerWire_EveryMintedReferenceDeclaresItsRole.
const composerWirePayload = "testdata/composer-wire-payload.json"

type composerCase struct {
	Name    string                 `json:"name"`
	Attrs   map[string]interface{} `json:"attrs"`
	Gesture struct {
		About  string `json:"about"`
		Ask    string `json:"ask"`
		Attach []struct {
			URI   string `json:"uri"`
			Title string `json:"title"`
		} `json:"attach"`
	} `json:"gesture"`
}

// composerCases reads the shared fixture, keyed by case name. It also holds the
// fixture's container to the uuid this package's fold is measured against — the
// two must name the same document or every case would read as foreign.
func composerCases(t *testing.T) map[string]composerCase {
	t.Helper()
	body, err := os.ReadFile(composerWirePayload)
	if err != nil {
		t.Fatalf("the shared composer fixture is unreadable: %v", err)
	}
	var fixture struct {
		Container string         `json:"container"`
		Cases     []composerCase `json:"cases"`
	}
	if err := json.Unmarshal(body, &fixture); err != nil {
		t.Fatalf("the shared composer fixture is not JSON: %v", err)
	}
	if fixture.Container != foldDocUUID {
		t.Fatalf("fixture container %q is not the document the fold is measured against", fixture.Container)
	}
	out := make(map[string]composerCase, len(fixture.Cases))
	for _, c := range fixture.Cases {
		out[c.Name] = c
	}
	return out
}

// composerBlock is one case's payload as it lands in the tree: through the
// create path, which converts nothing.
func composerBlock(t *testing.T, name string) block.SieveBlock {
	t.Helper()
	c, ok := composerCases(t)[name]
	if !ok {
		t.Fatalf("the shared composer fixture names no case %q", name)
	}
	return block.SieveBlock{
		ID:    "ai-1",
		Kind:  "ai-block",
		Attrs: (&AIBlockProcessor{}).InitAttrs("ai-1", c.Attrs),
	}
}

func TestComposerWire_AsksAboutABlockOfThisDocument(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	q := (&AIBlockProcessor{}).foldQuestion(
		composerBlock(t, "asks about a block of this document"), block.DocView{UUID: foldDocUUID})

	if got := q.targets.names(); got != foldLeafID {
		t.Errorf("target = %q, want the block the composer named", got)
	}
	if len(q.body) != 1 || q.body[0].StringAttr("content") != "why?" {
		t.Errorf("body = %+v, want the typed text", q.body)
	}
	if len(q.attachments) != 0 {
		t.Errorf("attachments = %+v, want none", q.attachments)
	}
}

func TestComposerWire_AsksAboutTheWholeDocumentWithAnAttachment(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	q := (&AIBlockProcessor{}).foldQuestion(
		composerBlock(t, "asks about the whole document with an attachment"), block.DocView{UUID: foldDocUUID})

	if got := q.targets.names(); got != block.WholeDocumentRef {
		t.Errorf("target = %q, want the whole-document token", got)
	}
	if len(q.attachments) != 1 || q.attachments[0].URI != foldOther || q.attachments[0].Title != "Auth Design" {
		t.Errorf("attachments = %+v, want the attached document with its cached title", q.attachments)
	}
}

// An Explain sends its target and no text at all.
func TestComposerWire_ExplainCarriesNoProse(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	blk := composerBlock(t, "explain carries no prose")
	header := (&AIBlockProcessor{}).qaHeader(blk, block.DocView{UUID: foldDocUUID})
	if header != "EXPLAIN NODE: "+foldLeafID {
		t.Errorf("header = %q", header)
	}
}

// An element arrives WITHOUT an id — the composer mints none — and the create
// path gives it one: written into the STORED entry, carried on both sides of the
// id invariant by every element read out of it, and unchanged by a second read.
func TestComposerWire_IdlessElementsAreIdentifiedAtCreate(t *testing.T) {
	c, ok := composerCases(t)["a detached question is prose alone"]
	if !ok {
		t.Fatal("the shared composer fixture names no id-less case")
	}
	attrs := (&AIBlockProcessor{}).InitAttrs("ai-1", c.Attrs)

	stored, _ := attrs[block.QuestionAttr].([]interface{})
	if len(stored) != 1 {
		t.Fatalf("stored question = %+v, want the composer's one element", attrs[block.QuestionAttr])
	}
	entry, _ := stored[0].(map[string]interface{})
	entryAttrs, _ := entry["attrs"].(map[string]interface{})
	id, _ := entryAttrs["id"].(string)
	if id == "" {
		t.Fatalf("the stored entry carries no id after create: %+v", entry)
	}

	blk := block.SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: attrs}
	first := blk.Elements(block.QuestionAttr)
	if len(first) != 1 || first[0].ID != id || first[0].StringAttr("id") != id {
		t.Fatalf("element identity = %+v, want both sides carrying %q", first, id)
	}
	if second := blk.Elements(block.QuestionAttr); second[0].ID != id {
		t.Errorf("element id changed between reads: %q then %q", id, second[0].ID)
	}
}

// EVERY REFERENCE A GESTURE MINTS DECLARES ITS ROLE. The fold does not require
// it — an undeclared reference falls through to the address rule, which is what
// a hand-authored fence relies on — so a dropped stamp would reach the same
// slots here and go unnoticed. It is asserted directly on the fixture instead,
// which is the one place the composer's output is written down.
func TestComposerWire_EveryMintedReferenceDeclaresItsRole(t *testing.T) {
	roles := map[string]bool{block.RelTarget: true, block.RelAttach: true}
	for name, c := range composerCases(t) {
		blk := block.SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: c.Attrs}
		for _, el := range blk.Elements(block.QuestionAttr) {
			if el.Kind != block.KindReference {
				continue
			}
			if rel := el.StringAttr("rel"); !roles[rel] {
				t.Errorf("%s: reference %q declares rel %q, want target or attach",
					name, el.StringAttr("uri"), rel)
			}
		}
	}
}

// A case nobody folds is a case nobody checks, so the fixture may not grow one
// side only: every case in the file is exercised here, and the JS suite makes
// the mirror-image assertion.
func TestComposerWire_EveryFixtureCaseIsExercised(t *testing.T) {
	exercised := map[string]bool{
		"asks about a block of this document":              true,
		"asks about the whole document with an attachment": true,
		"explain carries no prose":                         true,
		"a detached question is prose alone":               true,
	}
	for name := range composerCases(t) {
		if !exercised[name] {
			t.Errorf("fixture case %q is folded by nothing in this file", name)
		}
	}
}
