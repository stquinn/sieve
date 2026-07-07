package sieve

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"sieve/config"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// FileLibraryService is THE single implementation of services.LibraryService for
// the file-backed store. It owns everything about a library: discovery, recents,
// validation and naming (the policy half) AND the lifecycle of opening/switching/
// initialising it (Open/Switch/InitAt). It lives in package sieve rather than
// package services because Open must call ServiceProvider.Init and construct a
// concrete filestore.FileStore — dependencies package services cannot import
// without a cycle.
//
// It also owns the file-backend-specific path/layout knowledge (NotesDir,
// ResolvePath, ThemeOverride, StoreInfo) that used to live in the Wails App.
// Those accessors are deliberately kept OFF the services.LibraryService
// interface — they assume a filesystem layout and would break the "Ref is
// opaque" contract for a future S3/URL backend. The App (composition-root
// adjacent) holds the concrete *FileLibraryService so it can reach them without
// inventing a second interface; everyone else holds services.LibraryService.
type FileLibraryService struct {
	// ── policy state ──────────────────────────────────────────────────────────
	// attachMu guards currentID and namer, which are written by Attach/RecordSwitch
	// on the startup goroutine and read by Current/Recent on HTTP goroutines (the
	// status-bar chip refetches via /api/library/current on library:changed).
	// recorder and validate are set once at construction and never mutated.
	attachMu  sync.RWMutex
	currentID string
	namer     services.LibraryNamer // nil until Attach is called
	recorder  services.LibraryRecorder
	validate  func(string) error

	// ── lifecycle state ───────────────────────────────────────────────────────
	sp        *ServiceProvider
	broadcast func(string, string) // SSE hub broadcast; nil-safe
	themesFS  fs.FS

	// openMu guards the Open critical section (path resolution → store construction
	// → ServiceProvider.Init → service pointer swap → Attach/RecordSwitch/broadcast).
	// Open is re-entrantly invoked — once by the Wails startup callback and again by
	// every user-driven switch/init — so this serialisation lives with the data it
	// protects. It is distinct from attachMu: Open (holding openMu) calls Attach
	// (which takes attachMu), so they must be separate locks. Path accessors read
	// storePath lock-free (matching the original App, which read a.storePath without
	// a lock), which also avoids self-deadlock when the onOpened hook reads NotesDir.
	openMu    sync.Mutex
	storePath string
	hostname  string

	onOpened func() // App-scoped side effects (watcher re-arm + window geometry)
}

// Compile-time proof the concrete type satisfies the full LibraryService.
var _ services.LibraryService = (*FileLibraryService)(nil)

// NewLibraryService constructs the one file-backed LibraryService.
//   - recorder:  persists the machine-level recents list (config.GlobalConfig)
//   - validate:  reports whether an ID can be opened (config.Recorder.ValidateStore)
//   - sp:        the composition root whose services Open (re)wires
//   - broadcast: SSE hub broadcast, invoked on library:changed
//   - themesFS:  embedded built-in themes filesystem (for StoreInfo/theme override)
//
// Call SetStorePath with the cold-start discovery result before Wails startup, or
// let the first Open receive the path directly.
func NewLibraryService(recorder services.LibraryRecorder, validate func(string) error, sp *ServiceProvider, broadcast func(string, string), themesFS fs.FS) *FileLibraryService {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "localhost"
	}
	return &FileLibraryService{
		recorder:  recorder,
		validate:  validate,
		sp:        sp,
		broadcast: broadcast,
		themesFS:  themesFS,
		hostname:  hostname,
	}
}

// SetStorePath seeds the store path chosen by cold-start discovery
// (BestOnStartup). Called once during composition, before Wails startup opens it.
func (l *FileLibraryService) SetStorePath(path string) { l.storePath = path }

// OnOpened registers a hook run at the end of every successful Open, on the same
// goroutine. The App uses it to re-arm the notes watcher and restore window
// geometry — App-scoped concerns that stay in the native shell.
func (l *FileLibraryService) OnOpened(fn func()) { l.onOpened = fn }

// ── Policy: discovery / recents / validation / naming ─────────────────────────

func (l *FileLibraryService) BestOnStartup(cliArg, envVar string) string {
	if cliArg != "" {
		return cliArg
	}
	if envVar != "" {
		if l.validate == nil || l.validate(envVar) == nil {
			return envVar
		}
	}
	// Walk recents — return first one that still validates.
	for _, lib := range l.recorder.Recent() {
		if l.validate == nil || l.validate(lib.Ref) == nil {
			return lib.Ref
		}
	}
	// Legacy fallback: last-used path from older config format.
	if last := l.recorder.LastUsed(); last != "" {
		if l.validate == nil || l.validate(last) == nil {
			return last
		}
	}
	// Final fallback: current working directory.
	if cwd, err := os.Getwd(); err == nil {
		if l.validate == nil || l.validate(cwd) == nil {
			return cwd
		}
	}
	return ""
}

func (l *FileLibraryService) Attach(id string, namer services.LibraryNamer) {
	l.attachMu.Lock()
	l.currentID = id
	l.namer = namer
	l.attachMu.Unlock()
}

func (l *FileLibraryService) Current() services.Library {
	l.attachMu.RLock()
	id, namer := l.currentID, l.namer
	l.attachMu.RUnlock()
	name := ""
	if namer != nil {
		name = namer.LibraryName()
	}
	if name == "" {
		name = services.LibraryDisplayName(id)
	}
	return services.Library{Ref: id, Name: name}
}

func (l *FileLibraryService) Recent() []services.Library {
	return l.recorder.Recent()
}

func (l *FileLibraryService) Validate(id string) error {
	if l.validate != nil {
		return l.validate(id)
	}
	return nil
}

func (l *FileLibraryService) RecordSwitch(id string) {
	l.attachMu.RLock()
	namer := l.namer
	l.attachMu.RUnlock()
	l.recorder.SetLastUsed(id)
	name := ""
	if namer != nil {
		name = namer.LibraryName()
	}
	if name == "" {
		name = services.LibraryDisplayName(id)
	}
	l.recorder.AddRecent(services.Library{Ref: id, Name: name})
}

func (l *FileLibraryService) DisplayName(id string) string {
	return services.LibraryDisplayName(id)
}

// ── Lifecycle: open / switch / init ───────────────────────────────────────────

// Open resolves, validates and opens the library at path. Everything the Wails
// App.startup used to do EXCEPT window geometry and the watcher (delegated to
// the onOpened hook). Returns the resolved store path, or "" for bootstrap mode.
func (l *FileLibraryService) Open(path string, isFirstStartup bool) (string, error) {
	l.openMu.Lock()
	defer l.openMu.Unlock()

	l.storePath = path

	abs, _ := filepath.Abs(l.storePath)
	logger.Info("startup", "vault_raw", l.storePath, "vault_abs", abs)

	if l.storePath == "" {
		logger.Info("startup: no store path specified — entering bootstrap mode")
		return "", nil
	}

	logger.Info("startup: beginning validation", "isFirstStartup", isFirstStartup, "storePath", abs)

	if err := l.Validate(abs); err != nil {
		logger.Warn("startup: validation failed", "path", abs, "err", err)
		entries, readErr := os.ReadDir(abs)
		isEmpty := readErr == nil && len(entries) == 0
		logger.Debug("startup: empty directory check", "isEmpty", isEmpty, "entriesCount", len(entries))

		if !isEmpty {
			// Not a valid store and not empty — fall back to best available library.
			if isFirstStartup {
				fallback := l.BestOnStartup("", "")
				if fallback != "" && fallback != abs {
					abs = fallback
					logger.Info("startup: falling back to best available library", "path", abs)
				} else {
					l.storePath = ""
					logger.Info("startup: entering bootstrap mode — no valid library found")
					return "", nil
				}
			} else {
				l.storePath = ""
				logger.Warn("startup: explicit path is invalid, re-entering bootstrap mode")
				return "", nil
			}
		} else {
			logger.Info("startup: path is empty, proceeding with initialisation", "path", abs)
		}
	} else {
		logger.Info("startup: path is a valid store", "path", abs)
	}

	l.storePath = abs

	// Resolve hostname (may differ from the one set at construction).
	if hn, err := os.Hostname(); err == nil && hn != "" {
		l.hostname = hn
	}

	// ── FileStore-backed services ─────────────────────────────────────────────
	fstore, err := filestore.NewFileStore(l.storePath, l.hostname)
	if err != nil {
		logger.Error("filestore init failed", "err", err)
		return l.storePath, err
	}
	l.sp.Init(fstore, l.storePath)

	settings := l.sp.State.LoadSettings()

	// Attach the library service to the live store and record this switch.
	l.Attach(l.storePath, fstore)
	l.RecordSwitch(l.storePath)
	l.sp.Library = l
	if l.broadcast != nil {
		l.broadcast("library:changed", "")
	}

	logger.Info("store ready",
		"root", l.storePath,
		"hostname", l.hostname,
		"tier", settings.Tier(),
		"autosave_debounce", settings.AutosaveDebounce,
		"debug", settings.Debug,
	)

	// Startup probe.
	probe := filepath.Join(l.storePath, ".startup-probe")
	_ = os.WriteFile(probe, []byte(fmt.Sprintf("started at %s\nvault: %s\nhost:  %s\n",
		time.Now().Format(time.RFC3339), l.storePath, l.hostname)), 0o644)

	if l.onOpened != nil {
		l.onOpened()
	}
	return l.storePath, nil
}

// Switch closes the active editor then opens the library at path.
func (l *FileLibraryService) Switch(path string) (string, error) {
	if err := l.Validate(path); err != nil {
		return "", fmt.Errorf("invalid library: %w", err)
	}
	if l.sp != nil && l.sp.Editor != nil {
		// CloseAll (not FlushAll): Open below replaces this EditorService, so we
		// must stop its armed autosave timers too, or they fire a delayed write
		// against the old library after the switch. See EditorService.CloseAll.
		l.sp.Editor.CloseAll()
	}
	// Open reports bootstrap rejection via an empty result (legacy contract); its
	// error is a hard filestore failure, which the original startup path also
	// treated as a non-fatal "opened" outcome — preserve that by keying on result.
	result, _ := l.Open(path, false)
	if result == "" {
		return "", fmt.Errorf("failed to load the selected library")
	}
	return result, nil
}

// InitAt creates the directory at path (expanding ~), opens it, and records it as
// the last-used store in global config.
func (l *FileLibraryService) InitAt(path string) error {
	logger.Info("InitVault: triggered", "raw_path", path)
	if path == "" {
		return fmt.Errorf("path cannot be empty")
	}
	if strings.HasPrefix(path, "~") {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, path[1:])
		logger.Debug("InitVault: resolved tilde", "new_path", path)
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		logger.Error("InitVault: absolute path resolution failed", "err", err)
		return fmt.Errorf("invalid path: %w", err)
	}
	logger.Debug("InitVault: absolute path determined", "abs", abs)

	if err := os.MkdirAll(abs, 0o755); err != nil {
		logger.Error("InitVault: MkdirAll failed", "abs", abs, "err", err)
		return fmt.Errorf("could not create directory: %w", err)
	}
	logger.Debug("InitVault: directory exists/created", "abs", abs)

	logger.Debug("InitVault: setting storePath and calling startup", "abs", abs)
	result, _ := l.Open(abs, false)

	logger.Debug("InitVault: startup completed", "resulting_storePath", result)
	if result == "" {
		logger.Warn("InitVault: startup rejected the folder")
		return fmt.Errorf("folder must be empty or an existing Sieve store")
	}

	cfg := config.LoadGlobalConfig()
	cfg.LastStorePath = abs
	if err := cfg.Save(); err != nil {
		logger.Warn("InitVault: failed to save global config", "err", err)
		return fmt.Errorf("could not update global config: %w", err)
	}
	logger.Info("store initialized manually — READY", "path", abs)
	return nil
}

// ── Path / layout accessors (file-backend specific — off the interface) ───────

// StorePath returns the active store root path.
func (l *FileLibraryService) StorePath() string { return l.storePath }

// NotesDir returns the notes directory ({storePath}/store).
func (l *FileLibraryService) NotesDir() string { return filepath.Join(l.storePath, "store") }

// PromptsDir returns the per-host prompts directory.
func (l *FileLibraryService) PromptsDir() string {
	return filepath.Join(l.storePath, l.hostname, "prompts")
}

// ThemesFS returns the embedded built-in themes filesystem.
func (l *FileLibraryService) ThemesFS() fs.FS { return l.themesFS }

// ResolvePath converts a store-relative path to an absolute filesystem path.
func (l *FileLibraryService) ResolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	if l.storePath != "" {
		return filepath.Join(l.storePath, path)
	}
	return path
}

// ThemeOverride reads the store-local theme override file for name, if any.
// Returns nil when no override exists or the store is not open.
func (l *FileLibraryService) ThemeOverride(name string) []byte {
	if l.storePath == "" || name == "" {
		return nil
	}
	data, _ := os.ReadFile(filepath.Join(l.storePath, "themes", name+".json"))
	return data
}

// ── Store info ────────────────────────────────────────────────────────────────

// StoreInfo describes the active store for the frontend (index render). It is
// pure store/settings/theme data owned by the library service.
type StoreInfo struct {
	Root               string      `json:"root"`
	Hostname           string      `json:"hostname"`
	BuffersPath        string      `json:"buffersPath"`
	NotesPath          string      `json:"notesPath"`
	IsNew              bool        `json:"isNew"`
	Tier               domain.Tier `json:"tier"`
	Cli                string      `json:"cli"`
	Debug              bool        `json:"debug"`
	AutosaveDebounce   int         `json:"autosaveDebounce"`
	ThemeName          string      `json:"themeName"`
	ThemeVars          ThemeVars   `json:"themeVars"`
	MaxHistoryVersions int         `json:"maxHistoryVersions"`
	CLITimeoutLong     int         `json:"cliTimeoutLong"`
	ShowPrompts        bool        `json:"showPrompts"`
}

// StoreInfo builds the live StoreInfo. Returns a near-empty value (matching the
// old App behaviour) when no store is open.
func (l *FileLibraryService) StoreInfo() StoreInfo {
	if l.storePath == "" || l.sp.State == nil {
		logger.Warn("getStoreInfo: store not open")
		return StoreInfo{
			ThemeVars: ThemeVars{},
		}
	}

	logger.Info("getStoreInfo", "root", l.storePath)
	liveSettings := l.sp.State.LoadSettings()

	return StoreInfo{
		Root:               l.storePath,
		Hostname:           l.hostname,
		BuffersPath:        filepath.Join(l.storePath, l.hostname, "buffers"),
		NotesPath:          l.NotesDir(),
		IsNew:              l.sp.Documents.Count() == 0,
		Tier:               liveSettings.Tier(),
		Cli:                liveSettings.CLI,
		Debug:              liveSettings.Debug,
		AutosaveDebounce:   liveSettings.AutosaveDebounce,
		ThemeName:          liveSettings.Theme,
		ThemeVars:          LoadTheme(liveSettings.Theme, l.ThemeOverride(liveSettings.Theme), l.themesFS),
		MaxHistoryVersions: liveSettings.MaxHistoryVersions,
		CLITimeoutLong:     liveSettings.CLITimeoutLong,
		ShowPrompts:        l.sp.State.LoadSession().ShowPrompts,
	}
}
