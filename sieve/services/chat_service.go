package services

import (
	"fmt"
	"maps"
	"sort"
	"strings"
	"sync"
	"time"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/store"
)

// ChatFormat is what a chat needs of the format its content file is written in.
// block.ChatCodec implements it.
type ChatFormat interface {
	// Encode writes exchanges, in order, as a chat's content file. An exchange
	// that is not an ai-block is refused.
	Encode(exchanges []domain.SieveBlock) ([]byte, error)

	// Decode reads a chat's content file into its exchanges, in order. A body
	// that does not open `kind: chat` is refused.
	Decode(body []byte) ([]domain.SieveBlock, error)
}

// ChatService owns every store.TypeChat storable: it is to a domain.Chat what
// BlockContainerService is to a domain.BlockContainer. Every chat lives in
// domain.Chats, in a directory of its own that holds its files.
type ChatService struct {
	store  store.Store
	format ChatFormat
	// writes is held while Save, SaveMeta or a write built on it reads a chat's stored .meta and
	// writes it.
	writes sync.Mutex
}

// NewChatService prepares the Chats category and builds the service.
func NewChatService(st store.Store, format ChatFormat) (*ChatService, error) {
	if err := st.PrepareCategory(domain.Chats); err != nil {
		return nil, err
	}
	return &ChatService{store: st, format: format}, nil
}

// Create makes a new chat with no exchanges. A title, trimmed, is a name given by
// hand, as Rename gives one; "" leaves the chat to be called by its first
// question until it is described. Its uuid is minted here and names its
// directory.
func (s *ChatService) Create(title string) (*domain.Chat, error) {
	id := ident.New()
	body, err := s.format.Encode(nil)
	if err != nil {
		return nil, fmt.Errorf("chat: create: %w", err)
	}
	meta := map[string]string{"uuid": id}
	if title = strings.TrimSpace(title); title != "" {
		meta["display_name"], meta[domain.MetaKeyNamedBy] = title, domain.MetaNamedByHand
	}
	ms, err := s.store.CreateTyped(domain.Chats, id, store.TypeChat, meta, body)
	if err != nil {
		return nil, fmt.Errorf("chat: create: %w", err)
	}
	return s.open(ms)
}

// Load returns the chat named by uuid. A uuid naming no chat is
// domain.ErrNotChat; a chat whose body will not parse is a different error, so a
// broken file never reads as a missing one.
func (s *ChatService) Load(uuid string) (*domain.Chat, error) {
	ms, err := s.stored(uuid)
	if err != nil {
		return nil, err
	}
	return s.open(ms)
}

// List is every chat, in no order. A chat whose body will not parse is left out.
func (s *ChatService) List() ([]*domain.Chat, error) {
	listed, err := s.store.List(domain.Chats, "")
	if err != nil {
		return nil, fmt.Errorf("chat: list: %w", err)
	}
	var out []*domain.Chat
	for _, item := range listed {
		ms, ok := item.(store.MetaStorable)
		if !ok || ms.Type() != store.TypeChat {
			continue
		}
		chat, err := s.open(ms)
		if err != nil {
			logger.Warn("chat: a chat that will not parse is not listed", "uuid", ms.Key(), "err", err)
			continue
		}
		out = append(out, chat)
	}
	return out, nil
}

// stored is the storable of chat uuid as the store holds it now; a uuid naming
// no chat is domain.ErrNotChat.
func (s *ChatService) stored(uuid string) (store.MetaStorable, error) {
	storable, err := s.store.LoadByUUID(uuid)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", domain.ErrNotChat, uuid, err)
	}
	ms, ok := storable.(store.MetaStorable)
	if !ok || ms.Type() != store.TypeChat {
		return nil, fmt.Errorf("%w: %s", domain.ErrNotChat, uuid)
	}
	return ms, nil
}

// Save writes c's exchanges, bumping the version and writing a snapshot as the
// store does for every save. The .meta written is the chat's .meta as stored now,
// so what a SaveMeta wrote after c was loaded is kept, and c's own .meta gives
// only the version it was loaded at. It returns the new chat; c is stale.
// store.ErrStaleStorable is surfaced. Nothing is written when an exchange is
// refused by the format.
func (s *ChatService) Save(c *domain.Chat) (*domain.Chat, error) {
	body, err := s.format.Encode(c.Exchanges())
	if err != nil {
		return nil, fmt.Errorf("chat %s: save: %w", c.UUID(), err)
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	ms := c.Storable()
	if stored, err := s.stored(c.UUID()); err == nil {
		meta := maps.Clone(stored.Meta())
		meta["version"] = ms.Meta()["version"]
		ms.SetMeta(meta)
	}
	ms.SetBody(body)
	saved, err := s.store.Save(ms)
	if err != nil {
		return nil, fmt.Errorf("chat %s: save: %w", c.UUID(), err)
	}
	savedMS, ok := saved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("chat %s: save: not MetaStorable", c.UUID())
	}
	return s.open(savedMS)
}

// SaveMeta applies edit to the .meta of chat uuid as it is stored now and writes
// the .meta alone: the exchanges are not encoded, the version does not move and
// no snapshot is written. Save and SaveMeta run one at a time and each starts
// from the stored .meta, so neither loses what the other wrote. edit must not
// set the keys the store writes. It returns the chat as stored after the write;
// a uuid naming no chat is domain.ErrNotChat.
func (s *ChatService) SaveMeta(uuid string, edit func(domain.DocumentMeta)) (*domain.Chat, error) {
	s.writes.Lock()
	defer s.writes.Unlock()
	ms, err := s.stored(uuid)
	if err != nil {
		return nil, err
	}
	meta := maps.Clone(ms.Meta())
	edit(domain.NewDocumentMeta(meta, func(map[string]string) {}))
	ms.SetMeta(meta)
	saved, err := s.store.SaveMeta(ms)
	if err != nil {
		return nil, fmt.Errorf("chat %s: save meta: %w", uuid, err)
	}
	return s.open(saved)
}

// Describe keeps d as the description of chat uuid as it stood with answered
// exchanges answered, in its .meta alone, as SaveMeta writes: its name, unless a
// person named it, its summary, its keywords and its categories. It returns the
// chat as stored after the write.
func (s *ChatService) Describe(uuid string, d domain.NoteMetadata, answered int) (*domain.Chat, error) {
	return s.SaveMeta(uuid, func(m domain.DocumentMeta) {
		d.WriteTo(m, m.All()[domain.MetaKeyNamedBy] == domain.MetaNamedByHand, uint64(max(answered, 0)))
	})
}

// Rename gives chat uuid name, trimmed, by hand, in its .meta alone, as SaveMeta
// writes: a description then keeps it and describes the rest. A blank name hands
// naming back: the chat is called by the opening words of its first question and
// counts as never described, so it is described when next due. It returns the
// chat as stored after the write.
func (s *ChatService) Rename(uuid, name string) (*domain.Chat, error) {
	name = strings.TrimSpace(name)
	return s.SaveMeta(uuid, func(m domain.DocumentMeta) {
		m.SetDisplayName(name)
		all := m.All()
		if name != "" {
			all[domain.MetaKeyNamedBy] = domain.MetaNamedByHand
			return
		}
		delete(all, domain.MetaKeyNamedBy)
		delete(all, domain.MetaKeyDescribed)
	})
}

// Delete removes the chat, its history and its files.
func (s *ChatService) Delete(c *domain.Chat) error {
	return s.store.Delete(c.Storable())
}

// RefreshTabNames gives each tab that shows a chat the chat's name as the store
// has it now, so a tab follows a chat called something else after its first
// question. A tab that shows no chat, and one whose chat no longer loads, keeps
// what it had. The input slice is not mutated: a refreshed copy is returned.
func (s *ChatService) RefreshTabNames(tabs []domain.Tab) []domain.Tab {
	out := append([]domain.Tab(nil), tabs...)
	for i := range out {
		if out[i].ContainerKind() != domain.ChatKind {
			continue
		}
		if chat, err := s.Load(out[i].ID); err == nil {
			out[i].DisplayName = chat.Name()
		}
	}
	return out
}

// SaveAsset keeps data as a file beside the chat, replacing any file of the same
// key. The chat's version does not move.
func (s *ChatService) SaveAsset(c *domain.Chat, assetKey string, data []byte) (store.AssetStorable, error) {
	return store.OwnedAssets{Store: s.store}.Save(c.Storable(), assetKey, data)
}

// LoadAsset reads a file the chat keeps.
func (s *ChatService) LoadAsset(c *domain.Chat, assetKey string) (store.AssetStorable, error) {
	return s.store.LoadAsset(c.Storable().Category(), c.UUID(), assetKey)
}

// DeleteAsset removes a file the chat keeps. c's Assets list is stale
// afterwards; Load again to read it.
func (s *ChatService) DeleteAsset(c *domain.Chat, assetKey string) error {
	return s.store.DeleteAsset(c.Storable().Category(), c.UUID(), assetKey)
}

// Search answers a search over every chat, newest first. A chat is matched on
// its name (domain.Chat.Name), its summary, its keywords and categories as its
// tags, and its content file; it is durable and has no folder, so none is
// offered when c gives a folder. A chat whose body will not parse is not a hit.
func (s *ChatService) Search(c domain.SearchCriteria) ([]domain.Candidate, error) {
	if !c.Includes(domain.ChatKind, true) || !c.InFolder("") {
		return nil, nil
	}
	chats, err := s.List()
	if err != nil {
		return nil, fmt.Errorf("chat: search: %w", err)
	}
	type hit struct {
		candidate domain.Candidate
		modified  time.Time
	}
	var hits []hit
	for _, chat := range chats {
		d, _ := chat.Description()
		summary := strings.TrimSpace(d.Summary)
		tags := append(append([]string(nil), d.Keywords...), d.Categories...)
		faces := map[domain.SearchField][]string{domain.SearchName: {chat.Name()}, domain.SearchSummary: {summary}, domain.SearchTags: tags}
		if c.Fields.Has(domain.SearchContent) {
			faces[domain.SearchContent] = []string{string(chat.Storable().Body())}
		}
		matched, ok := c.Match(faces)
		if !ok {
			continue
		}
		candidate := domain.Candidate{
			URI:     domain.NewContainerAddress(chat.UUID()).String(),
			Title:   chat.Name(),
			Kind:    domain.ChatKind,
			Summary: summary,
			Tags:    tags,
			Matched: matched,
		}
		if t := chat.Modified(); !t.IsZero() {
			candidate.Modified = t.Format(time.RFC3339)
		}
		hits = append(hits, hit{candidate: candidate, modified: chat.Modified()})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if !hits[i].modified.Equal(hits[j].modified) {
			return hits[i].modified.After(hits[j].modified)
		}
		return hits[i].candidate.URI > hits[j].candidate.URI
	})
	out := make([]domain.Candidate, 0, len(hits))
	for _, h := range hits {
		if c.Full(len(out)) {
			break
		}
		out = append(out, h.candidate)
	}
	return out, nil
}

// open reads the exchanges out of a type: chat storable's body and pairs the two.
func (s *ChatService) open(ms store.MetaStorable) (*domain.Chat, error) {
	exchanges, err := s.format.Decode(ms.Body())
	if err != nil {
		return nil, fmt.Errorf("chat %s: parse body: %w", ms.Key(), err)
	}
	return domain.NewChat(ms, exchanges), nil
}
