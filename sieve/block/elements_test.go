package block

import "testing"

// THE ENCODING A PRODUCER BELOW THE WALL HAS TO SPELL BY HAND. `sieve/ai` sits
// BELOW `sieve/block` in the package DAG — block holds a concrete *ai.AIService,
// so ai can never import block — and its popup commands still mint an answer
// list. They write these words as literals (sieve/ai/popup_answer.go); this
// is what the literals have to equal, and where a rename here is caught.
func TestElements_TheVocabularyAProducerSpellsByHand(t *testing.T) {
	for _, tc := range []struct{ name, got, want string }{
		{"answer slot", AnswerAttr, "answer"},
		{"question slot", QuestionAttr, "question"},
		{"prose kind", KindProse, "prose"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s = %q, want %q — sieve/ai/popup_answer.go spells it %q", tc.name, tc.got, tc.want, tc.want)
		}
	}
}
