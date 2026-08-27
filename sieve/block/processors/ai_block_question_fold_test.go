package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

const (
	foldDocUUID   = "0197b2aa-1111-7888-8999-aaaabbbbcccc"
	foldOtherUUID = "0197b2aa-2222-7888-8999-aaaabbbbcccc"
	foldLeafID    = "0197b2aa-3333-7888-8999-aaaabbbbcccc"

	foldSelf       = "sieve://" + foldDocUUID
	foldSelfLeaf   = "sieve://" + foldDocUUID + "/" + foldLeafID
	foldOther      = "sieve://" + foldOtherUUID
	foldOtherLeaf  = "sieve://" + foldOtherUUID + "/" + foldLeafID
	foldUnparsable = "sieve://not-a-uuid"
)

// foldReference builds one reference element: the address it points at, the role
// it declares, and the face it cached. rel == "" is an element that never
// declared a role.
func foldReference(uri, rel, title string) block.SieveBlock {
	attrs := map[string]interface{}{"uri": uri}
	if rel != "" {
		attrs["rel"] = rel
	}
	if title != "" {
		attrs[block.FaceAttr] = map[string]interface{}{"title": title}
	}
	return block.NewSieveBlock(block.KindReference, "", attrs)
}

// foldTarget builds a reference element naming a block in THIS document — the
// current form of a legacy `ref` token.
func foldTarget(blockID string) block.SieveBlock {
	return foldReference("sieve://"+foldDocUUID+"/"+blockID, block.RelTarget, "")
}

// foldProse builds the question-text element — the current form of the legacy
// `question` attr.
func foldProse(text string) block.SieveBlock {
	return block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": text})
}

// foldAsk builds the ai-block under test: an ASK whose question is els.
func foldAsk(els ...block.SieveBlock) block.SieveBlock {
	blk := block.NewSieveBlock("ai-block", "0197b2aa-4444-7888-8999-aaaabbbbcccc", map[string]interface{}{"type": "ASK"})
	blk.SetElements(block.QuestionAttr, els)
	return blk
}

// A reference element's `rel` names its role and decides its slot; the address
// decides only when `rel` names neither role. The two rules disagree on purpose
// in the rel:attach + self-container row — attaching the document you are
// already in is expressible ONLY by declaring the role.
func TestAIBlockFold_ReferenceRoleDecidesTheSlot(t *testing.T) {
	p := &AIBlockProcessor{}
	doc := block.DocView{UUID: foldDocUUID}

	cases := []struct {
		name string
		uri  string
		rel  string
		// wantName is what the header calls this element, "" when it is not a
		// target at all; wantLocal is the handle the local chain walks it by.
		wantName   string
		wantLocal  string
		wantAttach string // the attachment uri this element contributes, "" for none
	}{
		{"declared target, own container", foldSelf, block.RelTarget, block.WholeDocumentRef, block.WholeDocumentRef, ""},
		{"declared target, local leaf", foldSelfLeaf, block.RelTarget, foldLeafID, foldLeafID, ""},
		{"declared target, leaf elsewhere", foldOtherLeaf, block.RelTarget, foldOtherLeaf, "", ""},
		{"declared target, another document", foldOther, block.RelTarget, foldOther, "", ""},
		{"declared attach, another document", foldOther, block.RelAttach, "", "", foldOther},
		{"declared attach, own container", foldSelf, block.RelAttach, "", "", foldSelf},
		{"declared attach, local leaf", foldSelfLeaf, block.RelAttach, "", "", foldSelfLeaf},
		{"undeclared, own container", foldSelf, "", block.WholeDocumentRef, block.WholeDocumentRef, ""},
		{"undeclared, local leaf", foldSelfLeaf, "", foldLeafID, foldLeafID, ""},
		{"undeclared, another document", foldOther, "", "", "", foldOther},
		{"undeclared, leaf elsewhere", foldOtherLeaf, "", "", "", foldOtherLeaf},
		{"unrecognised rel, local leaf", foldSelfLeaf, "quote", foldLeafID, foldLeafID, ""},
		{"unrecognised rel, another document", foldOther, "quote", "", "", foldOther},
		{"undeclared, unaddressable", foldUnparsable, "", "", "", foldUnparsable},
		{"declared target, unaddressable", foldUnparsable, block.RelTarget, foldUnparsable, "", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			el := foldReference(tc.uri, tc.rel, "")
			q := p.foldQuestion(foldAsk(el), doc)

			if len(q.body) != 0 {
				t.Errorf("a reference reached the body slot: %+v", q.body)
			}
			if got := q.targets.names(); got != tc.wantName {
				t.Errorf("target names = %q, want %q", got, tc.wantName)
			}
			var attached string
			if len(q.attachments) == 1 {
				attached = q.attachments[0].URI
			} else if len(q.attachments) > 1 {
				t.Fatalf("one element produced %d attachments", len(q.attachments))
			}
			if attached != tc.wantAttach {
				t.Errorf("attachment = %q, want %q", attached, tc.wantAttach)
			}
			// A target the local chain cannot walk is still a target: it renders
			// in place rather than resolving to inlined content.
			if len(q.targets.els) == 1 {
				token, local := q.targets.localToken(q.targets.els[0])
				if !local {
					token = ""
				}
				if token != tc.wantLocal {
					t.Errorf("local handle = %q, want %q", token, tc.wantLocal)
				}
			}
		})
	}
}

// A target in ANOTHER container is first-class in the target slot, and renders
// there AS A REFERENCE: its address and cached title, with nothing fetched — the
// model dereferences it through the MCP verb if it wants the content.
func TestAIBlockFold_AForeignTargetRendersInPlace(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewReferenceProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(block.BlockServices{})
	blk := foldAsk(
		foldReference(foldOtherLeaf, block.RelTarget, "Auth Design"),
		block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": "what does this say?"}),
	)
	content, _, question := p.buildPrompt(&blk, block.DocView{UUID: foldDocUUID})

	if !strings.Contains(content, "Reference: Auth Design") || !strings.Contains(content, foldOtherLeaf) {
		t.Errorf("TARGET did not render the foreign target in place:\n%s", content)
	}
	// The element's own id names nothing the model can ask for: only its address
	// does, and the reference renders that.
	target := blk.Elements(block.QuestionAttr)[0]
	if strings.Contains(content, target.ID) {
		t.Errorf("an element id was published as a NODE ID:\n%s", content)
	}
	if !strings.Contains(question, "QUESTION ABOUT: "+foldOtherLeaf) {
		t.Errorf("the header did not name the foreign target:\n%s", question)
	}
}

// The reference the target names is not dereferenced at composition time: a
// bare foreign target still renders, naming what it points at and nothing more.
func TestAIBlockFold_AForeignTargetIsNeverFetched(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewReferenceProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	p := NewAIBlockProcessor(block.BlockServices{})
	blk := foldAsk(foldReference(foldOther, block.RelTarget, ""))
	content, _, _ := p.buildPrompt(&blk, block.DocView{UUID: foldDocUUID})

	if !strings.Contains(content, foldOther) {
		t.Fatalf("a faceless foreign target vanished from the TARGET slot:\n%s", content)
	}
}

// The body is every non-reference element, whatever its kind, rendered through
// the kind's own AI seam and concatenated — the fold owns no per-kind arm.
func TestAIBlockFold_BodyRendersEveryKindThroughItsOwnSeam(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	q := p.foldQuestion(foldAsk(
		block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": "why is this slow?"}),
		block.NewSieveBlock("code", "", map[string]interface{}{"source": "for {}", "language": "go"}),
		block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": "be brief"}),
	), block.DocView{UUID: foldDocUUID})

	if len(q.body) != 3 {
		t.Fatalf("body holds %d elements, want 3", len(q.body))
	}
	want := "why is this slow?\n\n```go\nfor {}\n```\n\nbe brief"
	if got := p.questionText(q.body, block.DocView{UUID: foldDocUUID}); got != want {
		t.Errorf("body text:\n got: %q\nwant: %q", got, want)
	}
}

// The three slots reach the three prompt shapes: the targets are the header, the
// body is the question, the attachments are the manifest.
func TestAIBlockFold_EachSlotReachesItsPromptShape(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	header := p.qaHeader(foldAsk(
		foldReference(foldSelfLeaf, block.RelTarget, ""),
		block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": "compare these"}),
		foldReference(foldOther, block.RelAttach, "Auth Design"),
	), block.DocView{UUID: foldDocUUID})

	if !strings.HasPrefix(header, "QUESTION ABOUT: "+foldLeafID+"\ncompare these") {
		t.Errorf("targets and body did not reach the header:\n%s", header)
	}
	if !strings.Contains(header, "ATTACHED DOCUMENTS") || !strings.Contains(header, "Auth Design") {
		t.Errorf("the attachment did not reach the manifest:\n%s", header)
	}
}

// An ai-block with no question list at all is detached and asks about nothing —
// the legacy attrs are not a fallback, they are not read.
func TestAIBlockFold_AListlessBlockIsDetached(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	blk := block.NewSieveBlock("ai-block", "0197b2aa-5555-7888-8999-aaaabbbbcccc", map[string]interface{}{
		"type": "ASK", "ref": "doc", "question": "legacy text",
	})
	if header := p.qaHeader(blk, block.DocView{UUID: foldDocUUID}); header != "QUESTION ABOUT: " {
		t.Errorf("qaHeader = %q, want the detached header alone", header)
	}
}
