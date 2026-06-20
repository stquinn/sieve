package sieve

import (
	"sieve/logger"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/services"
	"sieve/store"
	"time"
)

type ServiceProvider struct {
	Store       store.Store
	Library     services.LibraryService
	Documents   *services.DocumentService
	Assets      *services.AssetService
	State       *services.StateService
	Prompts     *ai.PromptService
	AI          *ai.AIService
	Editor      *services.EditorService
	Jobs        *services.JobTracker
	LinkPreview *services.LinkPreviewService
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
	_ block.DocumentsPort   = (*services.DocumentService)(nil)
	_ block.AssetsPort      = (*services.AssetService)(nil)
	_ block.StatePort       = (*services.StateService)(nil)
	_ block.LinkPreviewPort = (*services.LinkPreviewService)(nil)
	_ block.AIPort          = (*ai.AIService)(nil)
)

func (s *ServiceProvider) Init(store store.Store, storePath string) {
	s.Store = store
	var err error

	s.Documents, err = services.NewDocumentService(store)
	if err != nil {
		logger.Error("buffers init failed", "err", err)
		return
	}
	s.Assets = services.NewAssetService(store)
	s.State, err = services.NewStateService(store)
	if err != nil {
		logger.Error("state init failed", "err", err)
		return
	}
	s.Prompts, err = ai.NewPromptService(store)
	if err != nil {
		logger.Error("prompts init failed", "err", err)
		return
	}
	s.AI = ai.NewAIService(s.State, s.Prompts, s.Documents, storePath)
	s.LinkPreview = services.NewLinkPreviewService()
	settings := s.State.LoadSettings()
	autosave := time.Duration(settings.AutosaveDebounce) * time.Second
	s.Editor = services.NewEditorService(s.Documents, block.NewDocumentCodec(block.GlobalRegistry()), autosave)
	s.Editor.SetServices(s.BlockServices())
	s.Editor.SetJobs(s.Jobs) // re-set in handlers.go once the real JobTracker (with hub) exists
	svc := s.BlockServices()
	block.RegisterProcessor("diagram", processors.NewDiagramProcessor(svc))
	block.RegisterProcessor("smart-image", processors.NewSmartImageProcessor(svc))

	block.RegisterProcessor("smart-link", processors.NewSmartLinkProcessor(svc))
	block.RegisterProcessor("smart-card", processors.NewSmartCardProcessor(svc))
	block.RegisterProcessor("web-clip", processors.NewWebClipBlockProcessor(svc))
	block.RegisterProcessor("log", processors.NewLogProcessor(svc))
	block.RegisterProcessor("code", processors.NewCodeBlockProcessor(svc))

	block.RegisterProcessor("ai-block", processors.NewAIBlockProcessor(svc))
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
