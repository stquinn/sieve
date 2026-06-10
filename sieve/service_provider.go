package sieve

import (
	"sieve/logger"
	"sieve/store"
	"time"
)

type ServiceProvider struct {
	Store       store.Store
	Library     LibraryService
	Documents   *DocumentService
	Assets      *AssetService
	State       *StateService
	Prompts     *PromptService
	AI          *AIService
	Editor      *EditorService
	Jobs        *JobTracker
	LinkPreview *LinkPreviewService
}

// BlockServices returns the scoped dependency bag for block processors.
// Add a field here when a new service should be available inside RunJob / OnChange.
func (s *ServiceProvider) BlockServices() BlockServices {
	return BlockServices{
		AI:          s.AI,
		Documents:   s.Documents,
		Assets:      s.Assets,
		Jobs:        s.Jobs,
		LinkPreview: s.LinkPreview,
	}
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
	s.LinkPreview = NewLinkPreviewService()
	settings := s.State.LoadSettings()
	autosave := time.Duration(settings.AutosaveDebounce) * time.Second
	s.Editor = NewEditorService(s.Documents, autosave)
	s.Editor.SetServices(s.BlockServices())
	svc := s.BlockServices()
	RegisterProcessor("diagram", NewDiagramProcessor(svc))
	RegisterProcessor("smart-image", NewSmartImageProcessor(svc))

	RegisterProcessor("smart-link", NewSmartLinkProcessor(svc))
	RegisterProcessor("smart-card", NewSmartCardProcessor(svc))
	RegisterProcessor("web-clip", NewWebClipBlockProcessor(svc))
	RegisterProcessor("code", NewCodeBlockProcessor(svc))
	RegisterProcessor("ai-block", NewAIBlockProcessor(svc))
	RegisterContextProvider("block-anchor", &BlockAnchorProvider{svc: svc})
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
