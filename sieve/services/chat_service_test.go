package services_test

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// newTestChats builds the chat service over a temporary store and the real codec.
func newTestChats(t *testing.T) (*services.ChatService, *filestore.FileStore) {
	t.Helper()
	st, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	chats, err := services.NewChatService(st, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	return chats, st
}

// askedChat is an ai-block whose question is one prose element holding question.
func askedChat(question string) domain.SieveBlock {
	b := domain.NewSieveBlock(block.KindAIBlock, "", map[string]interface{}{"status": "pending"})
	b.SetElements(block.QuestionAttr, domain.Elements{domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": question})})
	return b
}

func TestChatService_CreateSaveLoadDelete(t *testing.T) {
	chats, st := newTestChats(t)

	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	uuid := c.UUID()
	if len(c.Exchanges()) != 0 || c.Title() != "" {
		t.Fatalf("created = %+v", c.Exchanges())
	}
	first, second := askedChat("What is a chat?"), askedChat("And an exchange?")
	c.SetExchanges([]domain.SieveBlock{first, second})
	saved, err := chats.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := chats.SaveAsset(saved, "page.html", []byte("<p>fetched</p>")); err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}

	dir, _ := st.DocDirByUUID(uuid)
	for _, name := range []string{uuid + ".chat", ".history/" + uuid + ".1.chat", "page.html"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("expected %s on disk: %v", name, err)
		}
	}
	if rel, _ := filepath.Rel(st.Root(), dir); !strings.HasPrefix(rel, domain.Chats.Key+string(filepath.Separator)) {
		t.Errorf("chat lives at %s, want under %s", rel, domain.Chats.Key)
	}

	fresh, err := filestore.NewFileStore(st.Root(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	reopened, err := services.NewChatService(fresh, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	loaded, err := reopened.Load(uuid)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	got := loaded.Exchanges()
	if len(got) != 2 || got[0].ID != first.ID || got[1].ID != second.ID {
		t.Fatalf("exchanges = %+v, want the two in order", got)
	}
	if loaded.Name() != "What is a chat?" {
		t.Errorf("Name = %q, want the first question", loaded.Name())
	}
	if assets := loaded.Assets(); len(assets) != 1 || assets[0].Key() != "page.html" {
		t.Fatalf("assets = %v, want only page.html", assets)
	}
	if asset, err := reopened.LoadAsset(loaded, "page.html"); err != nil || string(asset.Body()) != "<p>fetched</p>" {
		t.Fatalf("LoadAsset = %v, %v", asset, err)
	}
	if err := reopened.DeleteAsset(loaded, "page.html"); err != nil {
		t.Fatalf("DeleteAsset: %v", err)
	}

	if err := reopened.Delete(loaded); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := reopened.Load(uuid); !errors.Is(err, domain.ErrNotChat) {
		t.Errorf("Load after Delete: %v, want ErrNotChat", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("directory survives Delete: %v", err)
	}
}

func TestChatService_SaveRefusesAnExchangeThatIsNotAnAIBlock(t *testing.T) {
	chats, _ := newTestChats(t)
	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	c.SetExchanges([]domain.SieveBlock{domain.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": "prose"})})
	if _, err := chats.Save(c); err == nil {
		t.Fatal("Save accepted a prose exchange")
	}
	loaded, err := chats.Load(c.UUID())
	if err != nil || len(loaded.Exchanges()) != 0 || loaded.Version() != c.Version() {
		t.Errorf("a refused save wrote: %v, %v", loaded, err)
	}
}

func TestChatService_LoadNamesOnlyChats(t *testing.T) {
	chats, st := newTestChats(t)
	containers, err := services.NewBlockContainerService(st, block.GlobalRegistry())
	if err != nil {
		t.Fatalf("NewBlockContainerService: %v", err)
	}
	block.ResetRegistry()
	block.RegisterProcessor(stickyProc{FencedDeserializer: block.FencedDeserializer{Kind: stickyKind}})
	t.Cleanup(block.ResetRegistry)
	container, err := containers.Create(stickyKind, nil)
	if err != nil {
		t.Fatalf("Create container: %v", err)
	}
	for name, uuid := range map[string]string{"nothing": missingUUID, "a block container": container.UUID()} {
		if _, err := chats.Load(uuid); !errors.Is(err, domain.ErrNotChat) {
			t.Errorf("%s: err = %v, want ErrNotChat", name, err)
		}
	}

	broken, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	dir, _ := st.DocDirByUUID(broken.UUID())
	if err := os.WriteFile(filepath.Join(dir, broken.UUID()+".chat"), []byte("kind: block\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fresh, err := filestore.NewFileStore(st.Root(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	reopened, err := services.NewChatService(fresh, block.NewChatCodec(block.GlobalRegistry()))
	if err != nil {
		t.Fatalf("NewChatService: %v", err)
	}
	if _, err := reopened.Load(broken.UUID()); err == nil || errors.Is(err, domain.ErrNotChat) {
		t.Errorf("a broken body: err = %v, want a parse error and not ErrNotChat", err)
	}
}

func TestChatService_Name(t *testing.T) {
	chats, _ := newTestChats(t)
	for _, tc := range []struct {
		name, title string
		questions   []string
		want        string
	}{
		{"a title wins", "Planning", []string{"What next?"}, "Planning"},
		{"the first question", "", []string{"What next?", "And after?"}, "What next?"},
		{"its opening words", "", []string{"one two three four five six seven eight nine ten"}, "one two three four five six seven eight…"},
		{"no exchange", "", nil, "Untitled chat"},
		{"a question with no words", "", []string{"  "}, "Untitled chat"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := chats.Create(tc.title)
			if err != nil {
				t.Fatalf("Create: %v", err)
			}
			var asked []domain.SieveBlock
			for _, q := range tc.questions {
				asked = append(asked, askedChat(q))
			}
			c.SetExchanges(asked)
			if got := c.Name(); got != tc.want {
				t.Errorf("Name = %q, want %q", got, tc.want)
			}
		})
	}
}

// A tab that shows a chat is named by the chat as stored now; every other tab, and a tab of a chat
// that no longer loads, is left as it was, and the input is not mutated.
func TestChatService_RefreshTabNames(t *testing.T) {
	chats, _ := newTestChats(t)
	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	c.SetExchanges([]domain.SieveBlock{askedChat("What next?")})
	saved, err := chats.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	in := []domain.Tab{
		{ID: saved.UUID(), Kind: domain.ChatKind, DisplayName: "Untitled chat"},
		{ID: "gone", Kind: domain.ChatKind, DisplayName: "Gone"},
		{ID: "note", Kind: string(domain.KindNote), DisplayName: "A note"},
	}
	got := chats.RefreshTabNames(in)
	for i, want := range []string{"What next?", "Gone", "A note"} {
		if got[i].DisplayName != want {
			t.Errorf("tab %d is named %q, want %q", i, got[i].DisplayName, want)
		}
	}
	if in[0].DisplayName != "Untitled chat" {
		t.Error("the input was mutated")
	}
}

// A description and a name given by hand are written to the chat's .meta alone: neither moves the
// chat's version nor writes a snapshot, and a later save of its exchanges keeps them. A
// description names the chat unless a person did, and keeps its summary, keywords, categories and
// how many answered exchanges it was of; a name given by hand survives a description, and a blank
// one hands naming back, the chat counting as never described.
func TestChatService_DescribeAndRenameWriteTheMetaAlone(t *testing.T) {
	chats, st := newTestChats(t)
	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	c.SetExchanges([]domain.SieveBlock{askedChat("What errors can a parser raise?"), askedChat("Which is worst?")})
	saved, err := chats.Save(c)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	uuid, version := saved.UUID(), saved.Version()
	dir, _ := st.DocDirByUUID(uuid)
	snapshots := func() int {
		entries, _ := os.ReadDir(filepath.Join(dir, ".history"))
		return len(entries)
	}
	history := snapshots()
	described := func(want string, wantSummary string, wantAnswered int, wantHand bool) {
		t.Helper()
		got, err := chats.Load(uuid)
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		d, answered := got.Description()
		if got.Name() != want || d.Summary != wantSummary || answered != wantAnswered || got.NamedByHand() != wantHand {
			t.Errorf("named %q (by hand %v), summary %q, of %d answered; want %q (%v), %q, %d", got.Name(), got.NamedByHand(), d.Summary, answered, want, wantHand, wantSummary, wantAnswered)
		}
		if got.Version() != version || snapshots() != history {
			t.Errorf("version %d with %d snapshots, want %d with %d", got.Version(), snapshots(), version, history)
		}
	}

	parser := domain.NoteMetadata{Title: " Parser error taxonomy ", Keywords: []string{"parser", "errors, kinds"}, Categories: []string{"Work"}, Summary: "Kinds of parse error.", CLI: "agy"}
	if cli, at := saved.DescribedBy(); cli != "" || at != "" {
		t.Errorf("an undescribed chat is described by %q at %q", cli, at)
	}
	if _, err := chats.Describe(uuid, parser, 2); err != nil {
		t.Fatalf("Describe: %v", err)
	}
	described("Parser error taxonomy", "Kinds of parse error.", 2, false)
	got, _ := chats.Load(uuid)
	cli, at := got.DescribedBy()
	if _, err := time.Parse(domain.MetaAiTimeLayout, at); cli != "agy" || err != nil {
		t.Errorf("described by %q at %q (%v), want agy and a time", cli, at, err)
	}
	if got, _ := chats.Load(uuid); fmt.Sprint(got.Storable().Meta()["tags"]) != "[parser, errors; kinds]" {
		t.Errorf("tags = %q", got.Storable().Meta()["tags"])
	}
	resaved, err := chats.Save(saved)
	if err != nil {
		t.Fatalf("Save after Describe: %v", err)
	}
	version, history = resaved.Version(), snapshots()
	described("Parser error taxonomy", "Kinds of parse error.", 2, false)

	if _, err := chats.Rename(uuid, "  Mine  "); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	described("Mine", "Kinds of parse error.", 2, true)
	if _, err := chats.Describe(uuid, domain.NoteMetadata{Title: "Another title", Summary: "Revised."}, 3); err != nil {
		t.Fatalf("Describe: %v", err)
	}
	described("Mine", "Revised.", 3, true)

	if _, err := chats.Rename(uuid, " "); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	described("What errors can a parser raise?", "Revised.", 0, false)
	if _, err := chats.Describe(uuid, domain.NoteMetadata{Title: "Named again"}, 2); err != nil {
		t.Fatalf("Describe: %v", err)
	}
	described("Named again", "", 2, false)
	got, _ = chats.Load(uuid)
	if cli, _ := got.DescribedBy(); cli != "agy" {
		t.Errorf("a description naming no CLI left the chat described by %q, want agy kept", cli)
	}

	for name, write := range map[string]func() error{
		"SaveMeta": func() error { _, err := chats.SaveMeta(missingUUID, func(domain.DocumentMeta) {}); return err },
		"Describe": func() error { _, err := chats.Describe(missingUUID, parser, 1); return err },
		"Rename":   func() error { _, err := chats.Rename(missingUUID, "x"); return err },
	} {
		if err := write(); !errors.Is(err, domain.ErrNotChat) {
			t.Errorf("%s of no chat: %v, want ErrNotChat", name, err)
		}
	}
}

func TestChatService_Search(t *testing.T) {
	chats, _ := newTestChats(t)
	var uuids []string
	for _, q := range []string{"Alpha question", "Beta question"} {
		c, err := chats.Create("")
		if err != nil {
			t.Fatalf("Create: %v", err)
		}
		c.SetExchanges([]domain.SieveBlock{askedChat(q)})
		if c, err = chats.Save(c); err != nil {
			t.Fatalf("Save: %v", err)
		}
		uuids = append(uuids, c.UUID())
	}
	if _, err := chats.Describe(uuids[0], domain.NoteMetadata{Title: "Alpha question", Keywords: []string{"tokenizer"},
		Categories: []string{"Work"}, Summary: "How a lexer splits its input."}, 1); err != nil {
		t.Fatalf("Describe: %v", err)
	}

	for _, tc := range []struct {
		name     string
		criteria domain.SearchCriteria
		want     []string
	}{
		{"everything, newest first", domain.SearchCriteria{}, []string{uuids[1], uuids[0]}},
		{"by name", domain.SearchCriteria{Terms: "alpha", Fields: domain.SearchFields{domain.SearchName}}, []string{uuids[0]}},
		{"not by content unless asked", domain.SearchCriteria{Terms: "status", Fields: domain.SearchFields{domain.SearchName}}, nil},
		{"by content", domain.SearchCriteria{Terms: "beta", Fields: domain.SearchFields{domain.SearchContent}}, []string{uuids[1]}},
		{"by a keyword", domain.SearchCriteria{Terms: "tokenizer", Fields: domain.SearchFields{domain.SearchTags}}, []string{uuids[0]}},
		{"by a category", domain.SearchCriteria{Terms: "work", Fields: domain.SearchFields{domain.SearchTags}}, []string{uuids[0]}},
		{"by a word of its summary", domain.SearchCriteria{Terms: "lexer", Fields: domain.SearchFields{domain.SearchSummary}}, []string{uuids[0]}},
		{"not by its summary unless asked", domain.SearchCriteria{Terms: "lexer", Fields: domain.SearchFields{domain.SearchName}}, nil},
		{"the chat kind", domain.SearchCriteria{Kinds: []string{domain.ChatKind}, DurableOnly: true}, []string{uuids[1], uuids[0]}},
		{"another kind", domain.SearchCriteria{Kinds: []string{string(domain.KindNote)}}, nil},
		{"a folder", domain.SearchCriteria{Folder: "work"}, nil},
		{"a limit", domain.SearchCriteria{Limit: 1}, []string{uuids[1]}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hits, err := chats.Search(tc.criteria)
			if err != nil {
				t.Fatalf("Search: %v", err)
			}
			var got []string
			for _, h := range hits {
				got = append(got, h.Container())
				if h.Kind != domain.ChatKind || h.Title == "" || h.Modified == "" {
					t.Errorf("hit = %+v", h)
				}
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Errorf("hits = %v, want %v", got, tc.want)
			}
		})
	}
}
