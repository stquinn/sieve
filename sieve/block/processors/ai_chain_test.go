package processors

import (
	"fmt"
	"strings"
	"testing"

	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// chainUUID is the container the chain fixtures live in — the naming authority
// their question elements are addressed against. chainOtherUUID is a second
// container, so a chain that leaves this one can be written down.
const (
	chainUUID      = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4aff"
	chainOtherUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4afe"
)

// chainAsk builds an ai-block in its current form: a question list naming the
// blocks in THIS container it is about, then its text. The handles stay readable
// — an address's leaf is whatever the container will be asked to look up.
func chainAsk(id, question string, targets ...string) domain.SieveBlock {
	return chainAskIn(chainUUID, id, question, targets...)
}

// chainAskIn is chainAsk with the container its targets are named against, so a
// fixture can point at a block in another document.
func chainAskIn(container, id, question string, targets ...string) domain.SieveBlock {
	blk := domain.NewSieveBlock("ai-block", id, map[string]interface{}{"id": id, "type": "ASK"})
	var els domain.Elements
	for _, t := range targets {
		els = append(els, domain.NewSieveBlock(block.KindReference, "", map[string]interface{}{
			"uri": domain.NewLeafAddress(container, t).String(), "rel": block.RelTarget,
		}))
	}
	if question != "" {
		els = append(els, domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": question}))
	}
	blk.SetElements(block.QuestionAttr, els)
	return blk
}

// quotingAsk is an ai-block whose question quotes `quoted` from block target of
// container quotedIn — a target reference drawn as a quote, its text in the
// cache — and then asks question.
func quotingAsk(quotedIn, id, question, target, quoted string) domain.SieveBlock {
	blk := domain.NewSieveBlock("ai-block", id, map[string]interface{}{"id": id, "type": "ASK"})
	blk.SetElements(block.QuestionAttr, domain.Elements{
		domain.NewSieveBlock(block.KindReference, "", map[string]interface{}{
			"uri":       domain.NewLeafAddress(quotedIn, target).String(),
			"rel":       block.RelTarget,
			"displayAs": ReferenceDisplayQuote,
			"cache":     map[string]interface{}{ReferenceQuoteKey: quoted},
		}),
		domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": question}),
	})
	return blk
}

// A multi-block selection: the action's direct targets are a MANY of leaf blocks
// (the selected prose). All become the TARGET; there is no thread. This is the
// reported defect — previously the first block became TARGET and the rest were
// mis-filed as THREAD (prior Q&A history).
func TestResolveChain_multiBlockSelection_allTargetsNoThread(t *testing.T) {
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-a", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-b", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
		{ID: "pr-c", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "gamma"}},
	}}
	w := (&AIBlockProcessor{}).resolveChain(chainAsk("ai-x", "", "pr-a", "pr-b", "pr-c"), doc)
	if strings.Join(w.local, ",") != "pr-a,pr-b,pr-c" {
		t.Fatalf("targets = %v, want all three leaves", w.local)
	}
	if len(w.thread) != 0 {
		t.Fatalf("thread = %v, want empty", w.thread)
	}
}

// A deep point-to-point chain (ai-d8ce -> ai-8af1 -> ai-cef2 -> [pr-1, pr-2]).
// The walk must descend the interior ai-blocks (THREAD) and reach the terminal MANY
// of leaves (TARGET) — the one-level expandAIBlockRefs could not, so the source data
// was unreachable on a pointer chain.
func TestResolveChain_deepPointerChain_terminalManyIsTarget(t *testing.T) {
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		chainAsk("ai-cef2", "q1", "pr-1", "pr-2"),
		chainAsk("ai-8af1", "q2", "ai-cef2"),
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
	}}
	w := (&AIBlockProcessor{}).resolveChain(chainAsk("ai-d8ce", "", "ai-8af1"), doc)
	if strings.Join(w.local, ",") != "pr-1,pr-2" {
		t.Fatalf("targets = %v, want the terminal MANY leaves [pr-1, pr-2]", w.local)
	}
	// Thread oldest-first: the deepest interior (ai-cef2) is oldest, then ai-8af1.
	if strings.Join(w.thread, ",") != "ai-cef2,ai-8af1" {
		t.Fatalf("thread = %v, want [ai-cef2, ai-8af1] oldest-first", w.thread)
	}
}

// A cyclic graph must terminate (the seen-guard) rather than loop forever.
func TestResolveChain_cycle_terminates(t *testing.T) {
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		chainAsk("ai-1", "", "ai-2"),
		chainAsk("ai-2", "", "ai-1"),
	}}
	// Returning at all (no hang) is the assertion; order is meaningless in a cycle,
	// so just require each interior node exactly once and no leaf.
	w := (&AIBlockProcessor{}).resolveChain(chainAsk("ai-start", "", "ai-1"), doc)
	if len(w.local) != 0 || len(w.foreign) != 0 {
		t.Fatalf("a pure cycle has no leaf; targets = %v / %v", w.local, w.foreign)
	}
	if len(w.thread) != 2 || !strings.Contains(strings.Join(w.thread, ","), "ai-1") || !strings.Contains(strings.Join(w.thread, ","), "ai-2") {
		t.Fatalf("thread = %v, want both interior nodes exactly once", w.thread)
	}
}

// The action block itself is already seen, so a chain that points back at it
// terminates rather than re-walking it — and the guard recognises it by ADDRESS,
// which is how a node is named once a chain can leave its container.
func TestResolveChain_selfReferenceTerminates(t *testing.T) {
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		chainAsk("ai-1", "", "ai-self"),
	}}
	self := chainAsk("ai-self", "", "ai-1")
	w := (&AIBlockProcessor{}).resolveChain(self, doc)
	if len(w.local) != 0 || len(w.foreign) != 0 {
		t.Fatalf("targets = %v / %v, want none", w.local, w.foreign)
	}
	if strings.Join(w.thread, ",") != "ai-1" {
		t.Fatalf("thread = %v, want just the one interior node", w.thread)
	}
}

// A chain link in ANOTHER container terminates the walk on that branch: reading
// a foreign document is how deeper history would be reached, and nothing foreign
// is read to compose a prompt. The link renders in place instead.
//
// The foreign target's leaf deliberately names a block that also exists HERE, so
// a walk that keyed on the bare handle rather than the address would descend
// into the local block and cross the boundary unnoticed.
func TestResolveChain_foreignLinkTerminatesTheWalk(t *testing.T) {
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		chainAsk("ai-mine", "", "pr-1"),
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
	}}
	w := (&AIBlockProcessor{}).resolveChain(chainAskIn(chainOtherUUID, "ai-x", "", "ai-mine"), doc)

	if len(w.thread) != 0 {
		t.Errorf("the walk crossed the container boundary; thread = %v", w.thread)
	}
	if len(w.local) != 0 {
		t.Errorf("a foreign link resolved as a local handle; targets = %v", w.local)
	}
	if len(w.foreign) != 1 || w.foreign[0].StringAttr("uri") != domain.NewLeafAddress(chainOtherUUID, "ai-mine").String() {
		t.Fatalf("the foreign link is not a terminal target rendered in place: %+v", w.foreign)
	}
}

// The whole document is a leaf — a valid target terminus.
func TestResolveChain_docSentinelIsATargetLeaf(t *testing.T) {
	blk := domain.NewSieveBlock("ai-block", "ai-x", map[string]interface{}{"type": "ASK"})
	blk.SetElements(block.QuestionAttr, domain.Elements{
		domain.NewSieveBlock(block.KindReference, "", map[string]interface{}{
			"uri": domain.NewContainerAddress(chainUUID).String(), "rel": block.RelTarget,
		}),
	})
	w := (&AIBlockProcessor{}).resolveChain(blk, block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}})
	if strings.Join(w.local, ",") != block.WholeDocumentRef || len(w.thread) != 0 {
		t.Fatalf("doc must be a target leaf; targets=%v thread=%v", w.local, w.thread)
	}
}

// The action ai-block's QUESTION ABOUT must reference its FULL direct ref (the MANY),
// not just the last segment — under the pointer model the whole ref is what it asks
// about, so a 3-block selection shows all three, not just the last.
func TestAIBlockBuildContext_questionAboutUsesFullDirectRef(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	p := &AIBlockProcessor{}
	blk := chainAsk("ai-cef2", "Multi span", "pr-c2dc", "pr-e51a", "pr-f405")
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}}
	for _, id := range []string{"pr-c2dc", "pr-e51a", "pr-f405"} {
		doc.Blocks = append(doc.Blocks, domain.SieveBlock{ID: id, Kind: block.KindProse, Attrs: map[string]interface{}{"content": id}})
	}
	ctx := p.BuildContext(blk, doc, map[string]bool{})
	want := leafAddress(chainUUID, "pr-c2dc") + "," + leafAddress(chainUUID, "pr-e51a") + "," + leafAddress(chainUUID, "pr-f405")
	if !strings.Contains(ctx.String(), want) {
		t.Fatalf("QUESTION ABOUT should reference the full direct ref, got: %q", ctx)
	}
}

// A local target is named by the very address that heads the entry it points
// at, so a model matches the two by plain equality; a context built against no
// container prints no header at all.
func TestBuildPrompt_TargetNameEqualsTheHeaderOfItsEntry(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	blocks := []domain.SieveBlock{
		chainAsk("ai-8af1", "q2", "pr-1"),
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
	}
	p := NewAIBlockProcessor(block.BlockServices{})
	ask := chainAsk("ai-d8ce", "q3", "ai-8af1")

	cases := []struct {
		name       string
		doc        block.DocView
		wantHeader bool
	}{
		{"a container", block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: blocks}, true},
		{"no container", block.DocView{Blocks: blocks}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, history, action := p.buildPrompt(&ask, tc.doc)
			if !tc.wantHeader {
				for slot, got := range map[string]string{"THREAD": history, "ACTION": action} {
					if strings.Contains(got, "ADDRESS:") || strings.Contains(got, "ai-d8ce") {
						t.Errorf("%s printed a header or a bare id with no container: %q", slot, got)
					}
				}
				return
			}
			target := leafAddress(chainUUID, "ai-8af1")
			if !strings.HasPrefix(history, "===== TURN 1 of 1 =====\nADDRESS: "+target+"\n") {
				t.Errorf("THREAD entry is not headed by %q: %q", target, history)
			}
			if want := "ADDRESS: " + leafAddress(chainUUID, "ai-d8ce") + "\nQUESTION ABOUT: " + target + "\nq3"; action != want {
				t.Errorf("ACTION = %q, want %q", action, want)
			}
		})
	}
}

// Each THREAD entry opens with its own numbered line, oldest first, and that
// line is the only thing between one entry and the next.
func TestBuildPrompt_ThreadEntriesAreNumberedAndSeparated(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		chainAsk("ai-8af1", "q1", "pr-1"),
		chainAsk("ai-9bf2", "q2", "ai-8af1"),
	}}
	ask := chainAsk("ai-d8ce", "q3", "ai-9bf2")

	_, history, _ := NewAIBlockProcessor(block.BlockServices{}).buildPrompt(&ask, doc)

	first := "===== TURN 1 of 2 =====\nADDRESS: " + leafAddress(chainUUID, "ai-8af1") + "\n"
	second := "\n\n===== TURN 2 of 2 =====\nADDRESS: " + leafAddress(chainUUID, "ai-9bf2") + "\n"
	if !strings.HasPrefix(history, first) || !strings.Contains(history, second) {
		t.Errorf("THREAD = %q, want it to open with %q and hold %q", history, first, second)
	}
	if strings.Contains(history, "---") {
		t.Errorf("THREAD separates its entries with a rule: %q", history)
	}
}

// Each TARGET member is its own entry: numbered, typed by its kind and headed by
// its own address, with a blank line the only thing between entries.
func TestBuildPrompt_TargetMembersAreNumberedEntriesOfTheirOwnKind(t *testing.T) {
	registerAnswerKinds(t)
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "We add the region column first."}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"language": "sql", "source": "select 1"}},
	}}
	ask := chainAsk("ai-x", "q", "pr-1", "co-1")

	target, _, _ := NewAIBlockProcessor(block.BlockServices{}).buildPrompt(&ask, doc)

	first := blockMarker(1, 2, block.KindProse) + addressHeader(chainUUID, "pr-1") + "We add the region column first."
	second := "\n\n" + blockMarker(2, 2, "code") + addressHeader(chainUUID, "co-1") + "```sql\nselect 1\n```"
	if !strings.HasPrefix(target, first) || !strings.Contains(target, second) {
		t.Errorf("TARGET = %q, want it to open with %q and hold %q", target, first, second)
	}
}

// Highlights from several prose targets are one trailer after the last entry; no
// entry carries a trailer of its own.
func TestBuildPrompt_TargetHighlightsUnionIntoOneTrailingFocusLine(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "the ==first== one"}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "the ==second== one"}},
	}}
	ask := chainAsk("ai-x", "q", "pr-1", "pr-2")

	target, _, _ := NewAIBlockProcessor(block.BlockServices{}).buildPrompt(&ask, doc)

	want := targetEntries(
		blockMarker(1, 2, block.KindProse)+addressHeader(chainUUID, "pr-1")+"the ==first== one",
		blockMarker(2, 2, block.KindProse)+addressHeader(chainUUID, "pr-2")+"the ==second== one") +
		"\n\n" + `Specifically regarding: "first", "second"`
	if target != want {
		t.Errorf("TARGET:\n got: %q\nwant: %q", target, want)
	}
}

// What a quote quoted reaches the model once, wherever its target is rendered: a
// target in this document is inlined by handle and the question's header says
// what of it was regarded; a target elsewhere is its own TARGET entry, whose
// focus line says it. A target reference holding no quote adds nothing to either.
func TestBuildPrompt_AQuoteSaysWhatWasSpecificallyRegarded(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewReferenceProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)
	focus := "\n\n" + `Specifically regarding: "the region column"`
	local := quotingAsk(chainUUID, "ai-x", "why first?", "pr-1", "the region column")
	foreign := quotingAsk(chainOtherUUID, "ai-x", "why first?", "pr-9", "the region column")
	plain := chainAsk("ai-x", "why first?", "pr-1")

	for _, tc := range []struct {
		name               string
		ask                domain.SieveBlock
		target, actionTail string
	}{
		{"a quote of a block here", local,
			blockMarker(1, 1, block.KindProse) + addressHeader(chainUUID, "pr-1") + "We add the region column first.",
			"QUESTION ABOUT: " + leafAddress(chainUUID, "pr-1") + "\nwhy first?" + focus},
		{"a quote of a block elsewhere", foreign,
			blockMarker(1, 1, block.KindReference) + "Reference: " + leafAddress(chainOtherUUID, "pr-9") + "\n" +
				"\n\nAddress: \"" + leafAddress(chainOtherUUID, "pr-9") + "\"" + focus,
			"QUESTION ABOUT: " + leafAddress(chainOtherUUID, "pr-9") + "\nwhy first?"},
		{"a target that quotes nothing", plain,
			blockMarker(1, 1, block.KindProse) + addressHeader(chainUUID, "pr-1") + "We add the region column first.",
			"QUESTION ABOUT: " + leafAddress(chainUUID, "pr-1") + "\nwhy first?"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
				{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "We add the region column first."}},
				tc.ask,
			}}
			target, _, action := NewAIBlockProcessor(block.BlockServices{}).buildPrompt(&tc.ask, doc)
			if target != tc.target {
				t.Errorf("TARGET:\n got: %q\nwant: %q", target, tc.target)
			}
			if !strings.HasSuffix(action, tc.actionTail) {
				t.Errorf("ACTION:\n got: %q\nwant it to end: %q", action, tc.actionTail)
			}
		})
	}
}

// A member that renders to nothing is not an entry, is not counted, and is not
// named by the ACTION: the names are exactly the entries, and their number is
// the m of "BLOCK n of m".
func TestBuildPrompt_EmptyTargetMemberIsNotCounted(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-empty", Kind: block.KindProse, Attrs: map[string]interface{}{"content": ""}},
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
		{ID: "pr-blank", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "  "}},
		{ID: "pr-2", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "beta"}},
	}}
	ask := chainAsk("ai-x", "q", "pr-empty", "pr-1", "pr-blank", "pr-2")
	doc.Blocks = append(doc.Blocks, ask)

	target, _, action := NewAIBlockProcessor(block.BlockServices{}).buildPrompt(&ask, doc)

	if want := targetEntries(
		blockMarker(1, 2, block.KindProse)+addressHeader(chainUUID, "pr-1")+"alpha",
		blockMarker(2, 2, block.KindProse)+addressHeader(chainUUID, "pr-2")+"beta"); target != want {
		t.Errorf("TARGET:\n got: %q\nwant: %q", target, want)
	}
	want := "QUESTION ABOUT: " + leafAddress(chainUUID, "pr-1") + "," + leafAddress(chainUUID, "pr-2")
	if !strings.Contains(action, want+"\nq") {
		t.Errorf("ACTION should name exactly the two members with entries:\n got: %q\nwant it to contain: %q", action, want)
	}
}

// A question whose every target is empty is headed as a question with no targets.
func TestBuildPrompt_AllTargetsEmptyNamesNone(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	doc := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-empty", Kind: block.KindProse, Attrs: map[string]interface{}{"content": ""}},
	}}
	ask := chainAsk("ai-x", "q", "pr-empty")
	doc.Blocks = append(doc.Blocks, ask)
	detached := chainAsk("ai-y", "q")
	doc.Blocks = append(doc.Blocks, detached)

	p := NewAIBlockProcessor(block.BlockServices{})
	_, _, got := p.buildPrompt(&ask, doc)
	_, _, want := p.buildPrompt(&detached, doc)
	if strings.Replace(got, "ai-x", "ai-y", -1) != want {
		t.Errorf("all-empty header differs from the no-target header:\n got: %q\nwant: %q", got, want)
	}
}

// chatUUID is the chat the conversation fixtures live in.
const chatUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c4a"

// chatTurnID is the id of exchange n of a chat fixture, kept readable.
func chatTurnID(n int) string { return fmt.Sprintf("ex-%02d", n) }

// chatTurnText is how exchange n of a chat fixture reads as a turn: its question,
// which is about nothing and so has no QUESTION ABOUT line, then its answer.
func chatTurnText(n int) string {
	return fmt.Sprintf("Question %d?\n\n**ANSWER:** Answer %d.", n, n)
}

// chatFixture is a chat of n exchanges, each asking "Question i?" and answered
// "Answer i.", but for the exchanges unanswered names, which are asked and not
// answered.
func chatFixture(n int, unanswered ...int) block.ChatView {
	view := block.ChatView{ContainerAddressing: block.ContainerAddressing{UUID: chatUUID}}
	for i := 1; i <= n; i++ {
		ex := chainAskIn(chatUUID, chatTurnID(i), fmt.Sprintf("Question %d?", i))
		ex.Attrs["status"] = block.BlockStatusComplete
		ex.SetElements(block.AnswerAttr, domain.Elements{domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": fmt.Sprintf("Answer %d.", i)})})
		for _, u := range unanswered {
			if u == i {
				ex.Attrs["status"] = block.BlockStatusError
				delete(ex.Attrs, block.AnswerAttr)
			}
		}
		view.Exchanges = append(view.Exchanges, ex)
	}
	return view
}

// chatTurns are the turns a chat fixture's exchanges 1 to n are shown as.
func chatTurns(n int) []ai.ChatTurn {
	var turns []ai.ChatTurn
	for i := 1; i <= n; i++ {
		turns = append(turns, ai.ChatTurn{Address: leafAddress(chatUUID, chatTurnID(i)), Text: chatTurnText(i)})
	}
	return turns
}

// An exchange in a chat is shown its conversation: THREAD is every exchange
// asked before it, oldest first, each a turn under its own address; ABOUT is
// what its question points at that is not already a turn; QUESTION is the
// exchange itself under its address, with no answer. A retry sees only what
// precedes it, and a question pointing at an earlier exchange names it and
// finds it in the THREAD.
func TestBuildPrompt_AChatShowsItsConversationAsTheThread(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	block.RegisterProcessor(NewReferenceProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	pointing := chainAskIn(chatUUID, chatTurnID(4), "And the second again?", chatTurnID(2))
	withPointing := chatFixture(3)
	withPointing.Exchanges = append(withPointing.Exchanges, pointing)

	quoting := quotingAsk(chatUUID, chatTurnID(4), "Why?", chatTurnID(2), "Answer 2.")
	withQuoting := chatFixture(3)
	withQuoting.Exchanges = append(withQuoting.Exchanges, quoting)

	for _, tc := range []struct {
		name  string
		view  block.ChatView
		asked int
		want  ai.ChatData
	}{
		{"a first exchange", chatFixture(1, 1), 1, ai.ChatData{
			Question: "ADDRESS: " + leafAddress(chatUUID, chatTurnID(1)) + "\nQuestion 1?"}},
		{"a tenth exchange", chatFixture(10, 10), 10, ai.ChatData{Turns: chatTurns(9),
			Question: "ADDRESS: " + leafAddress(chatUUID, chatTurnID(10)) + "\nQuestion 10?"}},
		{"a retry of the fifth of ten", chatFixture(10, 5), 5, ai.ChatData{Turns: chatTurns(4),
			Question: "ADDRESS: " + leafAddress(chatUUID, chatTurnID(5)) + "\nQuestion 5?"}},
		{"a question pointing at an earlier exchange", withPointing, 4, ai.ChatData{Turns: chatTurns(3),
			Question: "ADDRESS: " + leafAddress(chatUUID, chatTurnID(4)) + "\nQUESTION ABOUT: " + leafAddress(chatUUID, chatTurnID(2)) + "\nAnd the second again?"}},
		{"a question quoting an earlier answer", withQuoting, 4, ai.ChatData{Turns: chatTurns(3),
			Question: "ADDRESS: " + leafAddress(chatUUID, chatTurnID(4)) + "\nQUESTION ABOUT: " + leafAddress(chatUUID, chatTurnID(2)) + "\nWhy?" +
				"\n\n" + `Specifically regarding: "Answer 2."`}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			asked, _ := tc.view.Block(chatTurnID(tc.asked))
			e := NewAIBlockProcessor(block.BlockServices{}).assemble(&asked, tc.view)
			if !e.conversation {
				t.Error("a chat's exchange was not assembled as a conversation")
			}
			if got := e.chatData(); fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Errorf("data =\n%s\nwant\n%s", got.Text(), tc.want.Text())
			}
		})
	}
}

// A turn's printed text does not change when a later turn is added: the THREAD
// of an eleventh exchange opens with the THREAD of the tenth, byte for byte.
func TestBuildPrompt_AChatTurnReadsTheSameWhateverFollowsIt(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	thread := func(n int) string {
		view := chatFixture(n, n)
		asked, _ := view.Block(chatTurnID(n))
		text := NewAIBlockProcessor(block.BlockServices{}).assemble(&asked, view).chatData().Text()
		thread, _, _ := strings.Cut(text, "\n\n---\n---\n\n")
		return thread
	}
	ten, eleven := thread(11), thread(12)
	if !strings.HasPrefix(eleven, ten+"\n\n===== TURN 11 =====\n") {
		t.Errorf("the first ten turns changed when an eleventh was added:\nten:\n%s\neleven:\n%s", ten, eleven)
	}
}

// The view decides the task: an exchange in a container that declares a
// conversation runs the chat task with the conversation as its data; one in a
// note runs ask with its THREAD, TARGET and ACTION, unchanged. The exchange
// itself says nothing of where it is.
func TestDescribeJob_TheViewDecidesTheTask(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)
	svc, runner := newRecordedAI(t)
	p := NewAIBlockProcessor(block.BlockServices{AI: svc})
	block.RegisterProcessor(p)

	chat := chatFixture(10, 10)
	tenth, _ := chat.Block(chatTurnID(10))
	var thread []string
	for i := 1; i <= 9; i++ {
		thread = append(thread, fmt.Sprintf("===== TURN %d =====\nADDRESS: %s\n%s", i, leafAddress(chatUUID, chatTurnID(i)), chatTurnText(i)))
	}
	note := block.DocView{ContainerAddressing: block.ContainerAddressing{UUID: chainUUID}, Blocks: []domain.SieveBlock{
		{ID: "pr-1", Kind: block.KindProse, Attrs: map[string]interface{}{"content": "alpha"}},
	}}
	asked := chainAsk("ai-x", "q", "pr-1")
	content, history, action := p.buildPrompt(&asked, note)

	for _, tc := range []struct {
		name     string
		view     block.ContainerView
		exchange domain.SieveBlock
		task     string
		data     string
	}{
		{"an exchange in a chat", chat, tenth, "chat", "Container: " + domain.NewContainerAddress(chatUUID).String() + "\n\n" +
			"THREAD:\n" + strings.Join(thread, "\n\n") + "\n\n---\n---\n\n" +
			"QUESTION:\nADDRESS: " + leafAddress(chatUUID, chatTurnID(10)) + "\nQuestion 10?"},
		{"an exchange in a note", note, asked, "ask", "Container: " + domain.NewContainerAddress(chainUUID).String() + "\n\n" +
			ai.ThreadData{ContentType: "markdown", Content: content, History: history, Action: action}.Text()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			blk := tc.exchange.Clone()
			job := p.DescribeJob(block.JobContext{UUID: tc.view.Container(), Doc: tc.view, Block: &blk})
			if _, err := job.Work(); err != nil {
				t.Fatalf("Work: %v", err)
			}
			run := runner.lastRun()
			if run.Task.Name != tc.task {
				t.Errorf("ran %q, want %q", run.Task.Name, tc.task)
			}
			if run.Prompt.Data.Text != tc.data {
				t.Errorf("Data =\n%s\nwant\n%s", run.Prompt.Data.Text, tc.data)
			}
		})
	}
}
