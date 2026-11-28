package editor

import (
	"errors"
	"strings"
	"testing"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
)

func TestChatSource_SearchAndResolve(t *testing.T) {
	chats, containers, ds, _ := newTestChats(t)
	block.RegisterProcessor(processors.NewAIBlockProcessor(block.BlockServices{}))
	source := NewChatSource(chats)

	c, err := chats.Create("")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	first, second := answeredExchange("What is a chat?", "A list."), answeredExchange("And an exchange?", "One turn.")
	c.SetExchanges([]domain.SieveBlock{first, second})
	if c, err = chats.Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := chats.SaveAsset(c, "page.html", []byte("<p>fetched</p>")); err != nil {
		t.Fatalf("SaveAsset: %v", err)
	}
	uuid := c.UUID()

	hits := source.Search(domain.SearchCriteria{Terms: "what is", Fields: domain.SearchFields{domain.SearchName}})
	if len(hits) != 1 || hits[0].Container() != uuid || hits[0].Kind != domain.ChatKind || hits[0].Title != "What is a chat?" {
		t.Errorf("Search = %+v, want the chat", hits)
	}

	for _, tc := range []struct {
		name, uri, wantID, wantKind, wantTitle, wantBody string
		wantAttrs                                        bool
	}{
		{"chat", "sieve://" + uuid, uuid, domain.ChatKind, "What is a chat?", "And an exchange?", false},
		{"exchange", "sieve://" + uuid + "/" + second.ID, second.ID, block.KindAIBlock, "", "And an exchange?", true},
		{"file", "sieve://" + uuid + "/page.html", "page.html", assetKind, "page.html", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node, err := source.Resolve(mustAddress(t, tc.uri))
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			if node.ID != tc.wantID || node.Kind != tc.wantKind || node.Title != tc.wantTitle || !strings.Contains(node.Body, tc.wantBody) {
				t.Errorf("node = %+v", node)
			}
			if tc.wantAttrs != (node.Attrs != nil) {
				t.Errorf("Attrs = %v, want present=%v", node.Attrs, tc.wantAttrs)
			}
		})
	}
	node, err := source.Resolve(mustAddress(t, "sieve://"+uuid))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if strings.Index(node.Body, "What is a chat?") > strings.Index(node.Body, "And an exchange?") {
		t.Errorf("body does not keep the exchanges in order:\n%s", node.Body)
	}
	if len(node.Assets) != 1 || node.Assets[0].Key != "page.html" {
		t.Errorf("assets = %+v, want page.html", node.Assets)
	}
	if node.Summary != "" {
		t.Errorf("an undescribed chat's summary is %q", node.Summary)
	}
	if _, err := chats.Describe(uuid, domain.NoteMetadata{Title: "Chats and turns", Keywords: []string{"turn"}, Summary: "What a chat holds."}, 2); err != nil {
		t.Fatalf("Describe: %v", err)
	}
	if node, err := source.Resolve(mustAddress(t, "sieve://"+uuid)); err != nil || node.Title != "Chats and turns" || node.Summary != "What a chat holds." {
		t.Errorf("a described chat resolves as %+v, %v", node, err)
	}
	if hits := source.Search(domain.SearchCriteria{Terms: "turn", Fields: domain.SearchFields{domain.SearchTags}}); len(hits) != 1 || hits[0].Summary != "What a chat holds." {
		t.Errorf("Search by a keyword = %+v, want the chat with its summary", hits)
	}

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	container, err := containers.Create(containerKind, nil)
	if err != nil {
		t.Fatalf("Create container: %v", err)
	}
	for name, uri := range map[string]string{
		"a document":        "sieve://" + doc.UUID(),
		"a block container": "sieve://" + container.UUID(),
		"nothing":           "sieve://" + testMissingUUID,
		"a pinned chat":     "sieve://" + uuid + "?version=1",
		"unknown leaf":      "sieve://" + uuid + "/no-such-leaf",
	} {
		if _, err := source.Resolve(mustAddress(t, uri)); !errors.Is(err, domain.ErrNodeNotFound) {
			t.Errorf("%s: err = %v, want ErrNodeNotFound", name, err)
		}
	}
}
