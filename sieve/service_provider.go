package sieve

import (
	"sieve/logger"
	"sieve/store"
	"strings"
	"time"
)

type ServiceProvider struct {
	Store     store.Store
	Documents *DocumentService
	Assets    *AssetService
	State     *StateService
	Prompts   *PromptService
	AI        *AIService
	Editor    *EditorService
}

func (s *ServiceProvider) Init(store store.Store, storePath string) {
	s.Store = store
	var err error

	s.Documents, err = NewDocumentService(store)
	if err != nil {
		logger.Error("buffers init failed", "err", err)
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
	s.AI = NewAIService(s.State, s.Prompts, s.Documents, storePath)
	settings := s.State.LoadSettings()
	autosave := time.Duration(settings.AutosaveDebounce) * time.Second
	s.Editor = NewEditorService(s.Documents, autosave)
	s.migrateSession()
}

func (s *ServiceProvider) migrateSession() {
	if s.State == nil || s.Documents == nil {
		return
	}
	session := s.State.LoadSession()
	changed := false

	for i, tab := range session.Tabs {
		if strings.HasPrefix(tab.ID, "prompt:") {
			continue
		}

		// If it's a path or doesn't look like a standard UUID, try to resolve it
		if strings.Contains(tab.ID, "/") || !isUUID(tab.ID) {
			// Try to load it via the Store to find its real UUID
			// 1. Try Library
			if st, err := s.Store.Load(Library, tab.ID); err == nil {
				if ms, ok := st.(store.MetaStorable); ok {
					if uuid := ms.Meta()["uuid"]; uuid != "" {
						session.Tabs[i].ID = uuid
						changed = true
						continue
					}
				}
			}
			// 2. Try WorkingCopy
			if st, err := s.Store.Load(WorkingCopy, tab.ID); err == nil {
				if ms, ok := st.(store.MetaStorable); ok {
					if uuid := ms.Meta()["uuid"]; uuid != "" {
						session.Tabs[i].ID = uuid
						changed = true
						continue
					}
				}
			}
		}
	}

	if changed {
		logger.Info("ServiceProvider: migrated session tab IDs to UUIDs")
		_ = s.State.SaveSession(session)
	}
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else {
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}
	return true
}
