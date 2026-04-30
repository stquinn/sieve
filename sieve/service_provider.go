package sieve

import (
	"sieve/logger"
	"sieve/store"
)

type ServiceProvider struct {
	Store   *store.Store
	Buffers *BufferService
	Notes   *NoteService
	Assets  *AssetService
	State   *StateService
	Prompts *PromptService
	AI      *AIService
}

func (s *ServiceProvider) Init(store store.Store, storePath string) {
	s.Store = &store
	var err error

	s.Buffers, err = NewBufferService(store)
	if err != nil {
		logger.Error("buffers init failed", "err", err)
		return
	}
	s.Notes, err = NewNoteService(store)
	if err != nil {
		logger.Error("notes init failed", "err", err)
		return
	}
	s.Assets = NewAssetService(store)
	s.State, err = NewStateService(store)
	if err != nil {
		logger.Error("state init failed", "err", err)
		return
	}
	s.Prompts, err = NewPromptService(store)
	if err != nil {
		logger.Error("prompts init failed", "err", err)
		return
	}
	s.AI = NewAIService(s.State, s.Prompts, s.Buffers, s.Notes, storePath)
}
