package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/store/filestore"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application backend.
type App struct {
	ctx       context.Context
	storePath string
	hostname  string // resolved at startup from os.Hostname

	ServiceProvider *sieve.ServiceProvider
	Buffers         *sieve.BufferService
	Notes           *sieve.NoteService
	Assets          *sieve.AssetService
	State           *sieve.StateService
	Prompts         *sieve.PromptService

	themesFS fs.FS
	hub      *sseHub
	watcher  *notesWatcher
	closing  bool
	mu       sync.Mutex
}

func NewApp(storePath string, themesFS fs.FS, hub *sseHub, serviceProvider *sieve.ServiceProvider) *App {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "localhost"
	}

	return &App{
		storePath:       storePath,
		hostname:        hostname,
		themesFS:        themesFS,
		hub:             hub,
		ServiceProvider: serviceProvider,
	}
}

// ── Path helpers ──────────────────────────────────────────────────────────────

// configDir returns the absolute path to the per-host config directory
// ({storePath}/{hostname}/config/). Used for state migration only.
func (a *App) configDir() string {
	return filepath.Join(a.storePath, a.hostname, "config")
}

func (a *App) notesDir() string {
	return filepath.Join(a.storePath, "store")
}

func (a *App) promptsDir() string {
	return filepath.Join(a.storePath, a.hostname, "prompts")
}

// GetThemesFS returns the embedded themes filesystem.
func (a *App) GetThemesFS() fs.FS { return a.themesFS }

// GetStorePath returns the active store root path.
func (a *App) GetStorePath() string { return a.storePath }

// LoadSettings returns the current settings via the StateService, or defaults
// if the store is not yet open.
func (a *App) LoadSettings() sieve.Settings {
	if a.State != nil {
		return a.State.LoadSettings()
	}
	return sieve.DefaultSettings()
}

// SaveSettings persists user configuration to the store.
func (a *App) SaveSettings(settings sieve.Settings) error {
	if a.State == nil {
		return fmt.Errorf("store not open")
	}
	logger.Info("SaveSettings", "cli", settings.CLI, "model", settings.Model, "theme", settings.Theme)
	return a.State.SaveSettings(settings)
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// startup is called by Wails when the application window is ready.
func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()

	isFirstStartup := a.ctx == nil
	a.ctx = ctx

	if a.storePath == "" && isFirstStartup {
		config := LoadGlobalConfig()
		if config.LastStorePath != "" {
			if err := ValidateStore(config.LastStorePath); err == nil {
				a.storePath = config.LastStorePath
				logger.Info("startup: using LastStorePath", "path", a.storePath)
			} else {
				logger.Warn("startup: LastStorePath rejected", "path", config.LastStorePath, "err", err)
			}
		}
	}

	abs, _ := filepath.Abs(a.storePath)
	logger.Info("startup", "vault_raw", a.storePath, "vault_abs", abs)

	if a.storePath == "" {
		logger.Info("startup: no store path specified — entering bootstrap mode")
		return
	}

	logger.Info("startup: beginning validation", "isFirstStartup", isFirstStartup, "storePath", abs)

	if err := ValidateStore(abs); err != nil {
		logger.Warn("startup: ValidateStore failed", "path", abs, "err", err)
		entries, readErr := os.ReadDir(abs)
		isEmpty := readErr == nil && len(entries) == 0
		logger.Debug("startup: empty directory check", "isEmpty", isEmpty, "readErr", readErr, "entriesCount", len(entries))

		if !isEmpty {
			logger.Warn("startup: path is neither a valid store nor empty", "path", abs)
			if isFirstStartup {
				config := LoadGlobalConfig()
				if config.LastStorePath != "" {
					if fallbackErr := ValidateStore(config.LastStorePath); fallbackErr == nil {
						abs = config.LastStorePath
						logger.Info("startup: falling back to LastStorePath", "path", abs)
					} else {
						logger.Warn("startup: fallback LastStorePath rejected", "path", config.LastStorePath, "err", fallbackErr)
						a.storePath = ""
						logger.Info("startup: entering bootstrap mode from invalid implicit path")
						return
					}
				} else {
					a.storePath = ""
					logger.Info("startup: entering bootstrap mode from invalid implicit path")
					return
				}
			} else {
				// This is an explicit selection from the UI (CreateVault/InitVault) that is invalid.
				a.storePath = ""
				logger.Warn("startup: explicit path is invalid, re-entering bootstrap mode")
				return
			}
		} else {
			logger.Info("startup: path is empty, proceeding with initialization", "path", abs)
		}
	} else {
		logger.Info("startup: path is a valid store", "path", abs)
	}

	a.storePath = abs

	// Resolve hostname (may differ from the one set in NewApp if called again).
	if hn, err := os.Hostname(); err == nil && hn != "" {
		a.hostname = hn
	}

	// Close old watcher if any.
	if a.watcher != nil {
		a.watcher.Close()
		a.watcher = nil
	}

	// ── One-time state migration: move settings/session to config/ ────────────
	migrateStateFiles(
		filepath.Join(a.storePath, a.hostname),
		a.configDir(),
	)

	// ── FileStore-backed services ─────────────────────────────────────────────
	fs, err := filestore.NewFileStore(a.storePath, a.hostname)
	if err != nil {
		logger.Error("filestore init failed", "err", err)
		return
	}
	a.ServiceProvider.Init(fs)

	a.Notes = a.ServiceProvider.Notes
	a.Buffers = a.ServiceProvider.Buffers
	a.State = a.ServiceProvider.State
	a.Prompts = a.ServiceProvider.Prompts

	settings := a.State.LoadSettings()

	// Save last-used store path.
	config := LoadGlobalConfig()
	config.LastStorePath = a.storePath
	if err := config.Save(); err != nil {
		logger.Warn("could not save global config", "err", err)
	}

	logger.Info("store ready",
		"root", a.storePath,
		"hostname", a.hostname,
		"tier", settings.Tier(),
		"autosave_debounce", settings.AutosaveDebounce,
		"debug", settings.Debug,
	)

	// Startup probe.
	probe := filepath.Join(a.storePath, ".startup-probe")
	_ = os.WriteFile(probe, []byte(fmt.Sprintf("started at %s\nvault: %s\nhost:  %s\n",
		time.Now().Format(time.RFC3339), a.storePath, a.hostname)), 0o644)

	// Restore window geometry.
	savedSession := a.ServiceProvider.State.LoadSession()
	if savedSession.Window.Width >= 800 && savedSession.Window.Height >= 500 {
		runtime.WindowSetSize(ctx, savedSession.Window.Width, savedSession.Window.Height)
		logger.Debug("window size restored", "w", savedSession.Window.Width, "h", savedSession.Window.Height)
	}
	win := savedSession.Window
	if win.X > -4000 && win.Y > -4000 {
		runtime.WindowSetPosition(ctx, win.X, win.Y)
		logger.Debug("window position restored", "x", win.X, "y", win.Y)
	}

	// File-system watcher for notes.
	w, err := newNotesWatcher(a.notesDir(), func() {
		logger.Debug("notes changed — emitting event")
		runtime.EventsEmit(a.ctx, "notes:changed")
		if a.hub != nil {
			a.hub.broadcast("notes:changed", "{}")
		}
	})
	if err != nil {
		logger.Warn("could not start notes watcher", "err", err)
	} else {
		a.watcher = w
	}
}

func (a *App) beforeClose(ctx context.Context) bool {
	if a.closing {
		return false
	}
	if a.State != nil {
		x, y := runtime.WindowGetPosition(ctx)
		w, h := runtime.WindowGetSize(ctx)
		session := a.State.LoadSession()
		session.Window = sieve.Window{X: x, Y: y, Width: w, Height: h}
		_ = a.State.SaveSession(session)
	}
	logger.Info("beforeClose: vetoing and requesting flush")
	runtime.EventsEmit(ctx, "app:closing")
	return true
}

func (a *App) Quit() {
	if a.closing {
		return
	}
	a.closing = true
	logger.Info("App.Quit: exiting")
	if a.watcher != nil {
		a.watcher.Close()
	}
	runtime.Quit(a.ctx)
	go func() {
		time.Sleep(500 * time.Millisecond)
		logger.Warn("App.Quit: runtime.Quit timed out, forcing os.Exit")
		os.Exit(0)
	}()
}

// ── Store info ────────────────────────────────────────────────────────────────

type StoreInfo struct {
	Root               string          `json:"root"`
	Hostname           string          `json:"hostname"`
	BuffersPath        string          `json:"buffersPath"`
	NotesPath          string          `json:"notesPath"`
	IsNew              bool            `json:"isNew"`
	Tier               sieve.Tier      `json:"tier"`
	Cli                string          `json:"cli"`
	Debug              bool            `json:"debug"`
	AutosaveDebounce   int             `json:"autosaveDebounce"`
	ThemeName          string          `json:"themeName"`
	ThemeVars          sieve.ThemeVars `json:"themeVars"`
	MaxHistoryVersions int             `json:"maxHistoryVersions"`
	CLITimeoutLong     int             `json:"cliTimeoutLong"`
	ShowPrompts        bool            `json:"showPrompts"`
}

func (a *App) GetStoreInfo() StoreInfo {
	if a.storePath == "" {
		logger.Warn("GetStoreInfo: store not open")
		return StoreInfo{
			ThemeVars: sieve.ThemeVars{},
		}
	}

	logger.Info("GetStoreInfo", "root", a.storePath)
	liveSettings := a.State.LoadSettings()

	return StoreInfo{
		Root:               a.storePath,
		Hostname:           a.hostname,
		BuffersPath:        filepath.Join(a.storePath, a.hostname, "buffers"),
		NotesPath:          a.notesDir(),
		IsNew:              a.Notes.Count() == 0,
		Tier:               liveSettings.Tier(),
		Cli:                liveSettings.CLI,
		Debug:              liveSettings.Debug,
		AutosaveDebounce:   liveSettings.AutosaveDebounce,
		ThemeName:          liveSettings.Theme,
		ThemeVars:          sieve.LoadTheme(liveSettings.Theme, a.loadThemeOverride(liveSettings.Theme), a.themesFS),
		MaxHistoryVersions: liveSettings.MaxHistoryVersions,
		CLITimeoutLong:     liveSettings.CLITimeoutLong,
		ShowPrompts:        a.State.LoadSession().ShowPrompts,
	}
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

func (a *App) SaveSidebarWidth(width int) error {
	if a.State == nil {
		return fmt.Errorf("store not open")
	}
	session := a.State.LoadSession()
	session.SidebarWidth = width
	if err := a.State.SaveSession(session); err != nil {
		logger.Error("SaveSidebarWidth failed", "err", err)
		return err
	}
	return nil
}

func (a *App) SaveMetaWidth(width int) error {
	if a.State == nil {
		return fmt.Errorf("store not open")
	}
	session := a.State.LoadSession()
	session.MetaWidth = width
	return a.State.SaveSession(session)
}

func (a *App) SavePromptsHeight(height int) error {
	if a.State == nil {
		return fmt.Errorf("store not open")
	}
	session := a.State.LoadSession()
	session.PromptsHeight = height
	return a.State.SaveSession(session)
}

// ── Bootstrapping ─────────────────────────────────────────────────────────────

func (a *App) SelectVault() (string, error) {
	logger.Info("SelectVault: triggered")
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Sieve Store",
	})
	logger.Debug("SelectVault: dialog returned", "path", path, "err", err)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := ValidateStore(path); err != nil {
		logger.Warn("SelectVault: ValidateStore failed", "path", path, "err", err)
		return "", fmt.Errorf("this directory does not look like a Sieve store: %w", err)
	}

	logger.Debug("SelectVault: setting storePath and calling startup", "path", path)
	a.storePath = path
	a.startup(a.ctx)

	logger.Debug("SelectVault: startup completed", "resulting_storePath", a.storePath)
	if a.storePath == "" {
		logger.Warn("SelectVault: startup rejected the folder")
		return "", fmt.Errorf("failed to load the selected store")
	}

	config := LoadGlobalConfig()
	config.LastStorePath = path
	if err := config.Save(); err != nil {
		logger.Warn("SelectVault: failed to save global config", "err", err)
		return "", fmt.Errorf("could not update global config: %w", err)
	}
	logger.Info("store selected", "path", path)
	return path, nil
}

func (a *App) CreateVault() (string, error) {
	logger.Info("CreateVault: triggered")
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Folder to Initialize Store",
	})
	logger.Debug("CreateVault: dialog returned", "path", path, "err", err)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}

	logger.Debug("CreateVault: setting storePath and calling startup", "path", path)
	a.storePath = path
	a.startup(a.ctx)

	logger.Debug("CreateVault: startup completed", "resulting_storePath", a.storePath)
	if a.storePath == "" {
		logger.Warn("CreateVault: startup rejected the folder")
		return "", fmt.Errorf("selected folder must be empty or an existing Sieve store")
	}
	logger.Info("store creation initialized", "path", path)
	return path, nil
}

func (a *App) InitVault(path string) error {
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
	a.storePath = abs
	a.startup(a.ctx)

	logger.Debug("InitVault: startup completed", "resulting_storePath", a.storePath)
	if a.storePath == "" {
		logger.Warn("InitVault: startup rejected the folder")
		return fmt.Errorf("folder must be empty or an existing Sieve store")
	}

	config := LoadGlobalConfig()
	config.LastStorePath = abs
	if err := config.Save(); err != nil {
		logger.Warn("InitVault: failed to save global config", "err", err)
		return fmt.Errorf("could not update global config: %w", err)
	}
	logger.Info("store initialized manually — READY", "path", abs)
	return nil
}

// ── Prompts ───────────────────────────────────────────────────────────────────

func (a *App) GetPrompts() []sieve.PromptEntry {
	if a.Prompts == nil {
		return []sieve.PromptEntry{}
	}
	return a.Prompts.ListPrompts()
}

func (a *App) LoadPrompt(name string) (string, error) {
	if a.Prompts == nil {
		return "", fmt.Errorf("store not open")
	}
	return a.Prompts.GetPromptContent(name)
}

func (a *App) SavePrompt(name string, content string) (string, error) {
	if a.Prompts == nil {
		return "", fmt.Errorf("store not open")
	}
	err := a.Prompts.SavePrompt(name, content)
	if err != nil {
		logger.Error("SavePrompt failed", "name", name, "err", err)
		return "", err
	}
	logger.Info("prompt saved to isolation", "name", name, "host", a.hostname)
	runtime.EventsEmit(a.ctx, "prompts:changed")
	return name + ".md", nil
}

func (a *App) DeletePrompt(name string) error {
	if a.Prompts == nil {
		return fmt.Errorf("store not open")
	}
	if err := a.Prompts.DeletePrompt(name); err != nil {
		logger.Warn("DeletePrompt: failed", "name", name, "err", err)
		return err
	}
	runtime.EventsEmit(a.ctx, "prompts:changed")
	return nil
}

func (a *App) TogglePrompts() (bool, error) {
	if a.State == nil {
		return false, fmt.Errorf("store not open")
	}
	session := a.State.LoadSession()
	session.ShowPrompts = !session.ShowPrompts
	if err := a.State.SaveSession(session); err != nil {
		return false, err
	}
	return session.ShowPrompts, nil
}

// ── Notes ─────────────────────────────────────────────────────────────────────

func (a *App) GetNotes() []sieve.NoteEntry {
	if a.Notes == nil {
		logger.Warn("GetNotes: store not open")
		return []sieve.NoteEntry{}
	}
	entries, err := a.Notes.List()
	if err != nil {
		logger.Error("GetNotes failed", "err", err)
		return []sieve.NoteEntry{}
	}
	logger.Debug("GetNotes", "entries", len(entries))
	return entries
}

func (a *App) SearchStore(query string) []sieve.SearchResult {
	if a.Notes == nil {
		logger.Warn("SearchStore: store not open")
		return []sieve.SearchResult{}
	}
	results, err := a.Notes.Search(query)
	if err != nil {
		logger.Error("SearchStore failed", "err", err)
		return []sieve.SearchResult{}
	}
	logger.Debug("SearchStore", "query", query, "results", len(results))
	return results
}

// ── Session ───────────────────────────────────────────────────────────────────

func (a *App) GetSession() sieve.Session {
	if a.State == nil {
		logger.Warn("GetSession: store not open")
		return sieve.Session{
			Tabs: []sieve.Tab{},
		}
	}

	session := a.State.LoadSession()
	logger.Debug("session loaded", "tabs", len(session.Tabs))

	// Prune tabs whose documents no longer exist.
	live := session.Tabs[:0]
	for _, t := range session.Tabs {
		if t.ID == "" {
			continue
		}
		if strings.HasPrefix(t.ID, "prompt:") {
			live = append(live, t) // prompts are always resolvable
			continue
		}
		if _, err := a.LoadByUUID(t.ID); err == nil {
			live = append(live, t)
		} else {
			logger.Warn("session: skipping missing document", "id", t.ID)
		}
	}
	session.Tabs = live

	if len(session.Tabs) > 0 {
		hasActive := false
		for _, t := range session.Tabs {
			if t.Active {
				hasActive = true
				break
			}
		}
		if !hasActive {
			session.Tabs[0].Active = true
		}
	}

	return session
}

func (a *App) SaveSession(session sieve.Session) error {
	if a.State == nil {
		return fmt.Errorf("store not open")
	}
	existing := a.State.LoadSession()
	if session.SidebarWidth == 0 {
		session.SidebarWidth = existing.SidebarWidth
	}
	if session.MetaWidth == 0 {
		session.MetaWidth = existing.MetaWidth
	}
	if session.Window == (sieve.Window{}) {
		session.Window = existing.Window
	}
	if len(session.OpenFolders) == 0 {
		session.OpenFolders = existing.OpenFolders
	}
	if err := a.State.SaveSession(session); err != nil {
		logger.Error("SaveSession failed", "err", err)
		return err
	}
	logger.Debug("session saved", "tabs", len(session.Tabs))
	return nil
}

// ── Buffers ───────────────────────────────────────────────────────────────────

func (a *App) NewBuffer() (BufferDTO, error) {
	if a.Buffers == nil {
		return BufferDTO{}, fmt.Errorf("store not open")
	}
	b, err := a.Buffers.New()
	if err != nil {
		logger.Error("NewBuffer failed", "err", err)
		return BufferDTO{}, err
	}
	logger.Info("buffer created", "path", b.Path(), "uuid", b.UUID())
	return toBufferDTO(b), nil
}

// LoadBuffer loads any document by its store-relative path and returns a typed DTO.
// Tries BufferService first; falls back to NoteService so routing is not
// coupled to the path prefix convention of any particular Store implementation.
// The returned Body is pure markdown — frontmatter is never included.
func (a *App) LoadBuffer(path string) (interface{}, error) {
	if a.Buffers == nil {
		return nil, fmt.Errorf("store not open")
	}
	if b, err := a.Buffers.Load(path); err == nil {
		logger.Debug("buffer loaded", "path", path)
		return toBufferDTO(b), nil
	}
	n, err := a.Notes.Load(path)
	if err != nil {
		logger.Error("LoadBuffer: not found in buffers or notes", "path", path, "err", err)
		return nil, err
	}
	logger.Debug("note loaded via LoadBuffer", "path", path)
	return toNoteDTO(n), nil
}

// SaveBuffer persists the body and writable meta fields from dto. The Store
// bumps the version and modified timestamp automatically. Returns the updated
// DTO with Store-stamped fields reflecting the saved state.
// Routes by dto.Meta.Status: "filed" → NoteService, anything else → BufferService.
func (a *App) SaveBuffer(dto BufferDTO) (interface{}, error) {
	if a.Buffers == nil {
		return nil, fmt.Errorf("store not open")
	}
	if dto.Meta.Status == "filed" {
		n, err := a.Notes.Load(dto.Path)
		if err != nil {
			logger.Error("SaveBuffer(note): load failed", "path", dto.Path, "err", err)
			return nil, err
		}
		n.SetBody([]byte(dto.Body))
		applyDTOToMeta(dto.Meta, n.Meta())
		saved, err := a.Notes.Save(n)
		if err != nil {
			logger.Error("SaveBuffer(note): save failed", "path", dto.Path, "err", err)
			return nil, err
		}
		logger.Debug("note saved via SaveBuffer", "path", dto.Path)
		return toNoteDTO(saved), nil
	}
	b, err := a.Buffers.Load(dto.Path)
	if err != nil {
		logger.Error("SaveBuffer: load failed", "path", dto.Path, "err", err)
		return nil, err
	}
	b.SetBody([]byte(dto.Body))
	applyDTOToMeta(dto.Meta, b.Meta())
	saved, err := a.Buffers.Save(b)
	if err != nil {
		logger.Error("SaveBuffer: save failed", "path", dto.Path, "err", err)
		return nil, err
	}
	logger.Debug("buffer saved", "path", dto.Path)
	return toBufferDTO(saved), nil
}

// RefileNote applies the filing recommendation already persisted in dto's
// metadata to a Library note: saves the updated meta, then renames/moves the
// note within the Library based on the filename and folder fields.
// Used when the user runs "Smart File" on a note that is already filed.
func (a *App) RefileNote(dto BufferDTO) (NoteDTO, error) {
	if a.Notes == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	n, err := a.Notes.Load(dto.Path)
	if err != nil {
		return NoteDTO{}, fmt.Errorf("refile: load %s: %w", dto.Path, err)
	}
	n.SetBody([]byte(dto.Body))
	applyDTOToMeta(dto.Meta, n.Meta())
	// Save updated metadata first so Refile derives the correct name.
	saved, err := a.Notes.Save(n)
	if err != nil {
		return NoteDTO{}, fmt.Errorf("refile: save %s: %w", dto.Path, err)
	}
	refiled, err := a.Notes.Refile(saved)
	if err != nil {
		return NoteDTO{}, fmt.Errorf("refile: rename %s: %w", dto.Path, err)
	}
	logger.Info("note refiled", "from", dto.Path, "to", refiled.Path())
	return toNoteDTO(refiled), nil
}

// DiscardBuffer deletes a buffer and its version history.
func (a *App) DiscardBuffer(path string) error {
	if a.Buffers == nil {
		return fmt.Errorf("store not open")
	}
	b, err := a.Buffers.Load(path)
	if err != nil {
		logger.Error("DiscardBuffer: load failed", "path", path, "err", err)
		return err
	}
	if err := a.Buffers.Discard(b); err != nil {
		logger.Error("DiscardBuffer failed", "path", path, "err", err)
		return err
	}
	logger.Info("buffer discarded", "path", path)
	return nil
}

// FileBuffer promotes a buffer to the Library using the AI-derived name and
// folder. Returns the resulting NoteDTO.
func (a *App) FileBuffer(path string) (NoteDTO, error) {
	if a.Buffers == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	b, err := a.Buffers.Load(path)
	if err != nil {
		logger.Error("FileBuffer: load failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	n, err := a.Buffers.File(b)
	if err != nil {
		logger.Error("FileBuffer failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	logger.Info("buffer filed", "from", path, "to", n.Path())
	return toNoteDTO(n), nil
}

// FileBufferWithName is like FileBuffer but overrides the filename.
func (a *App) FileBufferWithName(path, name string) (NoteDTO, error) {
	if a.Buffers == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	b, err := a.Buffers.Load(path)
	if err != nil {
		logger.Error("FileBufferWithName: load failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	n, err := a.Buffers.FileWithName(b, name)
	if err != nil {
		logger.Error("FileBufferWithName failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	logger.Info("buffer filed with name", "from", path, "to", n.Path(), "name", name)
	return toNoteDTO(n), nil
}

// GetDocumentVersion retrieves a historical snapshot identified by ref.
// path is the store-relative path of the document (Buffer or Note).
func (a *App) GetDocumentVersion(path string, ref VersionRefDTO) (VersionedStorableDTO, error) {
	if a.Buffers == nil {
		return VersionedStorableDTO{}, fmt.Errorf("store not open")
	}
	vref := fromVersionRefDTO(ref)

	// Try as Buffer first, then as Note.
	if b, err := a.Buffers.Load(path); err == nil {
		v, err := a.Buffers.RetrieveVersion(b, vref)
		if err != nil {
			return VersionedStorableDTO{}, fmt.Errorf("retrieve version: %w", err)
		}
		return toVersionedStorableDTO(v), nil
	}
	if n, err := a.Notes.Load(path); err == nil {
		v, err := a.Notes.RetrieveVersion(n, vref)
		if err != nil {
			return VersionedStorableDTO{}, fmt.Errorf("retrieve version: %w", err)
		}
		return toVersionedStorableDTO(v), nil
	}
	return VersionedStorableDTO{}, fmt.Errorf("document not found: %s", path)
}

// ── Notes ─────────────────────────────────────────────────────────────────────

// DeleteNote deletes a filed note by its UUID.
func (a *App) DeleteNote(uuid string) error {
	if a.Notes == nil {
		return fmt.Errorf("store not open")
	}
	n, err := a.Notes.LoadByUUID(uuid)
	if err != nil {
		logger.Error("DeleteNote: load failed", "uuid", uuid, "err", err)
		return err
	}
	if err := a.Notes.Delete(n); err != nil {
		logger.Error("DeleteNote failed", "uuid", uuid, "err", err)
		return err
	}
	logger.Info("note deleted", "uuid", uuid, "path", n.Path())
	return nil
}

// MoveNote moves a note to a different folder within the Library.
// uuid identifies the note. folderID is the opaque folder identifier returned
// by GetNotes — e.g. "store/ai-stuff" or "store" for the Library root.
func (a *App) MoveNote(uuid, folderID string) (NoteDTO, error) {
	if a.Notes == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	n, err := a.Notes.LoadByUUID(uuid)
	if err != nil {
		logger.Error("MoveNote: load failed", "uuid", uuid, "err", err)
		return NoteDTO{}, err
	}
	// Strip the category prefix to get the bare folder path expected by NoteService.Move.
	// "store/ai-stuff" → "ai-stuff"; "store" → "" (root).
	folder := strings.TrimPrefix(folderID, sieve.Library.Key+"/")
	if folder == sieve.Library.Key {
		folder = ""
	}
	moved, err := a.Notes.Move(n, folder)
	if err != nil {
		logger.Error("MoveNa.stateote failed", "uuid", uuid, "folderID", folderID, "err", err)
		return NoteDTO{}, err
	}
	logger.Info("note moved", "uuid", uuid, "to", moved.Path())
	return toNoteDTO(moved), nil
}

// RenameNote renames a filed note by its UUID. newName is the desired base name
// (without extension); it will be kebab-cased by the service.
func (a *App) RenameNote(uuid, newName string) (NoteDTO, error) {
	if a.Notes == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	n, err := a.Notes.LoadByUUID(uuid)
	if err != nil {
		logger.Error("RenameNote: load failed", "uuid", uuid, "err", err)
		return NoteDTO{}, err
	}
	renamed, err := a.Notes.Rename(n, newName)
	if err != nil {
		logger.Error("RenameNote failed", "uuid", uuid, "name", newName, "err", err)
		return NoteDTO{}, err
	}
	logger.Info("note renamed", "uuid", uuid, "to", renamed.Path())
	return toNoteDTO(renamed), nil
}

// LoadByUUID loads a note or buffer by its UUID. Prompts are not handled here —
// the frontend calls LoadPrompt directly for "prompt:" IDs.
func (a *App) LoadByUUID(id string) (interface{}, error) {
	if a.Notes != nil {
		if n, err := a.Notes.LoadByUUID(id); err == nil {
			return toNoteDTO(n), nil
		}
	}
	if a.Buffers != nil {
		if b, err := a.Buffers.LoadByUUID(id); err == nil {
			return toBufferDTO(b), nil
		}
	}
	return nil, fmt.Errorf("no document with id %q", id)
}

// ── Folders ───────────────────────────────────────────────────────────────────
//
// Folder ops use direct file operations — the Store interface does not yet have
// explicit CreateFolder support (folders are created implicitly by file ops).

// CreateFolder creates a new folder. parentFolderID is the opaque folder ID
// from GetNotes (e.g. "store/projects") or "" / "store" for the Library root.
// name is the desired folder name.
func (a *App) CreateFolder(parentFolderID, name string) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	var folderPath string
	if parentFolderID == "" || parentFolderID == sieve.Library.Key {
		folderPath = sieve.Library.Key + "/" + name
	} else {
		folderPath = parentFolderID + "/" + name
	}
	resolved := a.resolvePath(folderPath)
	if err := os.MkdirAll(resolved, 0o755); err != nil {
		logger.Error("CreateFolder failed", "folderPath", folderPath, "err", err)
		return err
	}
	logger.Info("folder created", "path", folderPath)
	return nil
}

func (a *App) DeleteFolder(path string) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	resolved := a.resolvePath(path)
	info, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a directory")
	}
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".") {
			return fmt.Errorf("directory not empty")
		}
	}
	if err := os.RemoveAll(resolved); err != nil {
		logger.Error("DeleteFolder failed", "path", path, "err", err)
		return err
	}
	logger.Info("folder deleted", "path", path)
	return nil
}

// RenameFolder renames a folder. folderID is the opaque folder ID from GetNotes
// (e.g. "store/ai-stuff"). newName is the desired new folder name (not a full path).
// Returns the new folder ID so the frontend can update its open-folder state.
func (a *App) RenameFolder(folderID, newName string) (string, error) {
	if a.storePath == "" {
		return "", fmt.Errorf("store not open")
	}
	parent := filepath.ToSlash(filepath.Dir(folderID))
	newPath := parent + "/" + newName
	oldResolved := a.resolvePath(folderID)
	newResolved := a.resolvePath(newPath)
	if err := os.Rename(oldResolved, newResolved); err != nil {
		logger.Error("RenameFolder failed", "from", folderID, "to", newPath, "err", err)
		return "", err
	}
	logger.Info("folder renamed", "from", folderID, "to", newPath)
	return newPath, nil
}

// ── Assets ────────────────────────────────────────────────────────────────────

// SaveAsset stores a base64-encoded image and returns an AssetDTO whose
// ExternalRef can be inserted directly into markdown.
// context is the store-relative path of the owning document (or "" for a buffer paste).
func (a *App) SaveAsset(context, id, dataBase64 string) (AssetDTO, error) {
	if a.Assets == nil {
		return AssetDTO{}, fmt.Errorf("store not open")
	}
	if idx := strings.Index(dataBase64, ","); idx >= 0 {
		dataBase64 = dataBase64[idx+1:]
	}
	data, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		logger.Error("SaveAsset: decode failed", "err", err)
		return AssetDTO{}, fmt.Errorf("SaveAsset: decode: %w", err)
	}
	isBuffer := context == "" || context == "new" || strings.Contains(context, "/buffers/")
	cat := sieve.WorkingCopy
	if !isBuffer {
		cat = sieve.Library
	}

	asset, err := a.Assets.Save(cat, context, id, data)
	if err != nil {
		logger.Error("SaveAsset failed", "id", id, "err", err)
		return AssetDTO{}, err
	}

	if context != "" && context != "new" {
		if b, err := a.Buffers.Load(context); err == nil {
			b.Storable().AttachAsset(asset.Storable())
			if _, err := a.Buffers.Save(b); err != nil {
				logger.Warn("SaveAsset: failed to attach to buffer", "err", err)
			}
		} else if n, err := a.Notes.Load(context); err == nil {
			n.Storable().AttachAsset(asset.Storable())
			if _, err := a.Notes.Save(n); err != nil {
				logger.Warn("SaveAsset: failed to attach to note", "err", err)
			}
		}
	}

	logger.Info("asset saved", "externalRef", asset.ExternalRef())
	return toAssetDTO(asset), nil
}

// DownloadAsset fetches an image from a URL and stores it as an asset.
// context is the store-relative path of the owning document (or "" for buffer paste).
func (a *App) DownloadAsset(context, targetURL, id string) (AssetDTO, error) {
	if a.Assets == nil {
		return AssetDTO{}, fmt.Errorf("store not open")
	}
	data, err := downloadURL(targetURL)
	if err != nil {
		logger.Error("DownloadAsset: fetch failed", "url", targetURL, "err", err)
		return AssetDTO{}, err
	}
	isBuffer := context == "" || context == "new" || strings.Contains(context, "/buffers/")
	cat := sieve.WorkingCopy
	if !isBuffer {
		cat = sieve.Library
	}

	asset, err := a.Assets.Save(cat, context, id, data)
	if err != nil {
		logger.Error("DownloadAsset: save failed", "id", id, "err", err)
		return AssetDTO{}, err
	}

	if context != "" && context != "new" {
		if b, err := a.Buffers.Load(context); err == nil {
			b.Storable().AttachAsset(asset.Storable())
			if _, err := a.Buffers.Save(b); err != nil {
				logger.Warn("DownloadAsset: failed to attach to buffer", "err", err)
			}
		} else if n, err := a.Notes.Load(context); err == nil {
			n.Storable().AttachAsset(asset.Storable())
			if _, err := a.Notes.Save(n); err != nil {
				logger.Warn("DownloadAsset: failed to attach to note", "err", err)
			}
		}
	}
	logger.Info("asset downloaded", "url", targetURL, "externalRef", asset.ExternalRef())
	return toAssetDTO(asset), nil
}

// ── AI / CLI operations ───────────────────────────────────────────────────────

func (a *App) EvaluateBuffer(path string) (*sieve.FilingRecommendation, error) {
	if a.Buffers == nil {
		return nil, fmt.Errorf("store not open")
	}
	settings := a.State.LoadSettings()

	var meta sieve.DocumentMeta
	var body []byte
	if b, err := a.Buffers.Load(path); err == nil {
		meta, body = b.Meta(), b.Body()
	} else if n, err := a.Notes.Load(path); err == nil {
		meta, body = n.Meta(), n.Body()
	} else {
		return nil, fmt.Errorf("document not found: %s", path)
	}

	prompt, _ := a.Prompts.GetPromptContent("file")
	rec, err := sieve.EvaluateBuffer(meta, body, a.libraryFolders(), settings, prompt)
	if err != nil {
		logger.Warn("EvaluateBuffer failed", "path", path, "err", err)
		return nil, err
	}
	logger.Info("EvaluateBuffer success", "path", path)
	return rec, nil
}

// EvaluateAndFile loads the document at path, runs AI evaluation, applies the
// recommendation to its metadata, and optionally promotes it to the Library.
// The frontend must have already persisted the document body before calling this.
// Returns EvaluateAndFileResult{Discarded: true} when the document was removed.
func (a *App) EvaluateAndFile(path string, fileAfter bool, allowDiscard bool) (EvaluateAndFileResult, error) {
	if a.Buffers == nil {
		return EvaluateAndFileResult{}, fmt.Errorf("store not open")
	}
	settings := a.State.LoadSettings()
	prompt, _ := a.Prompts.GetPromptContent("file")
	outcome, err := sieve.EvaluateAndFileDoc(path, a.Buffers, a.Notes, settings, a.libraryFolders(), prompt, fileAfter, allowDiscard)
	if err != nil {
		return EvaluateAndFileResult{}, err
	}
	if outcome.Discarded {
		return EvaluateAndFileResult{Discarded: true}, nil
	}
	if outcome.Note != nil {
		logger.Info("EvaluateAndFile: note outcome", "path", outcome.Note.Path())
		return EvaluateAndFileResult{Doc: toNoteBufferDTO(outcome.Note)}, nil
	}
	return EvaluateAndFileResult{Doc: toBufferDTO(outcome.Buffer)}, nil
}

func (a *App) RefineLanguage(content string) (string, error) {
	if a.Buffers == nil {
		return "", fmt.Errorf("store not open")
	}
	settings := a.State.LoadSettings()
	if settings.Tier() == sieve.TierDumb {
		return "", fmt.Errorf("dumb mode")
	}
	prompt, _ := a.Prompts.GetPromptContent("refine")
	lang, err := sieve.RefineLanguage(content, settings, prompt)
	if err != nil {
		logger.Warn("RefineLanguage failed", "err", err)
		return "", err
	}
	return lang, nil
}

func (a *App) DescribeImage(storeRelPath string) (sieve.ImageDesc, error) {
	if a.Buffers == nil {
		return sieve.ImageDesc{}, fmt.Errorf("store not open")
	}
	settings := a.State.LoadSettings()
	if settings.Tier() == sieve.TierDumb {
		return sieve.ImageDesc{}, fmt.Errorf("dumb mode")
	}
	prompt, _ := a.Prompts.GetPromptContent("image")
	desc, err := sieve.DescribeImage(filepath.Join(a.storePath, storeRelPath), settings, prompt)
	if err != nil {
		logger.Warn("DescribeImage failed", "err", err)
		return sieve.ImageDesc{}, err
	}
	return desc, nil
}

func (a *App) Explain(content string, history string, notePath string, imageStorePaths []string) (string, error) {
	if a.Buffers == nil {
		return "", fmt.Errorf("store not open")
	}
	settings := a.State.LoadSettings()
	if settings.Tier() == sieve.TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}
	prompt, _ := a.Prompts.GetPromptContent("explain")
	resp, err := sieve.RunExplain(content, history, settings,
		filepath.Dir(a.resolvePath(notePath)), a.absImagePaths(imageStorePaths), prompt)
	if err != nil {
		logger.Warn("Explain failed", "err", err)
		return "", err
	}
	return resp, nil
}

func (a *App) Ask(content string, history string, question string, notePath string, imageStorePaths []string) (string, error) {
	if a.Buffers == nil {
		return "", fmt.Errorf("store not open")
	}
	settings := a.State.LoadSettings()
	if settings.Tier() == sieve.TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}
	prompt, _ := a.Prompts.GetPromptContent("ask")
	resp, err := sieve.RunAsk(content, history, question, settings,
		filepath.Dir(a.resolvePath(notePath)), a.absImagePaths(imageStorePaths), prompt)
	if err != nil {
		logger.Warn("Ask failed", "err", err)
		return "", err
	}
	return resp, nil
}

// libraryFolders returns the names of top-level folders in the Library,
// used to seed the AI's folder suggestions in EvaluateBuffer.
func (a *App) libraryFolders() []string {
	entries, _ := a.Notes.List()
	var folders []string
	for _, e := range entries {
		if e.IsDir {
			folders = append(folders, e.Name)
		}
	}
	return folders
}

// absImagePaths converts store-relative image paths to absolute filesystem paths.
func (a *App) absImagePaths(storePaths []string) []string {
	abs := make([]string, len(storePaths))
	for i, p := range storePaths {
		abs[i] = filepath.Join(a.storePath, p)
	}
	return abs
}

// loadThemeOverride reads the store-local theme override file for name, if any.
// Returns nil when no override exists or the store is not open.
func (a *App) loadThemeOverride(name string) []byte {
	if a.storePath == "" || name == "" {
		return nil
	}
	data, _ := os.ReadFile(filepath.Join(a.storePath, "themes", name+".json"))
	return data
}

// ── File manager ──────────────────────────────────────────────────────────────

// ShowInFilesByID reveals a document or folder in the OS file manager.
// id is a UUID (note/buffer), an opaque folder ID (ExternalRef), or "prompt:name".
func (a *App) ShowInFilesByID(id string) error {
	if strings.HasPrefix(id, "prompt:") {
		return a.ShowInFiles(a.promptsDir())
	}
	if a.Notes != nil {
		if n, err := a.Notes.LoadByUUID(id); err == nil {
			return a.ShowInFiles(n.Path())
		}
	}
	if a.Buffers != nil {
		if b, err := a.Buffers.LoadByUUID(id); err == nil {
			return a.ShowInFiles(b.Path())
		}
	}
	// Folder: id is an ExternalRef (e.g. "store/my-folder") — resolvePath handles it.
	return a.ShowInFiles(id)
}

func (a *App) ShowInFiles(path string) error {
	resolved := a.resolvePath(path)
	info, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	if goruntime.GOOS == "darwin" {
		if info.IsDir() {
			cmd = exec.Command("open", resolved)
		} else {
			cmd = exec.Command("open", "-R", resolved)
		}
	} else {
		dir := resolved
		if !info.IsDir() {
			dir = filepath.Dir(resolved)
		}
		cmd = exec.Command("xdg-open", dir)
	}
	logger.Debug("ShowInFiles", "path", resolved, "os", goruntime.GOOS)
	return cmd.Start()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// resolvePath converts a store-relative path to an absolute filesystem path.
func (a *App) resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	if a.storePath != "" {
		return filepath.Join(a.storePath, path)
	}
	return path
}

// migrateStateFiles moves settings.json and session.json from hostDir to
// configDir. For settings.json it uses a smart merge: if the old file has a
// "cli" field and the new file does not, the old file wins (it carries real
// user configuration; the new file was likely written with defaults on the
// first startup before migration ran). session.json is only moved if absent
// in the new location.
func migrateStateFiles(hostDir, configDir string) {
	// settings.json — smart merge: old wins if it has a cli field the new lacks
	migrateSettings(
		filepath.Join(hostDir, "settings.json"),
		filepath.Join(configDir, "settings.json"),
	)

	// session.json — simple: only move if the new location is absent
	oldSession := filepath.Join(hostDir, "session.json")
	nwSession := filepath.Join(configDir, "session.json")
	if _, err := os.Stat(oldSession); err != nil {
		return // old file doesn't exist
	}
	if _, err := os.Stat(nwSession); err == nil {
		return // new file already exists
	}
	if err := os.Rename(oldSession, nwSession); err != nil {
		logger.Warn("state migration failed", "file", "session.json", "err", err)
	} else {
		logger.Info("migrated state file", "from", oldSession, "to", nwSession)
	}
}

// migrateSettings handles the settings.json migration. If the old file has a
// "cli" field and the new file is absent or has no "cli", the old file is
// copied to the new location (overwriting defaults-only stubs).
func migrateSettings(oldPath, newPath string) {
	oldData, err := os.ReadFile(oldPath)
	if err != nil {
		return // old file doesn't exist — nothing to do
	}

	// Check whether the old settings has a cli field.
	var oldSettings sieve.Settings
	if err := json.Unmarshal(oldData, &oldSettings); err != nil || oldSettings.CLI == "" {
		// Old file has no cli — not worth migrating settings over new defaults.
		// Still move the file if the new location is absent.
		if _, err := os.Stat(newPath); os.IsNotExist(err) {
			if err := os.Rename(oldPath, newPath); err != nil {
				logger.Warn("migrateSettings: rename failed", "err", err)
			} else {
				logger.Info("migrated settings.json", "from", oldPath, "to", newPath)
			}
		}
		return
	}

	// Old file has a cli field. Check if the new file already has one.
	if newData, err := os.ReadFile(newPath); err == nil {
		var newSettings sieve.Settings
		if json.Unmarshal(newData, &newSettings) == nil && newSettings.CLI != "" {
			// New file already has cli configured — leave it alone.
			return
		}
	}

	// New file is absent or has no cli — copy old over new.
	if err := os.WriteFile(newPath, oldData, 0o644); err != nil {
		logger.Warn("migrateSettings: write failed", "err", err)
		return
	}
	os.Remove(oldPath) // clean up old location
	logger.Info("migrated settings.json (cli merge)", "from", oldPath, "to", newPath)
}

// downloadURL fetches a URL and returns the body bytes. Used by DownloadAsset.
func downloadURL(targetURL string) ([]byte, error) {
	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 30 * time.Second,
	}
	req, err := http.NewRequest(http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server returned status %d", resp.StatusCode)
	}
	contentType := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(contentType, "image/") {
		return nil, fmt.Errorf("not an image (Content-Type: %s)", contentType)
	}
	return io.ReadAll(resp.Body)
}
