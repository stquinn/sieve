package block

import (
	"encoding/json"
	"testing"

	"sieve/sieve/fencedblock"
)

// elementFixture builds a two-element list — one of each shape an element takes:
// a payload-in-attrs prose element and an address-only reference element.
func elementFixture() Elements {
	return Elements{
		NewSieveBlock(KindProse, "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01", map[string]interface{}{
			"content": "What does this mean?",
		}),
		NewSieveBlock("reference", "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02", map[string]interface{}{
			"uri": "sieve://0197b1f4-1111-7222-8333-444455556666/0197b1f4-2222-7222-8333-444455556666",
			"rel": "target",
		}),
	}
}

// The list survives the fenced YAML round trip a parent block persists through,
// element kinds, ids and payloads intact.
func TestElements_RoundTripThroughFencedYAML(t *testing.T) {
	parent := SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-1"}}
	parent.SetElements(QuestionAttr, elementFixture())

	body, err := fencedblock.SerializeYaml(parent.Attrs)
	if err != nil {
		t.Fatalf("SerializeYaml: %v", err)
	}
	parsed, err := fencedblock.DeserializeYaml(body)
	if err != nil {
		t.Fatalf("DeserializeYaml: %v", err)
	}

	got := DecodeElements(parsed[QuestionAttr])
	want := elementFixture()
	if len(got) != len(want) {
		t.Fatalf("round trip returned %d elements, want %d\n%s", len(got), len(want), body)
	}
	for i := range want {
		if got[i].Kind != want[i].Kind {
			t.Errorf("element %d kind = %q, want %q", i, got[i].Kind, want[i].Kind)
		}
		if got[i].ID != want[i].ID {
			t.Errorf("element %d id = %q, want %q", i, got[i].ID, want[i].ID)
		}
		if got[i].Attrs["id"] != want[i].ID {
			t.Errorf("element %d Attrs[id] = %v, want %q", i, got[i].Attrs["id"], want[i].ID)
		}
	}
	if got[0].Content() != "What does this mean?" {
		t.Errorf("prose element content = %q", got[0].Content())
	}
	if got[1].Attrs["uri"] != want[1].Attrs["uri"] {
		t.Errorf("reference element uri = %v", got[1].Attrs["uri"])
	}
}

// A parent holding the typed list and a parent holding the same list as it came
// off disk must persist to the SAME bytes, or every second save rewrites the
// document.
func TestElements_TypedAndDecodedFormsSerializeIdentically(t *testing.T) {
	parent := SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-1"}}
	parent.SetElements(QuestionAttr, elementFixture())

	first, err := fencedblock.SerializeYaml(parent.Attrs)
	if err != nil {
		t.Fatalf("SerializeYaml: %v", err)
	}
	fromDisk, err := fencedblock.DeserializeYaml(first)
	if err != nil {
		t.Fatalf("DeserializeYaml: %v", err)
	}
	second, err := fencedblock.SerializeYaml(fromDisk)
	if err != nil {
		t.Fatalf("SerializeYaml (second): %v", err)
	}
	if first != second {
		t.Errorf("serialization is not stable across a round trip:\nfirst:\n%s\nsecond:\n%s", first, second)
	}
}

// Element content is user text and may hold a fence of its own. The 4-space
// literal-block discipline must keep it inside the parent's fence.
func TestElements_MultilineContentCannotCloseTheFence(t *testing.T) {
	parent := SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-1"}}
	parent.SetElements(QuestionAttr, Elements{
		NewSieveBlock(KindProse, "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01", map[string]interface{}{
			"content": "Why does this fail?\n\n```go\nfunc main() {}\n```\n",
		}),
	})

	body, err := fencedblock.SerializeYaml(parent.Attrs)
	if err != nil {
		t.Fatalf("SerializeYaml: %v", err)
	}
	for _, line := range splitLines(body) {
		if len(line) >= 3 && line[:3] == "```" {
			t.Fatalf("a line closes the parent fence at column zero:\n%s", body)
		}
	}
	parsed, err := fencedblock.DeserializeYaml(body)
	if err != nil {
		t.Fatalf("DeserializeYaml: %v", err)
	}
	got := DecodeElements(parsed[QuestionAttr])
	if len(got) != 1 || got[0].Content() != "Why does this fail?\n\n```go\nfunc main() {}\n```\n" {
		t.Errorf("fenced content did not round-trip verbatim: %q", got[0].Content())
	}
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}

// An element's attrs ARE the parent's, whether the list arrived typed or
// straight off disk, so a write through one lands on the parent.
func TestSieveBlock_ElementAttrsAreTheParents(t *testing.T) {
	for _, tc := range []struct {
		name  string
		attrs map[string]interface{}
	}{
		{"typed", map[string]interface{}{"id": "ai-1", QuestionAttr: elementFixture()}},
		{"decoded", map[string]interface{}{"id": "ai-1", QuestionAttr: elementFixture().attrValue()}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: tc.attrs}
			children := parent.Elements(QuestionAttr)
			if len(children) != 2 {
				t.Fatalf("Elements returned %d children, want 2", len(children))
			}
			children[0].Attrs["content"] = "edited"
			if got := parent.Elements(QuestionAttr)[0].Content(); got != "edited" {
				t.Errorf("mutation through the returned pointer was lost: content = %q", got)
			}
		})
	}
}

// An entry that arrives without an id is minted one AT THE PARENT, so a second
// read answers the same element and writes through it still land. A per-read
// mint would hand back a throwaway copy and a new identity every time.
func TestSieveBlock_IdlessElementIsMintedInPlace(t *testing.T) {
	for _, tc := range []struct {
		name  string
		entry map[string]interface{}
	}{
		{"attrs without an id", map[string]interface{}{
			elementKindKey:  KindProse,
			elementAttrsKey: map[string]interface{}{"content": "orphan"},
		}},
		{"no attrs at all", map[string]interface{}{elementKindKey: KindProse}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parent := SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{
				"id":         "ai-1",
				QuestionAttr: []interface{}{tc.entry},
			}}

			first := parent.Elements(QuestionAttr)
			if len(first) != 1 {
				t.Fatalf("Elements returned %d children, want 1", len(first))
			}
			if first[0].ID == "" {
				t.Fatal("no id was minted")
			}
			if first[0].Attrs["id"] != first[0].ID {
				t.Errorf("the minted id landed on one side only: ID=%q Attrs[id]=%v", first[0].ID, first[0].Attrs["id"])
			}

			if second := parent.Elements(QuestionAttr); second[0].ID != first[0].ID {
				t.Errorf("a second read minted a different id: %q then %q", first[0].ID, second[0].ID)
			}

			first[0].Attrs["content"] = "edited"
			if got := parent.Elements(QuestionAttr)[0].Content(); got != "edited" {
				t.Errorf("the write did not reach the stored payload: content = %q", got)
			}
		})
	}
}

func TestSieveBlock_ElementsOfAChildlessBlock(t *testing.T) {
	parent := SieveBlock{ID: "pr-1", Kind: KindProse}
	if got := parent.Elements(QuestionAttr); got != nil {
		t.Errorf("a block with no attrs returned %v", got)
	}
}

// An empty list REMOVES the key: absent is the empty case, as it is for
// attachments.
func TestSieveBlock_SetElementsEmptyRemovesTheKey(t *testing.T) {
	parent := SieveBlock{ID: "ai-1", Kind: "ai-block", Attrs: map[string]interface{}{"id": "ai-1"}}
	parent.SetElements(QuestionAttr, elementFixture())
	parent.SetElements(QuestionAttr, nil)
	if _, ok := parent.Attrs[QuestionAttr]; ok {
		t.Error("an empty list left the key behind")
	}
}

// The wire sees the same encoding disk does — one element shape, whichever
// carrier moves it.
func TestElements_JSONMatchesThePersistedEncoding(t *testing.T) {
	raw, err := json.Marshal(elementFixture())
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var decoded []interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	got := DecodeElements(decoded)
	if len(got) != 2 || got[0].Kind != KindProse || got[1].Kind != "reference" {
		t.Fatalf("JSON round trip lost the element shapes: %s", raw)
	}
	if got[0].ID != "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01" {
		t.Errorf("JSON round trip lost the element id: %q", got[0].ID)
	}
}

func TestDecodeElements_DropsEntriesWithNoKind(t *testing.T) {
	got := DecodeElements([]interface{}{
		map[string]interface{}{"attrs": map[string]interface{}{"content": "orphan"}},
		"not an element",
		map[string]interface{}{"kind": KindProse, "attrs": map[string]interface{}{"content": "kept"}},
	})
	if len(got) != 1 || got[0].Content() != "kept" {
		t.Fatalf("DecodeElements kept an unusable entry: %+v", got)
	}
}

// THE ENCODING A PRODUCER BELOW THE WALL HAS TO SPELL BY HAND. `sieve/ai` sits
// BELOW `sieve/block` in the package DAG — block holds a concrete *ai.AIService,
// so ai can never import block — and its popup commands still mint an answer
// list. They write these four words as literals (sieve/ai/popup_answer.go); this
// is what the literals have to equal, and where a rename here is caught.
func TestElements_TheVocabularyAProducerSpellsByHand(t *testing.T) {
	for _, tc := range []struct{ name, got, want string }{
		{"answer slot", AnswerAttr, "answer"},
		{"question slot", QuestionAttr, "question"},
		{"prose kind", KindProse, "prose"},
		{"entry kind key", elementKindKey, "kind"},
		{"entry attrs key", elementAttrsKey, "attrs"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q — sieve/ai/popup_answer.go spells it %q", tc.name, tc.got, tc.want, tc.want)
		}
	}
}
