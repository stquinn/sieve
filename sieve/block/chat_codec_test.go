package block

import (
	"strings"
	"testing"

	"sieve/sieve/domain"
)

// chatExchange is an ai-block asking question, answered with answer when it is
// not "".
func chatExchange(question, answer string) domain.SieveBlock {
	b := domain.NewSieveBlock(KindAIBlock, "", map[string]interface{}{"status": BlockStatusComplete, "type": "ASK"})
	b.SetElements(QuestionAttr, domain.Elements{domain.NewSieveBlock(KindProse, "", map[string]interface{}{"content": question})})
	if answer != "" {
		b.SetElements(AnswerAttr, domain.Elements{domain.NewSieveBlock(KindProse, "", map[string]interface{}{"content": answer})})
	}
	return b
}

func TestChatCodec_RoundTripKeepsOrder(t *testing.T) {
	codec := NewChatCodec(GlobalRegistry())
	for _, tc := range []struct {
		name      string
		exchanges []domain.SieveBlock
	}{
		{"empty", nil},
		{"one unanswered", []domain.SieveBlock{chatExchange("What is a chat?", "")}},
		{"three in order", []domain.SieveBlock{
			chatExchange("first", "one"),
			chatExchange("second\nover two lines", "two"),
			chatExchange("third", ""),
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, err := codec.Encode(tc.exchanges)
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			if !strings.HasPrefix(string(body), "kind: chat\n") {
				t.Errorf("body does not open kind: chat:\n%s", body)
			}
			for _, banned := range []string{"```", "---"} {
				if strings.Contains(string(body), banned) {
					t.Errorf("body holds %q:\n%s", banned, body)
				}
			}
			decoded, err := codec.Decode(body)
			if err != nil {
				t.Fatalf("Decode: %v\n%s", err, body)
			}
			if len(decoded) != len(tc.exchanges) {
				t.Fatalf("decoded %d exchanges, want %d", len(decoded), len(tc.exchanges))
			}
			for i, want := range tc.exchanges {
				got := decoded[i]
				question := got.Elements(QuestionAttr)
				if got.ID != want.ID || got.Kind != KindAIBlock || len(question) != 1 ||
					question[0].Content() != want.Elements(QuestionAttr)[0].Content() {
					t.Errorf("exchange %d = %+v, want %+v", i, got, want)
				}
			}
			again, err := codec.Encode(decoded)
			if err != nil {
				t.Fatalf("re-Encode: %v", err)
			}
			if string(again) != string(body) {
				t.Errorf("a second write differs:\n%s\nwant:\n%s", again, body)
			}
		})
	}
}

func TestChatCodec_Refuses(t *testing.T) {
	codec := NewChatCodec(GlobalRegistry())
	prose := domain.NewSieveBlock(KindProse, "", map[string]interface{}{"content": "not an exchange"})
	if _, err := codec.Encode([]domain.SieveBlock{chatExchange("q", ""), prose}); err == nil {
		t.Error("Encode accepted a prose block as an exchange")
	}
	for name, body := range map[string]string{
		"another kind":       "kind: block\nexchanges: []\n",
		"kind not first":     "exchanges: []\nkind: chat\n",
		"no kind":            "exchanges: []\n",
		"markdown":           "# A heading\n\nSome prose.\n",
		"frontmatter":        "---\nkind: chat\n---\nexchanges: []\n",
		"an unknown key":     "kind: chat\nexchanges: []\nmore: x\n",
		"exchanges a map":    "kind: chat\nexchanges:\n    id: x\n",
		"an exchange a word": "kind: chat\nexchanges:\n    - x\n",
	} {
		if _, err := codec.Decode([]byte(body)); err == nil {
			t.Errorf("%s: Decode accepted %q", name, body)
		}
	}
}
