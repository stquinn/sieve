package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

const (
	answerAskID   = "0197b2aa-5555-7888-8999-aaaabbbbcccc"
	answerText    = "A compiled language."
	answerNodeHdr = "NODE ID: " + answerAskID + "\n"
	answerAskHdr  = answerNodeHdr + "QUESTION ABOUT: " + foldLeafID + "\nWhat is Go?"
)

// answered builds the ai-block under test: an exchange of blockType whose
// question is one target plus one line of prose, answered by whatever answer
// holds — the composed list, or the degraded string a producer writes.
func answered(blockType string, answer any) block.SieveBlock {
	blk := block.NewSieveBlock("ai-block", answerAskID, map[string]interface{}{
		"type": blockType, "status": block.BlockStatusComplete, block.AnswerAttr: answer,
	})
	blk.SetElements(block.QuestionAttr, block.Elements{foldTarget(foldLeafID), foldProse("What is Go?")})
	return blk
}

// answerElement is one answer element in the loosely-typed form YAML and the
// wire both hand over.
func answerElement(kind string, attrs map[string]interface{}) interface{} {
	return map[string]interface{}{"kind": kind, "attrs": attrs}
}

// registerAnswerKinds registers the kinds the answer goldens are composed of.
func registerAnswerKinds(t *testing.T) {
	t.Helper()
	resetRegistry()
	svc := block.BlockServices{}
	block.RegisterProcessor(NewAIBlockProcessor(svc))
	block.RegisterProcessor(NewCodeBlockProcessor(svc))
	t.Cleanup(resetRegistry)
}

// THE ANSWER-SIDE BYTE-IDENTITY GOLDENS, captured from the string-shaped
// `response` this list replaced. A single-prose answer must render EXACTLY what
// that string rendered — the answer became a list of blocks, and a list of one
// prose block is the same bytes to a model.
//
// The blank line before **ANSWER:** is the ASK/EXPLAIN difference and is part of
// the golden: an ASK's header ends with the question text, an EXPLAIN's ends
// with the target line.
//
// BOTH FORMS RENDER THE SAME, because they ARE the same answer: the list is what
// a composed answer holds, the bare string is what a producer that cannot
// compose blocks writes, and the reader normalises the second into the first.
func TestAIBlockAnswer_SingleProseRendersAsTheStringDid(t *testing.T) {
	registerAnswerKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})
	doc := block.DocView{UUID: foldDocUUID}

	forms := []struct {
		name   string
		answer any
	}{
		{"composed list", block.Elements{foldProse(answerText)}},
		{"stored list", []interface{}{answerElement(block.KindProse, map[string]interface{}{"content": answerText})}},
		{"degraded string", answerText},
	}
	types := []struct{ blockType, want string }{
		{"ASK", answerAskHdr + "\n\n**ANSWER:** " + answerText},
		{"EXPLAIN", answerNodeHdr + "EXPLAIN NODE: " + foldLeafID + "\n**ANSWER:** " + answerText},
	}

	for _, form := range forms {
		for _, tc := range types {
			t.Run(form.name+"/"+tc.blockType, func(t *testing.T) {
				got := p.BuildContext(answered(tc.blockType, form.answer), doc, map[string]bool{}).String()
				if got != tc.want {
					t.Errorf("BuildContext moved:\n got: %q\nwant: %q", got, tc.want)
				}
			})
		}
	}
}

// An answer of surrounding whitespace renders trimmed, and one that is blank
// renders no **ANSWER:** section at all — an answer that is not there is never
// invented, and a bare marker with nothing after it invents one.
func TestAIBlockAnswer_BlankAndPaddedAnswers(t *testing.T) {
	registerAnswerKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})
	doc := block.DocView{UUID: foldDocUUID}

	for _, tc := range []struct {
		name   string
		answer any
		want   string
	}{
		{"padded", "\n  " + answerText + "  \n", answerAskHdr + "\n\n**ANSWER:** " + answerText},
		{"blank string", "   \n ", answerAskHdr},
		{"absent", nil, answerAskHdr},
		{"empty list", []interface{}{}, answerAskHdr},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := p.BuildContext(answered("ASK", tc.answer), doc, map[string]bool{}).String()
			if got != tc.want {
				t.Errorf("BuildContext moved:\n got: %q\nwant: %q", got, tc.want)
			}
		})
	}
}

// THE MULTI-BLOCK ANSWER GOLDENS — new bytes, for a shape the string form could
// not hold. Every element renders through its own kind's AI seam, in list order,
// and the parts are joined by a blank line: the answer body assembles exactly
// the way the question body does.
func TestAIBlockAnswer_MixedKindsRenderThroughTheirOwnSeams(t *testing.T) {
	registerAnswerKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})
	doc := block.DocView{UUID: foldDocUUID}

	answer := []interface{}{
		answerElement(block.KindProse, map[string]interface{}{"content": "Go compiles to a native binary."}),
		answerElement("code", map[string]interface{}{"language": "go", "source": "func main() {}"}),
		answerElement(block.KindProse, map[string]interface{}{"content": "That is the whole toolchain."}),
	}
	const body = "Go compiles to a native binary.\n\n" +
		"```go\nfunc main() {}\n```\n\n" +
		"That is the whole toolchain."

	got := p.BuildContext(answered("ASK", answer), doc, map[string]bool{}).String()
	if want := answerAskHdr + "\n\n**ANSWER:** " + body; got != want {
		t.Errorf("BuildContext moved:\n got: %q\nwant: %q", got, want)
	}

	// The embed renders the same answer body — one function behind "Embed in
	// Document" and the markdown export.
	if got, want := p.MarkdownRepresentation(answered("ASK", answer), foldDocUUID), "### What is Go?\n\n"+body; got != want {
		t.Errorf("embed moved:\n got: %q\nwant: %q", got, want)
	}
}

// The completeness guard is the ANSWER, not a status alone: an exchange marked
// COMPLETE whose answer list is empty has nothing to embed, and embedding its
// question alone would deposit it as the document's own heading.
func TestAIBlockAnswer_AnEmptyAnswerEmbedsAsNothing(t *testing.T) {
	registerAnswerKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})

	for _, tc := range []struct {
		name   string
		answer any
	}{
		{"absent", nil},
		{"empty list", []interface{}{}},
		{"blank string", "  "},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := p.MarkdownRepresentation(answered("ASK", tc.answer), foldDocUUID); got != "" {
				t.Errorf("MarkdownRepresentation = %q, want empty", got)
			}
		})
	}
}

// Ingest accepts what a producer can return TODAY and what one will return
// LATER, at one door: the CLI's string, a string per block, and a composed list.
// A blank span is not a block, so it mints none.
func TestAIBlockAnswer_IngestFoldsEveryProducerShape(t *testing.T) {
	p := NewAIBlockProcessor(block.BlockServices{})

	for _, tc := range []struct {
		name     string
		result   any
		wantKind []string
		wantText []string
	}{
		{"a string is one prose element", "just text", []string{block.KindProse}, []string{"just text"}},
		{"a blank string is no answer at all", "  \n ", nil, nil},
		{"a string list is one prose element apiece", []string{"first", "", "second"},
			[]string{block.KindProse, block.KindProse}, []string{"first", "second"}},
		{"an element list passes through", []interface{}{
			answerElement(block.KindProse, map[string]interface{}{"content": "prose"}),
			answerElement("code", map[string]interface{}{"source": "x := 1"}),
		}, []string{block.KindProse, "code"}, []string{"prose", ""}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := p.foldAnswer(tc.result)
			if len(got) != len(tc.wantKind) {
				t.Fatalf("folded %d elements, want %d: %+v", len(got), len(tc.wantKind), got)
			}
			for i, el := range got {
				if el.Kind != tc.wantKind[i] {
					t.Errorf("element %d kind = %q, want %q", i, el.Kind, tc.wantKind[i])
				}
				if tc.wantText[i] != "" && el.Content() != tc.wantText[i] {
					t.Errorf("element %d content = %q, want %q", i, el.Content(), tc.wantText[i])
				}
				if el.ID == "" || el.Attrs["id"] != el.ID {
					t.Errorf("element %d id not written on both sides: ID=%q Attrs[id]=%v", i, el.ID, el.Attrs["id"])
				}
			}
		})
	}
}

// The job writes the answer list and nothing else: `response` is gone from the
// runtime vocabulary, so a completed exchange must not grow one back.
func TestAIBlockAnswer_ApplyWritesTheList(t *testing.T) {
	registerAnswerKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})

	blk := block.NewSieveBlock("ai-block", answerAskID, map[string]interface{}{"type": "ASK"})
	job := p.DescribeJob(block.JobContext{Block: &blk, UUID: foldDocUUID, Doc: block.DocView{UUID: foldDocUUID}})
	if job == nil {
		t.Fatal("an ai-block always has async work")
	}
	job.Apply(answerText, &blk)

	if blk.Attrs["status"] != block.BlockStatusComplete || blk.Attrs["completedAt"] == "" {
		t.Errorf("the completion envelope was not stamped: %+v", blk.Attrs)
	}
	if v, present := blk.Attrs["response"]; present {
		t.Errorf("the retired `response` attr came back: %v", v)
	}
	els := blk.Elements(block.AnswerAttr)
	if len(els) != 1 || els[0].Kind != block.KindProse || els[0].Content() != answerText {
		t.Fatalf("answer = %+v, want one prose element", els)
	}
	if els[0].ID == "" || els[0].Attrs["id"] != els[0].ID {
		t.Errorf("the ingested element is not identified: ID=%q Attrs[id]=%v", els[0].ID, els[0].Attrs["id"])
	}
}

// Both slots are element lists, so both are children: the answer's blocks are
// this block's children exactly as the question's are, in slot order.
func TestAIBlockAnswer_ChildrenSpanBothSlots(t *testing.T) {
	registerAnswerKinds(t)
	p := NewAIBlockProcessor(block.BlockServices{})

	blk := answered("ASK", []interface{}{
		answerElement(block.KindProse, map[string]interface{}{"content": "because"}),
		answerElement("code", map[string]interface{}{"source": "x := 1"}),
	})
	var kinds []string
	for _, c := range p.Children(&blk) {
		kinds = append(kinds, c.Kind)
	}
	if got := strings.Join(kinds, ","); got != "reference,prose,prose,code" {
		t.Errorf("Children = %s, want the question's elements then the answer's", got)
	}
}
