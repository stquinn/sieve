package processors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// The chat showcase is a REAL CHAT in store form — a chat directory holding a
// .meta and its {uuid}.chat — hand-authored to hold what the chat lens is judged
// against: a plain exchange; a rich question (prose, a pasted code block, an
// attachment) answered richly (prose with inline code, a code block, a cited
// reference); an exchange whose job failed; and, last, one still pending. Tests
// read it through the chat codec, the JS suites read the same file
// (frontend/test/helpers/chat-showcase.js), and TestChatShowcase_SeedsAStore
// writes it into a store as a chat of its own.
const (
	chatShowcaseDir   = "testdata/chat-showcase"
	chatShowcaseUUID  = "0198c1a0-0002-7000-8000-000000000001"
	chatShowcaseTitle = "Parser error taxonomy"
	// chatShowcaseStoreEnv names the store directory TestChatShowcase_SeedsAStore
	// writes the showcase into; the test is skipped while it is unset.
	chatShowcaseStoreEnv = "SIEVE_SHOWCASE_STORE"
)

// loadChatShowcase returns the showcase's content file and the exchanges the
// chat codec reads out of it.
func loadChatShowcase(t *testing.T) ([]byte, []domain.SieveBlock) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(chatShowcaseDir, chatShowcaseUUID+".chat"))
	if err != nil {
		t.Fatalf("read showcase chat: %v", err)
	}
	exchanges, err := block.NewChatCodec(block.GlobalRegistry()).Decode(body)
	if err != nil {
		t.Fatalf("decode showcase chat: %v", err)
	}
	return body, exchanges
}

// The chat is in canonical form, and holds the four exchanges the lens is judged
// against, each with the question and the answer its part calls for.
func TestChatShowcase_HoldsTheFourExchangesInCanonicalForm(t *testing.T) {
	registerShowcaseKinds(t)
	body, exchanges := loadChatShowcase(t)

	again, err := block.NewChatCodec(block.GlobalRegistry()).Encode(exchanges)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if string(again) != string(body) {
		t.Fatalf("the chat is not in canonical form:\n--- on disk ---\n%s\n--- encoded ---\n%s", body, again)
	}

	kinds := func(els []*domain.SieveBlock) string {
		var out []string
		for _, el := range els {
			out = append(out, el.Kind)
		}
		return strings.Join(out, ",")
	}
	want := []struct{ status, question, answer string }{
		{block.BlockStatusComplete, "prose", "prose"},
		{block.BlockStatusComplete, "prose,code,reference", "prose,code,reference"},
		{"ERROR", "prose", ""},
		{block.BlockStatusPending, "prose", ""},
	}
	if len(exchanges) != len(want) {
		t.Fatalf("the chat holds %d exchanges, want %d", len(exchanges), len(want))
	}
	for i, w := range want {
		x := exchanges[i]
		if x.Kind != block.KindAIBlock || x.Status() != w.status {
			t.Errorf("exchange %d is a %s %s, want an %s %s", i, x.Status(), x.Kind, w.status, block.KindAIBlock)
		}
		if got := kinds(x.Elements(block.QuestionAttr)); got != w.question {
			t.Errorf("exchange %d question = %s, want %s", i, got, w.question)
		}
		if got := kinds(x.Elements(block.AnswerAttr)); got != w.answer {
			t.Errorf("exchange %d answer = %s, want %s", i, got, w.answer)
		}
		if x.StringAttr("createdAt") == "" {
			t.Errorf("exchange %d carries no time it was asked", i)
		}
		if answered := x.StringAttr("completedAt") != ""; answered != (w.status == block.BlockStatusComplete) {
			t.Errorf("exchange %d is %s and carries a completion time: %v", i, x.Status(), answered)
		}
	}
	if exchanges[2].StringAttr("error") == "" {
		t.Error("the failed exchange says nothing of why")
	}
	rich := exchanges[1]
	if attach := rich.Elements(block.QuestionAttr)[2]; attach.StringAttr("rel") != block.RelAttach || attach.FaceString("title") == "" {
		t.Errorf("the rich question's reference is not a titled attachment: %+v", attach.Attrs)
	}
	if prose := rich.Elements(block.AnswerAttr)[0].Content(); !strings.Contains(prose, "`Recoverable`") {
		t.Errorf("the rich answer's prose carries no inline code: %q", prose)
	}
	if cite := rich.Elements(block.AnswerAttr)[2]; cite.StringAttr("uri") == "" || cite.FaceString("title") == "" {
		t.Errorf("the rich answer's citation lost its address or its face: %+v", cite.Attrs)
	}

	meta, err := os.ReadFile(filepath.Join(chatShowcaseDir, ".meta"))
	if err != nil {
		t.Fatalf("read showcase meta: %v", err)
	}
	var m struct {
		UUID        string            `json:"uuid"`
		Type        string            `json:"type"`
		DisplayName string            `json:"display_name"`
		Extra       map[string]string `json:"extra"`
	}
	if err := json.Unmarshal(meta, &m); err != nil {
		t.Fatalf("parse showcase meta: %v", err)
	}
	if m.UUID != chatShowcaseUUID || m.Type != domain.ChatKind || m.DisplayName != chatShowcaseTitle || m.Extra[domain.MetaKeyNamedBy] != domain.MetaNamedByHand {
		t.Errorf("the meta does not name the showcase chat: %+v", m)
	}
}

// Writes the showcase into the store at $SIEVE_SHOWCASE_STORE as a new chat
// called chatShowcaseTitle, through the chat service, so a store seeded with it
// opens the showcase in the app. Skipped while the variable is unset.
func TestChatShowcase_SeedsAStore(t *testing.T) {
	root := os.Getenv(chatShowcaseStoreEnv)
	if root == "" {
		t.Skipf("%s is unset: no store to seed", chatShowcaseStoreEnv)
	}
	registerShowcaseKinds(t)
	_, exchanges := loadChatShowcase(t)

	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("store directory: %v", err)
	}
	host, err := os.Hostname()
	if err != nil {
		t.Fatalf("hostname: %v", err)
	}
	st, err := filestore.NewFileStore(root, host)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	chats, err := services.NewChatService(st, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	chat, err := chats.Create(chatShowcaseTitle)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	chat.SetExchanges(exchanges)
	saved, err := chats.Save(chat)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	t.Logf("seeded the showcase chat %q as %s in %s", saved.Name(), saved.UUID(), st.Root())
}
