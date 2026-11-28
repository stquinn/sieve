package domain

import (
	"errors"
	"strings"
	"time"

	"sieve/store"
)

// ChatKind is a chat's noun: the kind a chat reports as a search hit and as a
// resolved node.
const ChatKind = "chat"

// ErrNotChat reports a uuid that names no chat: nothing at all, or a storable of
// another type.
var ErrNotChat = errors.New("chat: uuid names no chat")

// chatNameWords is how many opening words of its first question an untitled chat
// is called by.
const chatNameWords = 8

// untitledChat is what a chat is called when it has neither a title nor a
// question with words in it.
const untitledChat = "Untitled chat"

// Chat is a conversation with a model: its exchanges, each an ai-block, in the
// order they were asked. The order is authoritative and the list only grows. A
// chat is not a Document: it is a sibling of Document and BlockContainer over
// store.MetaStorable, and its content file is a chat's own YAML (block.ChatCodec).
//
// Every store mutation returns a new Chat: a Chat is stale once it has been passed
// to ChatService.Save.
type Chat struct {
	storable  store.MetaStorable
	exchanges []SieveBlock
}

// NewChat pairs a type: chat storable with the exchanges already parsed out of
// its body.
func NewChat(ms store.MetaStorable, exchanges []SieveBlock) *Chat {
	return &Chat{storable: ms, exchanges: exchanges}
}

// UUID is the chat's identity.
func (c *Chat) UUID() string { return c.storable.Key() }

// Title is the name the chat was given, by a person or by its description: its
// .meta display_name; "" when it was given none.
func (c *Chat) Title() string {
	if title := strings.TrimSpace(c.storable.Meta()["display_name"]); title != "null" {
		return title
	}
	return ""
}

// NamedByHand is whether a person gave the chat its name, which a description
// then keeps.
func (c *Chat) NamedByHand() bool { return c.storable.Meta()[MetaKeyNamedBy] == MetaNamedByHand }

// Description is what the chat's .meta holds of its description, its Title the
// chat's Title, and how many answered exchanges it was of; 0 when the chat has
// not been described since it was created or a blank name handed naming back.
func (c *Chat) Description() (NoteMetadata, int) {
	meta := c.storable.Meta()
	d := NoteMetadata{Title: c.Title()}
	d.ReadFrom(meta)
	return d, metaInt(meta, MetaKeyDescribed)
}

// DescribedBy is the AI CLI that last described the chat and the time it did, as AiLastEvaluated
// holds it (MetaAiTimeLayout); "" for each when the chat has not been described by an AI.
func (c *Chat) DescribedBy() (cli, at string) {
	meta := NewDocumentMeta(c.storable.Meta(), func(map[string]string) {})
	if v := meta.CLI(); v != nil {
		cli = *v
	}
	if v := meta.AiLastEvaluated(); v != nil {
		at = *v
	}
	return cli, at
}

// Name is what the chat is called: its title, or else the opening words of its
// first question, derived on every call and never stored.
func (c *Chat) Name() string {
	if title := c.Title(); title != "" {
		return title
	}
	if len(c.exchanges) > 0 {
		if opening := c.openingWords(c.exchanges[0]); opening != "" {
			return opening
		}
	}
	return untitledChat
}

// openingWords is the first chatNameWords words of the text of exchange's
// question, marked as cut when it has more; "" when the question holds no text.
func (c *Chat) openingWords(exchange SieveBlock) string {
	var words []string
	for _, el := range exchange.Elements(QuestionAttr) {
		words = append(words, strings.Fields(el.Content())...)
	}
	if len(words) > chatNameWords {
		return strings.Join(words[:chatNameWords], " ") + "…"
	}
	return strings.Join(words, " ")
}

// Exchanges returns the chat's exchanges in order, as last set by SetExchanges
// when they have not been saved. The slice is a copy; the blocks share their
// attrs with the chat's.
func (c *Chat) Exchanges() []SieveBlock { return append([]SieveBlock(nil), c.exchanges...) }

// SetExchanges makes exchanges, in order, the chat's whole list. The change is
// local until ChatService.Save, which refuses an exchange that is not an
// ai-block.
func (c *Chat) SetExchanges(exchanges []SieveBlock) {
	c.exchanges = append([]SieveBlock(nil), exchanges...)
}

// Version is the store's version of the chat's last save.
func (c *Chat) Version() int { return metaInt(c.storable.Meta(), "version") }

// Modified is when the chat was last saved; zero when its .meta does not say.
func (c *Chat) Modified() time.Time { return metaTime(c.storable.Meta(), "modified") }

// Storable returns the underlying MetaStorable for direct Store operations.
func (c *Chat) Storable() store.MetaStorable { return c.storable }

// Assets lists the files kept beside the chat.
func (c *Chat) Assets() []store.Storable { return c.storable.Owns() }
