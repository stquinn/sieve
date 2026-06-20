package sieve

import (
	"sieve/logger"
	"sieve/sieve/block"
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
func (s *ServiceProvider) BlockServices() block.BlockServices {
	return block.BlockServices{
		AI:          s.AI,
		Documents:   s.Documents,
		Assets:      s.Assets,
		LinkPreview: s.LinkPreview,
		State:       s.State,
	}
}

// Compile-time proof the concrete services satisfy the block ports. Lives at the
// composition root — the only place that knows both the ports and the concretes.
var (
	_ block.DocumentsPort   = (*DocumentService)(nil)
	_ block.AssetsPort      = (*AssetService)(nil)
	_ block.StatePort       = (*StateService)(nil)
	_ block.LinkPreviewPort = (*LinkPreviewService)(nil)
	_ block.AIPort          = (*AIService)(nil)
)

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
	s.Editor = NewEditorService(s.Documents, block.NewDocumentCodec(block.GlobalRegistry()), autosave)
	s.Editor.SetServices(s.BlockServices())
	s.Editor.SetJobs(s.Jobs) // re-set in handlers.go once the real JobTracker (with hub) exists
	svc := s.BlockServices()
	block.RegisterProcessor("diagram", NewDiagramProcessor(svc))
	block.RegisterProcessor("smart-image", NewSmartImageProcessor(svc))

	block.RegisterProcessor("smart-link", NewSmartLinkProcessor(svc))
	block.RegisterProcessor("smart-card", NewSmartCardProcessor(svc))
	block.RegisterProcessor("web-clip", NewWebClipBlockProcessor(svc))
	block.RegisterProcessor("log", NewLogProcessor(svc))
	block.RegisterProcessor("code", NewCodeBlockProcessor(svc))

	block.RegisterProcessor("ai-block", NewAIBlockProcessor(svc))
	block.RegisterContextProvider("block-anchor", block.NewBlockAnchorProvider(svc))
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
