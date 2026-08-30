package block

import (
	"testing"
)

// aiDocUUID is the container the ai-block under test lives in — what the
// migrator mints leaf addresses against.
const aiDocUUID = "0197b1f4-7777-7888-8999-aaaabbbbcccc"

// aiTargetID and aiTargetTwo are blocks in that same document, named by a legacy
// `ref` list.
const (
	aiTargetID  = "0197b1f4-1234-7888-8999-aaaabbbbcccc"
	aiTargetTwo = "0197b1f4-5678-7888-8999-aaaabbbbcccc"
)

func aiBlock(attrs map[string]interface{}) SieveBlock {
	full := map[string]interface{}{"id": "0197b1f4-0000-7888-8999-aaaabbbbcccc"}
	for k, v := range attrs {
		full[k] = v
	}
	return SieveBlock{ID: full["id"].(string), Kind: "ai-block", Attrs: full}
}

// migratedElements runs the migrator over one ai-block and returns its question
// elements, failing the test when the record was not converted.
func migratedElements(t *testing.T, attrs map[string]interface{}) Elements {
	t.Helper()
	out, changed := AIBlockMigrator{}.Migrate([]SieveBlock{aiBlock(attrs)}, aiDocUUID)
	if !changed {
		t.Fatalf("changed = false for a legacy record: %+v", attrs)
	}
	got := DecodeElements(out[0].Attrs[QuestionAttr])
	if len(got) == 0 {
		t.Fatalf("conversion produced no elements: %+v", out[0].Attrs)
	}
	return got
}

func TestAIBlockMigrator_QuestionStringBecomesAProseElement(t *testing.T) {
	got := migratedElements(t, map[string]interface{}{
		"question": "What does this mean?",
		"ref":      "",
	})
	if len(got) != 1 {
		t.Fatalf("got %d elements, want 1: %+v", len(got), got)
	}
	if got[0].Kind != KindProse {
		t.Errorf("element kind = %q, want %q", got[0].Kind, KindProse)
	}
	if got[0].Content() != "What does this mean?" {
		t.Errorf("element content = %q", got[0].Content())
	}
	if got[0].ID == "" || got[0].Attrs["id"] != got[0].ID {
		t.Errorf("element id not written on both sides: ID=%q Attrs[id]=%v", got[0].ID, got[0].Attrs["id"])
	}
}

// "doc" names the whole document, so it becomes a CONTAINER-grain element
// addressed at the document's own container. That element is what makes a
// question about the whole document observable afterwards.
func TestAIBlockMigrator_DocSentinelBecomesASelfAddressedContainerElement(t *testing.T) {
	got := migratedElements(t, map[string]interface{}{"question": "Why?", "ref": "doc"})
	if len(got) != 2 {
		t.Fatalf("got %d elements, want 2: %+v", len(got), got)
	}
	if got[0].Kind != "reference" {
		t.Fatalf("element 0 kind = %q, want reference", got[0].Kind)
	}
	if want := "sieve://" + aiDocUUID; got[0].Attrs["uri"] != want {
		t.Errorf("element 0 uri = %v, want the own-container address %q", got[0].Attrs["uri"], want)
	}
	if got[0].Attrs["rel"] != "target" {
		t.Errorf("element 0 rel = %v, want \"target\"", got[0].Attrs["rel"])
	}
	if _, hasFace := got[0].Attrs["cache"]; hasFace {
		t.Errorf("the whole-document target is bare; it grew a face: %v", got[0].Attrs["cache"])
	}
	if got[1].Kind != KindProse {
		t.Errorf("the question text must follow its target; element 1 is %q", got[1].Kind)
	}
}

// A "doc" token mixed into a comma list converts alongside the block ids, in
// place.
func TestAIBlockMigrator_DocSentinelInsideARefList(t *testing.T) {
	got := migratedElements(t, map[string]interface{}{"question": "Why?", "ref": aiTargetID + ", doc"})
	if len(got) != 3 {
		t.Fatalf("got %d elements, want 3: %+v", len(got), got)
	}
	if want := "sieve://" + aiDocUUID + "/" + aiTargetID; got[0].Attrs["uri"] != want {
		t.Errorf("element 0 uri = %v, want %q", got[0].Attrs["uri"], want)
	}
	if want := "sieve://" + aiDocUUID; got[1].Attrs["uri"] != want {
		t.Errorf("element 1 uri = %v, want %q", got[1].Attrs["uri"], want)
	}
}

// An empty ref is the DETACHED class — a question about nothing. It mints no
// target element, and that absence is what tells it from a question about the
// whole document.
func TestAIBlockMigrator_EmptyRefIsDetachedAndMintsNoTarget(t *testing.T) {
	for _, ref := range []string{"", "  ", " , "} {
		got := migratedElements(t, map[string]interface{}{"question": "Why?", "ref": ref})
		if len(got) != 1 || got[0].Kind != KindProse {
			t.Errorf("ref %q produced %d elements, want the prose element alone: %+v", ref, len(got), got)
		}
	}
}

func TestAIBlockMigrator_RefIdsBecomeBlockGrainReferenceElements(t *testing.T) {
	got := migratedElements(t, map[string]interface{}{
		"question": "Why?",
		"ref":      aiTargetID + ", " + aiTargetTwo,
	})
	if len(got) != 3 {
		t.Fatalf("got %d elements, want 3: %+v", len(got), got)
	}
	for i, want := range []string{
		"sieve://" + aiDocUUID + "/" + aiTargetID,
		"sieve://" + aiDocUUID + "/" + aiTargetTwo,
	} {
		if got[i].Kind != "reference" {
			t.Errorf("element %d kind = %q, want reference", i, got[i].Kind)
		}
		if got[i].Attrs["uri"] != want {
			t.Errorf("element %d uri = %v, want %q", i, got[i].Attrs["uri"], want)
		}
		if got[i].Attrs["rel"] != "target" {
			t.Errorf("element %d rel = %v, want \"target\"", i, got[i].Attrs["rel"])
		}
	}
	if got[2].Kind != KindProse {
		t.Errorf("the question text must follow its targets; element 2 is %q", got[2].Kind)
	}
}

func TestAIBlockMigrator_AttachmentsBecomeReferenceElements(t *testing.T) {
	got := migratedElements(t, map[string]interface{}{
		"question": "Compare these",
		"attachments": []interface{}{
			map[string]interface{}{"uri": "sieve://" + testAssetUUID, "title": "Auth Design"},
		},
	})
	if len(got) != 2 {
		t.Fatalf("got %d elements, want 2: %+v", len(got), got)
	}
	att := got[1]
	if att.Kind != "reference" {
		t.Fatalf("attachment element kind = %q", att.Kind)
	}
	if att.Attrs["uri"] != "sieve://"+testAssetUUID {
		t.Errorf("attachment element uri = %v", att.Attrs["uri"])
	}
	if att.Attrs["rel"] != "attach" {
		t.Errorf("attachment element rel = %v, want \"attach\"", att.Attrs["rel"])
	}
	face, _ := att.Attrs["cache"].(map[string]interface{})
	if face["title"] != "Auth Design" {
		t.Errorf("the attached title was not kept as the element's face: %+v", att.Attrs["cache"])
	}
}

// Conversion consumes what it reads: the list is the record now, and the attrs
// it was built from must not survive to be read again.
func TestAIBlockMigrator_ConsumedAttrsAreRemoved(t *testing.T) {
	out, _ := AIBlockMigrator{}.Migrate([]SieveBlock{aiBlock(map[string]interface{}{
		"question":    "Why?",
		"ref":         aiTargetID,
		"attachments": []interface{}{map[string]interface{}{"uri": "sieve://" + testAssetUUID}},
	})}, aiDocUUID)

	for _, key := range []string{"ref", "attachments"} {
		if _, ok := out[0].Attrs[key]; ok {
			t.Errorf("%q survived conversion: %v", key, out[0].Attrs[key])
		}
	}
	if _, isString := out[0].Attrs[QuestionAttr].(string); isString {
		t.Error("the question string survived conversion")
	}
}

// The input tree is never mutated: undo and the caller's snapshot depend on it.
func TestAIBlockMigrator_DoesNotMutateInput(t *testing.T) {
	in := []SieveBlock{aiBlock(map[string]interface{}{"question": "Why?", "ref": aiTargetID})}
	AIBlockMigrator{}.Migrate(in, aiDocUUID)
	if in[0].Attrs["question"] != "Why?" || in[0].Attrs["ref"] != aiTargetID {
		t.Errorf("the input record was rewritten in place: %+v", in[0].Attrs)
	}
}

// A record showing BOTH forms cannot be reconciled without guessing which one
// the author meant, so it is left exactly as stored.
func TestAIBlockMigrator_BothFormsAreLeftAsStored(t *testing.T) {
	elements := Elements{NewSieveBlock(KindProse, "", map[string]interface{}{"content": "current"})}
	in := aiBlock(map[string]interface{}{"ref": aiTargetID})
	in.SetElements(QuestionAttr, elements)

	out, changed := AIBlockMigrator{}.Migrate([]SieveBlock{in}, aiDocUUID)
	if changed {
		t.Fatal("changed = true for an incoherent record")
	}
	if out[0].Attrs["ref"] != aiTargetID {
		t.Errorf("the legacy ref was consumed anyway: %v", out[0].Attrs["ref"])
	}
	if got := DecodeElements(out[0].Attrs[QuestionAttr]); len(got) != 1 || got[0].Content() != "current" {
		t.Errorf("the stored list was disturbed: %+v", got)
	}
}

// A record carrying NEITHER form has no question to convert, and one is never
// invented for it.
func TestAIBlockMigrator_NeitherFormIsLeftAsStored(t *testing.T) {
	in := []SieveBlock{aiBlock(map[string]interface{}{"question": "", "ref": "", "type": "ASK"})}
	out, changed := AIBlockMigrator{}.Migrate(in, aiDocUUID)
	if changed {
		t.Fatal("changed = true for a record with no question at all")
	}
	if got := out[0].Attrs[QuestionAttr]; got != "" {
		t.Errorf("question = %v, want the stored empty string", got)
	}
}

// A record already in the current form is clean: a second load must not report a
// change, or every open would rewrite the document.
func TestAIBlockMigrator_CurrentFormIsUnchanged(t *testing.T) {
	out, _ := AIBlockMigrator{}.Migrate([]SieveBlock{aiBlock(map[string]interface{}{
		"question": "Why?", "ref": aiTargetID,
	})}, aiDocUUID)
	if _, changed := (AIBlockMigrator{}).Migrate(out, aiDocUUID); changed {
		t.Fatal("a converted record reported changed = true on the next load")
	}
}

// `ref` is the generic edge every other kind still uses; only the ai-block stops
// reading it.
func TestAIBlockMigrator_LeavesOtherKindsAlone(t *testing.T) {
	in := []SieveBlock{{ID: "wc-1", Kind: "web-clip", Attrs: map[string]interface{}{
		"id": "wc-1", "ref": aiTargetID, "question": "Why?",
	}}}
	out, changed := AIBlockMigrator{}.Migrate(in, aiDocUUID)
	if changed {
		t.Fatal("changed = true for a tree with no ai-block in it")
	}
	if out[0].Attrs["ref"] != aiTargetID {
		t.Errorf("a web-clip's ref was consumed: %v", out[0].Attrs["ref"])
	}
}

// The step runs LAST in the pipeline, so the addresses it copies into elements
// are the ones ReferenceMigrator already rewrote, and the ids it turns into leaf
// addresses are the uuids BlockIdentityMigrator already assigned.
func TestDocumentMigrator_RunsAIBlockStepAfterTheReferenceStep(t *testing.T) {
	in := []SieveBlock{
		{ID: "pr-target", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-target", "content": "target"}},
		aiBlock(map[string]interface{}{
			"question":    "Why?",
			"ref":         "pr-target",
			"attachments": []interface{}{map[string]interface{}{"uri": "container:" + testAssetUUID}},
		}),
	}
	out, changed := DocumentMigrator{}.Migrate(in, aiDocUUID)
	if !changed {
		t.Fatal("changed = false")
	}
	got := DecodeElements(out[1].Attrs[QuestionAttr])
	if len(got) != 3 {
		t.Fatalf("got %d elements, want 3: %+v", len(got), got)
	}
	if want := "sieve://" + aiDocUUID + "/" + out[0].ID; got[0].Attrs["uri"] != want {
		t.Errorf("the ref element names %v, want the upgraded id %q", got[0].Attrs["uri"], want)
	}
	if want := "sieve://" + testAssetUUID; got[2].Attrs["uri"] != want {
		t.Errorf("the attachment element names %v, want the rewritten address %q", got[2].Attrs["uri"], want)
	}
}

// migratedAnswer runs the migrator over one ai-block and returns its answer
// elements, failing the test when the record was not converted.
func migratedAnswer(t *testing.T, attrs map[string]interface{}) Elements {
	t.Helper()
	out, changed := AIBlockMigrator{}.Migrate([]SieveBlock{aiBlock(attrs)}, aiDocUUID)
	if !changed {
		t.Fatalf("changed = false for a legacy record: %+v", attrs)
	}
	got := DecodeElements(out[0].Attrs[AnswerAttr])
	if len(got) == 0 {
		t.Fatalf("conversion produced no answer elements: %+v", out[0].Attrs)
	}
	return got
}

// The answer was one string, so it becomes one prose element — the same fold
// every producer's raw reply takes, applied once on the load path.
func TestAIBlockMigrator_ResponseStringBecomesAProseElement(t *testing.T) {
	got := migratedAnswer(t, map[string]interface{}{"response": "Because chlorophyll."})
	if len(got) != 1 {
		t.Fatalf("got %d elements, want 1: %+v", len(got), got)
	}
	if got[0].Kind != KindProse {
		t.Errorf("element kind = %q, want %q", got[0].Kind, KindProse)
	}
	if got[0].Content() != "Because chlorophyll." {
		t.Errorf("element content = %q", got[0].Content())
	}
	if got[0].ID == "" || got[0].Attrs["id"] != got[0].ID {
		t.Errorf("element id not written on both sides: ID=%q Attrs[id]=%v", got[0].ID, got[0].Attrs["id"])
	}
}

// Only blankness is measured; the answer itself is carried verbatim, because an
// answer's leading whitespace is markdown a trim would change.
func TestAIBlockMigrator_ResponseIsCarriedVerbatim(t *testing.T) {
	const padded = "\n    indented code\n\ntrailing\n"
	if got := migratedAnswer(t, map[string]interface{}{"response": padded}); got[0].Content() != padded {
		t.Errorf("element content = %q, want the string verbatim", got[0].Content())
	}
}

// Conversion consumes what it reads on the answer side too.
func TestAIBlockMigrator_ConsumedResponseIsRemoved(t *testing.T) {
	out, _ := AIBlockMigrator{}.Migrate([]SieveBlock{aiBlock(map[string]interface{}{
		"response": "an answer",
	})}, aiDocUUID)
	if v, ok := out[0].Attrs["response"]; ok {
		t.Errorf("`response` survived conversion: %v", v)
	}
}

// An empty response is no answer, so there is nothing to convert and nothing is
// invented — and a record carrying only one is not dirtied by a load.
func TestAIBlockMigrator_EmptyResponseConvertsNothing(t *testing.T) {
	for _, response := range []string{"", "   \n "} {
		in := []SieveBlock{aiBlock(map[string]interface{}{"response": response, "type": "ASK"})}
		out, changed := AIBlockMigrator{}.Migrate(in, aiDocUUID)
		if changed {
			t.Fatalf("changed = true for response %q", response)
		}
		if _, ok := out[0].Attrs[AnswerAttr]; ok {
			t.Errorf("an answer was invented for response %q", response)
		}
	}
}

// A record showing BOTH answer forms is left exactly as stored, for the reason
// the question side is: the two cannot be reconciled without guessing.
func TestAIBlockMigrator_BothAnswerFormsAreLeftAsStored(t *testing.T) {
	in := aiBlock(map[string]interface{}{"response": "the legacy one"})
	in.SetElements(AnswerAttr, Elements{NewSieveBlock(KindProse, "", map[string]interface{}{"content": "current"})})

	out, changed := AIBlockMigrator{}.Migrate([]SieveBlock{in}, aiDocUUID)
	if changed {
		t.Fatal("changed = true for an incoherent record")
	}
	if out[0].Attrs["response"] != "the legacy one" {
		t.Errorf("the legacy response was consumed anyway: %v", out[0].Attrs["response"])
	}
	if got := DecodeElements(out[0].Attrs[AnswerAttr]); len(got) != 1 || got[0].Content() != "current" {
		t.Errorf("the stored list was disturbed: %+v", got)
	}
}

// THE TWO SLOTS CONVERT INDEPENDENTLY. A record half-converted by an earlier
// load — a current question beside a legacy response — still has its answer
// folded, and the question it already holds is not disturbed.
func TestAIBlockMigrator_ASlotAlreadyConvertedDoesNotBlockTheOther(t *testing.T) {
	in := aiBlock(map[string]interface{}{"response": "an answer"})
	in.SetElements(QuestionAttr, Elements{NewSieveBlock(KindProse, "", map[string]interface{}{"content": "why?"})})

	out, changed := AIBlockMigrator{}.Migrate([]SieveBlock{in}, aiDocUUID)
	if !changed {
		t.Fatal("changed = false: the legacy answer was not converted")
	}
	if got := DecodeElements(out[0].Attrs[QuestionAttr]); len(got) != 1 || got[0].Content() != "why?" {
		t.Errorf("the stored question was disturbed: %+v", got)
	}
	if got := DecodeElements(out[0].Attrs[AnswerAttr]); len(got) != 1 || got[0].Content() != "an answer" {
		t.Errorf("answer = %+v, want the folded legacy response", got)
	}
}

// A converted record is clean: a second load must not report a change, or every
// open would rewrite the document.
func TestAIBlockMigrator_ConvertedAnswerIsUnchangedOnTheNextLoad(t *testing.T) {
	out, _ := AIBlockMigrator{}.Migrate([]SieveBlock{aiBlock(map[string]interface{}{
		"question": "Why?", "ref": aiTargetID, "response": "because",
	})}, aiDocUUID)
	if _, changed := (AIBlockMigrator{}).Migrate(out, aiDocUUID); changed {
		t.Fatal("a converted record reported changed = true on the next load")
	}
}

// The input tree is never mutated on the answer side either.
func TestAIBlockMigrator_DoesNotMutateInputOnTheAnswerSide(t *testing.T) {
	in := []SieveBlock{aiBlock(map[string]interface{}{"response": "an answer"})}
	AIBlockMigrator{}.Migrate(in, aiDocUUID)
	if in[0].Attrs["response"] != "an answer" {
		t.Errorf("the input record was rewritten in place: %+v", in[0].Attrs)
	}
	if _, ok := in[0].Attrs[AnswerAttr]; ok {
		t.Errorf("the input record grew an answer list: %+v", in[0].Attrs)
	}
}
