package sieve

import (
	"io/fs"
	"sieve/clipboard"
	"sieve/logger"
	"sieve/nativedrop"
	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/command"
	"sieve/sieve/editor"
	"sieve/sieve/mcp"
	"sieve/sieve/services"
	"sieve/store"
	"time"
)

type ServiceProvider struct {
	Store       store.Store
	Library     services.LibraryService
	Documents   *services.DocumentService
	Nodes       *editor.Router
	Assets      *services.AssetService
	State       *services.StateService
	Prompts     *ai.PromptService
	AI          *ai.AIService
	Editor      *editor.EditorService
	Inspection  *editor.InspectionEngine
	Spell       *editor.SpellInspector
	Find        *editor.FindInspector
	Jobs        *services.JobTracker
	Engine      *services.JobEngine
	Commands    *command.Registry
	LinkPreview *services.LinkPreviewService
	Plantuml    *services.PlantumlService
	MCP         *mcp.Server
	// Invalidator carries a command's "this changed" to the connected clients. It
	// is set by the composition root before Init, because the push side lives
	// above this package and a command may only name the port.
	Invalidator command.NotesInvalidator
	// SavedNotifier publishes "this container's content reached disk" to the
	// connected clients. Set by the composition root before Init for the same
	// reason Invalidator is, and handed to the Editor there.
	SavedNotifier editor.ContainerSavedNotifier
}

// RegisterInspectors admits every text-service producer to the inspection
// engine, under the channel that controls it: spelling has one answer for the
// whole app and is switched from the workspace wire, find belongs to the dialog
// that is asking and is switched from that document's own channel.
//
// It is the ONE registration site, so a harness that stands the engine up
// without Init still gets exactly the producers the app has — and the wire's
// published feature vocabulary is checkable against the producers that exist,
// since a word nothing here registers is a switch that refuses every frame.
//
// Requires Inspection and Editor; the dictionary comes in because parsing one
// is expensive enough that a caller decides when it happens.
func (s *ServiceProvider) RegisterInspectors(spell *services.SpellService) {
	s.Spell = editor.NewSpellInspector(spell, s.Inspection)
	s.Inspection.Register(s.Spell, editor.ScopeWorkspace)
	s.Find = editor.NewFindInspector(s.Editor)
	s.Inspection.Register(s.Find, editor.ScopeDocument)
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
		Plantuml:    s.Plantuml,
		// The Router, as the one-method interface block/ declares for itself, so a
		// processor dereferences an address through the same registry the @
		// picker and MCP get_by_uri read through.
		Nodes: s.Nodes,
	}
}

// CommandSet returns every slash command the app registers, in registration
// order. It is the ONE list: Init registers what this returns, and the protocol
// generator enumerates the same call to publish the verbs — so a command added
// here reaches the app and the generated artifacts together, or neither. A
// command registered anywhere else exists on the wire and in no document.
//
// It is safe to call on a zero ServiceProvider, which is how the generator reads
// the verbs without standing an app up: every constructor below only stores its
// dependencies, so the commands answer Name(), Description() and Family()
// honestly and would fail their own preconditions in Build — which the generator
// never calls.
func (s *ServiceProvider) CommandSet() []command.Command {
	return []command.Command{
		ai.NewBtwCommand(s.AI, s.Documents),
		command.NewNowCommand(),
		command.NewStatsCommand(s.Documents),
		command.NewUUIDCommand(),
		// The sweeper lives in editor/ because only that package sees both the block
		// codec and the document service; command/ cannot import block/ at all.
		command.NewMigrateIDsCommand(
			editor.NewIdentitySweeper(s.Documents, block.NewDocumentCodec(block.GlobalRegistry()))),
		command.NewHashCommand(s.Documents),
		command.NewBase64Command(s.Documents),
		command.NewEnvCommand(),
		command.NewJWTCommand(),
		ai.NewSummaryCommand(s.AI, s.Documents),
		ai.NewTodoCommand(s.AI, s.Documents),
		// The filing family. The EditorService goes in as command.DocumentFiler for
		// the reason the sweeper goes in as IdentitySweeper: command/ cannot import
		// editor/, so the port is declared where it is driven and satisfied here.
		command.NewFileCommand(s.Editor, s.Documents),
		command.NewMetadataCommand(s.Editor, s.Documents),
		command.NewKeepAndFileCommand(s.Editor, s.Documents, s.Invalidator),
	}
}

// Compile-time proof the concrete services satisfy the ports their consumers
// declare. Lives at the composition root — the only place that knows both the
// ports and the concretes.
var (
	_ block.DocumentsPort   = (*services.DocumentService)(nil)
	_ mcp.NodeResolver      = (*editor.Router)(nil)
	_ block.AssetsPort      = (*services.AssetService)(nil)
	_ block.StatePort       = (*services.StateService)(nil)
	_ block.LinkPreviewPort = (*services.LinkPreviewService)(nil)
	_ block.PlantumlPort    = (*services.PlantumlService)(nil)
	_ block.NodesPort       = (*editor.Router)(nil)
	_ command.DocumentFiler = (*editor.EditorService)(nil)
)

func (s *ServiceProvider) Init(store store.Store, storePath string, themesFS fs.FS) {
	s.Store = store
	var err error

	s.Documents, err = services.NewDocumentService(store)
	if err != nil {
		logger.Error("buffers init failed", "err", err)
		return
	}
	// The Router: address → NodeDescriptor. Registering a source is the ONE line
	// that makes a container kind mentionable, and a source may only offer what
	// can also be dereferenced — so notes only, because that is what MCP
	// get_by_uri reaches through this same Router.
	s.Nodes = editor.NewRouter(editor.NewNotesSource(s.Documents))
	s.Assets = services.NewAssetService(store, storePath)
	s.State, err = services.NewStateService(store, storePath, themesFS)
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
	// Internal Sieve MCP: read-only knowledge-base surface mounted at /mcp,
	// injected into contained CLI calls. Its runtime URL (the localhost listener
	// port) is set from main once the listener binds; the AI service pulls the
	// URL + a per-call bearer token from it at profile-render time.
	//
	// The Router goes in as mcp.NodeResolver — the one-method interface the MCP
	// package declares for itself — so get_by_uri dereferences addresses through
	// the same registry the @ picker offers them from.
	s.MCP = mcp.NewServer(s.Documents, s.Nodes)
	s.AI.SetMCPEndpoint(s.MCP)
	s.Commands = command.NewRegistry()
	s.LinkPreview = services.NewLinkPreviewService()
	s.Plantuml = services.NewPlantumlService(s.State)
	settings := s.State.LoadSettings()
	s.ApplyRetention(settings.MaxHistoryVersions)
	autosave := time.Duration(settings.AutosaveDebounce) * time.Second
	s.Editor = editor.NewEditorService(s.Documents, block.NewDocumentCodec(block.GlobalRegistry()), autosave)
	s.Editor.SetServices(s.BlockServices())
	// The OS clipboard, read outside the webview. On a cgo-off build this is the
	// package's no-op half, so a native-clipboard paste answers "nothing" rather
	// than failing.
	s.Editor.SetNativeClipboard(clipboard.New())
	s.Editor.SetPendingDrops(nativedrop.Default)
	if s.SavedNotifier != nil {
		s.Editor.SetSavedNotifier(s.SavedNotifier)
	}
	s.Editor.SetJobs(s.Jobs) // s.Jobs is the tracker main() builds and wires into the broadcast before startup — no hub exists
	// Inspection reads the open documents the Editor owns, so it is built with it
	// and after it. The dictionary parse happens here, once.
	s.Inspection = editor.NewInspectionEngine(s.Editor)
	s.RegisterInspectors(services.NewSpellService(s.State))
	// The persisted setting is applied through the SAME path a control frame
	// takes, so a run that starts checking and a run that is switched on midway
	// arrive at their state one way.
	if err := s.Inspection.SetWorkspaceFeature(s.Spell.Feature(), settings.SpellcheckEnabled(), nil); err != nil {
		logger.Error("sieve: could not apply the spellcheck setting", "err", err)
	}
	// The Editor observes the engine back so a live op enqueues a recheck the
	// same way the open-time seed does — one drain path for both — and a focus
	// change re-checks what the reader is now looking at.
	s.Editor.SetInspectionEngine(s.Inspection)
	s.Editor.SetFocusListener(s.Inspection)
	// Communal JobEngine + Editor wiring. Built HERE (not in newAPIHandler) because
	// it needs settings (State) and the Editor, which only exist after Init. The
	// "ai" pool defaults to 3 (spec Global Constraint); explicit worker_pools config
	// wins; other unconfigured categories fall to defaultWorkers.
	const defaultWorkers = 4
	poolSizes := map[string]int{
		block.CategoryAI: 3,
		command.Category: 2,
	}
	for k, v := range settings.WorkerPools {
		poolSizes[k] = v
	}
	s.Engine = services.NewJobEngine(poolSizes, defaultWorkers, s.Jobs)
	s.Editor.SetEngine(s.Engine)
	s.Editor.SetAI(s.AI)
	s.Commands.SetEngine(s.Engine)
	for _, cmd := range s.CommandSet() {
		s.Commands.Register(cmd)
	}
	svc := s.BlockServices()
	block.RegisterProcessor(processors.NewDiagramProcessor(svc))
	block.RegisterProcessor(processors.NewSmartImageProcessor(svc))
	block.RegisterProcessor(processors.NewSmartCardProcessor(svc))
	block.RegisterProcessor(processors.NewReferenceProcessor(svc))
	block.RegisterProcessor(processors.NewWebClipBlockProcessor(svc))
	block.RegisterProcessor(processors.NewLogProcessor(svc))
	block.RegisterProcessor(processors.NewCodeBlockProcessor(svc))

	block.RegisterProcessor(processors.NewAIBlockProcessor(svc))
}

// ApplyRetention pushes the history-retention limit into the concrete store so
// snapshot pruning honours the user's max_history_versions setting. n <= 0 is
// ignored (keeps the current limit). The type assertion lives here — the
// composition root is the one place that legitimately knows both the
// store.Store interface and its concrete FileStore capability; retention is not
// part of the persistence boundary contract, so it is not on store.Store.
func (s *ServiceProvider) ApplyRetention(n int) {
	if n <= 0 || s.Store == nil {
		return
	}
	if setter, ok := s.Store.(interface{ SetMaxVersions(int) }); ok {
		setter.SetMaxVersions(n)
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
