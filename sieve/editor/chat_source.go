package editor

import (
	"errors"
	"fmt"
	"strings"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
)

// ChatSource is the Router's face on chats.
//
// It offers every chat ChatService.Search finds, and resolves a chat at container
// grain and at a leaf naming one of its exchanges or a file it keeps. A chat keeps
// no version a reader can name, so a pinned address does not resolve.
type ChatSource struct {
	chats *services.ChatService
}

// NewChatSource builds the source over the chat service.
func NewChatSource(chats *services.ChatService) *ChatSource {
	return &ChatSource{chats: chats}
}

// Name identifies this source in Router diagnostics.
func (s *ChatSource) Name() string { return "chats" }

// Search offers the chats matching criteria. A store that cannot be listed
// offers nothing.
func (s *ChatSource) Search(criteria domain.SearchCriteria) []domain.Candidate {
	hits, err := s.chats.Search(criteria)
	if err != nil {
		logger.Warn("chat source: search failed", "err", err)
		return nil
	}
	return hits
}

// Resolve dereferences an address into the chat it names or into the exchange or
// file it names inside one. At container grain the descriptor is titled with the
// chat's name, carries the summary of its description, its body is the markdown
// of each exchange that has one, in order, and it lists the chat's files. Anything that is not a chat, a pinned address and a leaf the chat
// does not hold are domain.ErrNodeNotFound.
func (s *ChatSource) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	chat, err := s.chats.Load(addr.Container)
	if errors.Is(err, domain.ErrNotChat) {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s: %v", domain.ErrNodeNotFound, addr.String(), err)
	}
	if err != nil {
		return domain.NodeDescriptor{}, err
	}
	if addr.IsPinned() {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s: a chat keeps no readable version", domain.ErrNodeNotFound, addr.String())
	}
	leaves := &containerLeaves{
		addr:     addr,
		owner:    chat.Storable(),
		registry: block.GlobalRegistry(),
		blocks:   chat.Exchanges(),
	}
	if !addr.IsContainer() {
		return leaves.resolve()
	}
	bodies := make([]string, 0, len(leaves.blocks))
	for _, exchange := range leaves.blocks {
		if body := leaves.blockNode(exchange).Body; body != "" {
			bodies = append(bodies, body)
		}
	}
	description, _ := chat.Description()
	return domain.NodeDescriptor{
		URI:     addr.String(),
		ID:      chat.UUID(),
		Kind:    domain.ChatKind,
		Title:   chat.Name(),
		Summary: strings.TrimSpace(description.Summary),
		Body:    strings.Join(bodies, "\n\n"),
		Assets:  leaves.assetList(),
	}, nil
}
