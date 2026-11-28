package block

import (
	"fmt"
	"testing"

	"sieve/sieve/domain"
)

// A chat takes an exchange after the last and nothing else: a block that is not
// an ai-block is refused, as is an id the chat already holds, and a refusal
// leaves the list as it was.
func TestShadowChat_AppendExchange(t *testing.T) {
	first := chatExchange("What is a chat?", "A list.")
	for _, tc := range []struct {
		name    string
		appends domain.SieveBlock
		refused bool
	}{
		{"an ai-block", chatExchange("And an exchange?", ""), false},
		{"a prose block", domain.NewSieveBlock(KindProse, "", map[string]interface{}{"content": "hello"}), true},
		{"an exchange the chat holds", first, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chat := NewShadowChat("0198c1a0-0001-7000-8000-0000000000c1", []domain.SieveBlock{first})
			err := chat.AppendExchange(tc.appends)
			if (err != nil) != tc.refused {
				t.Fatalf("AppendExchange: %v, want refused %v", err, tc.refused)
			}
			want := []string{first.ID}
			if !tc.refused {
				want = append(want, tc.appends.ID)
			}
			if got := chat.BlockIDs(); fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("exchanges = %v, want %v", got, want)
			}
		})
	}
}

// A job in a chat is shown every exchange: a block is found among them by id,
// what precedes an exchange is every exchange asked before it, oldest first, and
// the chat is a conversation whatever is asked. The whole chat says nothing of
// its own, and the view is a copy a later change to the chat does not reach.
func TestShadowChat_SnapshotForJobIsAChatView(t *testing.T) {
	const uuid = "0198c1a0-0001-7000-8000-0000000000c2"
	exchanges := []domain.SieveBlock{chatExchange("one", "1"), chatExchange("two", "2"), chatExchange("three", "")}
	chat := NewShadowChat(uuid, exchanges)

	if _, _, ok := chat.SnapshotForJob("not-held"); ok {
		t.Error("a block the chat does not hold was snapshotted")
	}
	snap, view, ok := chat.SnapshotForJob(exchanges[2].ID)
	if !ok || snap.ID != exchanges[2].ID {
		t.Fatalf("SnapshotForJob = %+v, %v", snap, ok)
	}
	chat.PatchBlock(domain.SieveBlock{ID: exchanges[0].ID, Attrs: map[string]interface{}{"status": BlockStatusError}})

	for _, tc := range []struct {
		id      string
		earlier []domain.SieveBlock
	}{
		{exchanges[0].ID, nil},
		{exchanges[1].ID, exchanges[:1]},
		{exchanges[2].ID, exchanges[:2]},
		{"not-held", nil},
	} {
		earlier, conversation := view.ConversationBefore(tc.id)
		var want []string
		for _, e := range tc.earlier {
			want = append(want, e.ID)
		}
		if !conversation || fmt.Sprint(earlier) != fmt.Sprint(want) {
			t.Errorf("ConversationBefore(%s) = %v, %v; want %v, true", tc.id, earlier, conversation, want)
		}
	}
	if b, ok := view.Block(exchanges[1].ID); !ok || b.ID != exchanges[1].ID {
		t.Errorf("Block found %+v, %v", b, ok)
	}
	if _, ok := view.Block(""); ok {
		t.Error("an empty id was found")
	}
	if b, _ := view.Block(exchanges[0].ID); b.Status() != BlockStatusComplete {
		t.Errorf("the view saw a change made after it was taken: status %s", b.Status())
	}
	if ctx := view.WholeContext(nil); !ctx.IsEmpty() {
		t.Errorf("the whole chat says %+v, want nothing", ctx)
	}
	if got, want := view.AddressOf(exchanges[1].ID), domain.NewLeafAddress(uuid, exchanges[1].ID); !got.Equal(want) || view.Container() != uuid {
		t.Errorf("AddressOf = %v, Container = %q", got, view.Container())
	}
}
