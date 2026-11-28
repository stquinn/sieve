package block

import (
	"fmt"
	"sync"

	"sieve/sieve/domain"
)

// ShadowChat holds the live state of one open chat: its exchanges, each an
// ai-block, in the order they were asked, and the job protocol run against
// them (the embedded LiveBlocks). The list only grows: AppendExchange is the one
// change it adds to the job protocol.
type ShadowChat struct {
	LiveBlocks
	UUID string
	// saveMu serializes the saves of this chat (WithSaveLock). It is separate from
	// mu so the store I/O of a save never blocks a job writing into an exchange.
	saveMu sync.Mutex
}

// NewShadowChat holds exchanges, in order, as the live state of the chat uuid.
func NewShadowChat(uuid string, exchanges []domain.SieveBlock) *ShadowChat {
	return &ShadowChat{LiveBlocks: LiveBlocks{Blocks: exchanges}, UUID: uuid}
}

// AppendExchange adds exchange after the last. It refuses a block that is not an
// ai-block, and one whose id the chat already holds.
func (s *ShadowChat) AppendExchange(exchange domain.SieveBlock) error {
	if exchange.Kind != KindAIBlock {
		return fmt.Errorf("chat %s: an exchange is an %s, not a %q", s.UUID, KindAIBlock, exchange.Kind)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if found, _ := s.locate(s.Blocks, exchange.ID); found != nil {
		return fmt.Errorf("chat %s: already holds %q", s.UUID, exchange.ID)
	}
	s.Blocks = append(s.Blocks, exchange)
	return nil
}

// AdmitRetry reports why the job of block id may not be run again: id names an exchange of the chat
// that has an answer or is being answered. Only an exchange whose job ended in error or timeout, or
// never ran, is run again. A block that is not an exchange, an element of an answer, is not the
// chat's to refuse.
func (s *ShadowChat) AdmitRetry(id string) error {
	if s.IndexOfBlock(id) < 0 {
		return nil
	}
	exchange, _ := s.SnapshotBlock(id)
	switch status := exchange.Status(); status {
	case BlockStatusError, BlockStatusTimeout, BlockStatusPending:
		return nil
	default:
		return fmt.Errorf("chat %s: exchange %q has an answer or is being answered (status %s)", s.UUID, id, status)
	}
}

// SnapshotForJob returns, under one lock, a deep copy of the block blockID (an
// exchange, or an element of one) and a ChatView of every exchange, or false if
// the chat holds no such block.
func (s *ShadowChat) SnapshotForJob(blockID string) (domain.SieveBlock, ContainerView, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	target, _ := s.locate(s.Blocks, blockID)
	if target == nil {
		return domain.SieveBlock{}, nil, false
	}
	view := NewChatView(s.UUID, make([]domain.SieveBlock, len(s.Blocks)))
	for i := range s.Blocks {
		view.Exchanges[i] = s.Blocks[i].Clone()
	}
	return target.Clone(), view, true
}

// WithSaveLock runs fn holding the chat's save lock, so two saves of this chat
// never interleave. fn may take the chat's block lock itself.
func (s *ShadowChat) WithSaveLock(fn func() error) error {
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	return fn()
}

// NewChatView is the view of the chat uuid holding exchanges, in order.
func NewChatView(uuid string, exchanges []domain.SieveBlock) ChatView {
	return ChatView{ContainerAddressing: ContainerAddressing{UUID: uuid}, Exchanges: exchanges}
}

// ChatView is an immutable snapshot of a chat, taken when a job is described:
// its exchanges in order. A chat is a conversation: what it orders before an
// exchange is every exchange asked earlier.
type ChatView struct {
	ContainerAddressing
	Exchanges []domain.SieveBlock
}

// Block returns the exchange the chat holds under id. An empty id is never
// found.
func (v ChatView) Block(id string) (domain.SieveBlock, bool) {
	if id == "" {
		return domain.SieveBlock{}, false
	}
	for _, exchange := range v.Exchanges {
		if exchange.ID == id {
			return exchange, true
		}
	}
	return domain.SieveBlock{}, false
}

// WholeContext is the empty context: a chat's whole is its thread, which every
// run in it is given apart.
func (v ChatView) WholeContext(BlockFilter) AIContext { return AIContext{} }

// ConversationBefore returns the ids of every exchange asked before id, oldest
// first, and true. An id the chat does not hold as an exchange has none before
// it.
func (v ChatView) ConversationBefore(id string) ([]string, bool) {
	for i, exchange := range v.Exchanges {
		if exchange.ID != id {
			continue
		}
		earlier := make([]string, i)
		for j := range earlier {
			earlier[j] = v.Exchanges[j].ID
		}
		return earlier, true
	}
	return nil, true
}

// Answered is the text of each exchange that has its answer (BlockStatusComplete),
// oldest first, as the chat task's thread shows a turn: the question asked and the
// answer given, with no address. An exchange whose context says nothing is left
// out.
func (v ChatView) Answered() []string {
	var turns []string
	seen := map[string]bool{}
	for _, exchange := range v.Exchanges {
		if exchange.Status() != BlockStatusComplete {
			continue
		}
		ctx := BuildContextForID(exchange.ID, v, seen, nil)
		if !ctx.Speaks() {
			continue
		}
		ctx.Addresses = nil
		turns = append(turns, ctx.String())
	}
	return turns
}
