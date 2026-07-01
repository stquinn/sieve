package sieve

import (
	"sieve/logger"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/editor"
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
	Editor      *editor.EditorService
	Jobs        *services.JobTracker
	Engine      *services.JobEngine
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
	s.Editor = editor.NewEditorService(s.Documents, block.NewDocumentCodec(block.GlobalRegistry()), autosave)
	s.Editor.SetServices(s.BlockServices())
	s.Editor.SetJobs(s.Jobs) // s.Jobs is the hub-wired tracker set by newAPIHandler before startup
	// Communal JobEngine + Editor wiring. Built HERE (not in newAPIHandler) because
	// it needs settings (State) and the Editor, which only exist after Init. The
	// "ai" pool defaults to 3 (spec Global Constraint); explicit worker_pools config
	// wins; other unconfigured categories fall to defaultWorkers.
	const defaultWorkers = 4
	poolSizes := map[string]int{block.CategoryAI: 3}
	for k, v := range settings.WorkerPools {
		poolSizes[k] = v
	}
	s.Engine = services.NewJobEngine(poolSizes, defaultWorkers, s.Jobs)
	s.Editor.SetEngine(s.Engine)
	s.Editor.SetAI(s.AI)
	svc := s.BlockServices()
	block.RegisterProcessor(processors.NewDiagramProcessor(svc))
	block.RegisterProcessor(processors.NewSmartImageProcessor(svc))

	block.RegisterProcessor(processors.NewSmartLinkProcessor(svc))
	block.RegisterProcessor(processors.NewSmartCardProcessor(svc))
	block.RegisterProcessor(processors.NewWebClipBlockProcessor(svc))
	block.RegisterProcessor(processors.NewLogProcessor(svc))
	block.RegisterProcessor(processors.NewCodeBlockProcessor(svc))

	block.RegisterProcessor(processors.NewAIBlockProcessor(svc))
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
