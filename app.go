package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"sieve/config"
	"sieve/logger"
	"sieve/requesthandlers"
	"sieve/sieve"
	"sieve/sieve/ai"
	"sieve/sieve/domain"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
	"sieve/store"
	"sieve/store/filestore"
	"sieve/watcher"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application backend.
type App struct {
	ctx       context.Context
	storePath string // current library root; internal file-path detail
	hostname  string

	ServiceProvider *sieve.ServiceProvider
	Documents       *services.DocumentService
	Assets          *services.AssetService
	State           *services.StateService
	Prompts         *ai.PromptService

	library   services.LibraryService // owns library discovery, recents, naming
	themesFS  fs.FS
	broadcast *requesthandlers.WorkspaceBroadcast
	watcher   *watcher.NotesWatcher
	closing   bool
	mu        sync.Mutex

	DevServerPort int
}

// NewApp builds the Wails app backend. broadcast MUST be non-nil: startup and
// the notes watcher both call a.broadcast.Invalidate unconditionally (startup
// synchronously, the watcher from its own goroutine on every debounced fs
// change), and WorkspaceBroadcast.Send dereferences its receiver — a nil
// broadcast panics the watcher goroutine on the first notes edit, not at
// construction time where it would be easy to see.
func NewApp(storePath string, themesFS fs.FS, broadcast *requesthandlers.WorkspaceBroadcast, serviceProvider *sieve.ServiceProvider, library services.LibraryService) *App {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "localhost"
	}

	return &App{
		storePath:       storePath,
		hostname:        hostname,
		themesFS:        themesFS,
		broadcast:       broadcast,
		ServiceProvider: serviceProvider,
		library:         library,
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

// getThemesFS returns the embedded themes filesystem.
func (a *App) getThemesFS() fs.FS { return a.themesFS }

// getStorePath returns the active store root path.
func (a *App) getStorePath() string { return a.storePath }

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// startup is called by Wails when the application window is ready.
func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()

	isFirstStartup := a.ctx == nil
	a.ctx = ctx

	abs, _ := filepath.Abs(a.storePath)
	logger.Info("startup", "vault_raw", a.storePath, "vault_abs", abs)

	if a.storePath == "" {
		logger.Info("startup: no store path specified — entering bootstrap mode")
		return
	}

	if a.library == nil {
		logger.Error("startup: library service is nil — cannot proceed")
		return
	}

	logger.Info("startup: beginning validation", "isFirstStartup", isFirstStartup, "storePath", abs)

	if err := a.library.Validate(abs); err != nil {
		logger.Warn("startup: validation failed", "path", abs, "err", err)
		entries, readErr := os.ReadDir(abs)
		isEmpty := readErr == nil && len(entries) == 0
		logger.Debug("startup: empty directory check", "isEmpty", isEmpty, "entriesCount", len(entries))

		if !isEmpty {
			// Not a valid store and not empty — fall back to best available library.
			if isFirstStartup {
				fallback := a.library.BestOnStartup("", "")
				if fallback != "" && fallback != abs {
					abs = fallback
					logger.Info("startup: falling back to best available library", "path", abs)
				} else {
					a.storePath = ""
					logger.Info("startup: entering bootstrap mode — no valid library found")
					return
				}
			} else {
				a.storePath = ""
				logger.Warn("startup: explicit path is invalid, re-entering bootstrap mode")
				return
			}
		} else {
			logger.Info("startup: path is empty, proceeding with initialisation", "path", abs)
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
	a.ServiceProvider.Init(fs, a.storePath, a.themesFS)
	a.Documents = a.ServiceProvider.Documents
	a.Assets = a.ServiceProvider.Assets
	a.State = a.ServiceProvider.State
	a.Prompts = a.ServiceProvider.Prompts

	// Tell the internal Sieve MCP the origin the CLI subprocess reaches the app
	// on (the localhost listener bound in main, before this startup runs). The
	// URL feeds the containment profile the AI service injects into CLI calls.
	if a.ServiceProvider.MCP != nil {
		a.ServiceProvider.MCP.SetBaseURL(fmt.Sprintf("http://127.0.0.1:%d", a.DevServerPort))
	}

	if err := fs.RunMigrationIfNeeded([]store.Category{domain.LibraryCategory, domain.WorkingCopy}); err != nil {
		logger.Error("store migration failed", "err", err)
	}

	settings := a.State.LoadSettings()

	// Apply the persisted debug flag to the logger so it actually gates Debug
	// output (the level otherwise stays at its Info default). Re-applied on
	// settings-save so a toggle takes effect live.
	logger.SetDebug(settings.Debug)

	// Attach the library service to the live store and record this switch.
	a.library.Attach(a.storePath, fs)
	a.library.RecordSwitch(a.storePath)
	a.ServiceProvider.Library = a.library
	a.broadcast.Invalidate(protocol.TopicLibrary)

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
	w, err := watcher.New(a.notesDir(), func() {
		logger.Debug("notes changed — invalidating")
		a.broadcast.Invalidate(protocol.TopicNotes)
	})
	if err != nil {
		logger.Warn("could not start notes watcher", "err", err)
	} else {
		a.watcher = w
	}
}

func (a *App) beforeClose(ctx context.Context) bool {
	if a.closing {
		if a.ServiceProvider.Editor != nil {
			a.ServiceProvider.Editor.FlushAll()
		}
		return false
	}
	if a.State != nil {
		x, y := runtime.WindowGetPosition(ctx)
		w, h := runtime.WindowGetSize(ctx)
		session := a.State.LoadSession()
		session.Window = domain.Window{X: x, Y: y, Width: w, Height: h}
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
	Tier               domain.Tier     `json:"tier"`
	Cli                string          `json:"cli"`
	Debug              bool            `json:"debug"`
	AutosaveDebounce   int             `json:"autosaveDebounce"`
	ThemeName          string          `json:"themeName"`
	ThemeVars          domain.ThemeVars `json:"themeVars"`
	MaxHistoryVersions int             `json:"maxHistoryVersions"`
	CLITimeoutLong     int             `json:"cliTimeoutLong"`
	ShowPrompts        bool            `json:"showPrompts"`
}

func (a *App) getStoreInfo() StoreInfo {
	if a.storePath == "" || a.State == nil {
		logger.Warn("getStoreInfo: store not open")
		return StoreInfo{
			ThemeVars: domain.ThemeVars{},
		}
	}

	logger.Info("getStoreInfo", "root", a.storePath)
	liveSettings := a.State.LoadSettings()

	return StoreInfo{
		Root:               a.storePath,
		Hostname:           a.hostname,
		BuffersPath:        filepath.Join(a.storePath, a.hostname, "buffers"),
		NotesPath:          a.notesDir(),
		IsNew:              a.Documents.Count() == 0,
		Tier:               liveSettings.Tier(),
		Cli:                liveSettings.CLI,
		Debug:              liveSettings.Debug,
		AutosaveDebounce:   liveSettings.AutosaveDebounce,
		ThemeName:          liveSettings.Theme,
		ThemeVars:          domain.LoadTheme(liveSettings.Theme, a.loadThemeOverride(liveSettings.Theme), a.themesFS),
		MaxHistoryVersions: liveSettings.MaxHistoryVersions,
		CLITimeoutLong:     liveSettings.CLITimeoutLong,
		ShowPrompts:        a.State.LoadSession().ShowPrompts,
	}
}

// ── Bootstrapping ─────────────────────────────────────────────────────────────

// PickDirectory opens the native directory chooser and returns the selected
// absolute path ("" if cancelled). Unlike SelectVault it has NO side effects —
// no validation, no store switch — so it is a reusable path picker for form
// fields (e.g. a containment directory grant). The frontend awaits it and drops
// the result straight into the field.
func (a *App) PickDirectory() (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select a directory to grant",
	})
}

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
	if err := a.library.Validate(path); err != nil {
		logger.Warn("SelectVault: validation failed", "path", path, "err", err)
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

// GetActiveUUID returns the UUID of the currently active tab in the session.
// Used by the no-reload library switch to reinitialize the editor in place.
func (a *App) GetActiveUUID() string {
	if a.ServiceProvider == nil || a.ServiceProvider.State == nil {
		return ""
	}
	session := a.ServiceProvider.State.LoadSession()
	if session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		return session.Tabs[session.ActiveIdx].ID
	}
	return ""
}

//TODO  - WHY IS ALL THIS HERE - its hsuld be part of the Library Service
//ITS MAKIGN ASSUMPTIONS ABOUT FILE FORMATS?PATHS and all of the was supposed
//to be encapsualetd within the Library - service.  Listeners or call back hooks should be
//registered if the APP code really needs to do things with vcariables oin its scope
//but once we have Fucntions using Services injected and the Library Service is responsible
// for managing the store and its lifecycle - then the App should not be doing any of this work - its a violation of encapsulation and separation of concerns.  The Library Service should be able to manage all of this without the App needing to know about it.  The App should just call LibraryService.SwitchLibrary(path) and the Library Service should handle all of the validation, state management, and event broadcasting related to switching libraries.  This would make the code cleaner, more modular, and easier to maintain.  The App should not be directly interacting with the file system or managing the store path - that should all be handled by the Library Service.  The App's role should be to provide a user interface and delegate library management tasks to the Library Service.

// SwitchLibrary switches to an existing library at path without opening a file
// dialog. Used by the File > Open Recent submenu.
func (a *App) SwitchLibrary(path string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	if err := a.library.Validate(path); err != nil {
		return "", fmt.Errorf("invalid library: %w", err)
	}
	if a.ServiceProvider != nil && a.ServiceProvider.Editor != nil {
		// CloseAll (not FlushAll): startup() below replaces this EditorService, so
		// we must stop its armed autosave timers too, or they fire a delayed write
		// against the old library after the switch. See EditorService.CloseAll.
		a.ServiceProvider.Editor.CloseAll()
	}
	a.storePath = path
	a.startup(a.ctx)
	if a.storePath == "" {
		return "", fmt.Errorf("failed to load the selected library")
	}
	// Refresh the native menu (for the "Open Recent" submenu) ONLY on macOS.
	// On Linux/Windows, Wails v2.12.0's GTK SetApplicationMenu is broken for
	// repeated calls: it allocates a new menubar but never re-packs it into the
	// window (packing only happens once in setupContent) and never destroys the
	// old menubar, while resetting gtkSignalToMenuItem. The old menubar stays
	// visible with its click handlers still wired, so the next menu-item click
	// dereferences a nil *menu.MenuItem and SIGSEGVs in handleMenuItemClick.
	// Skipping the rebuild leaves the native "Open Recent" list stale until
	// restart; library switching remains available via the Open Library dialog.
	if goruntime.GOOS == "darwin" {
		runtime.MenuSetApplicationMenu(a.ctx, buildMenu(a))
	}
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

	cfg := config.LoadGlobalConfig()
	cfg.LastStorePath = abs
	if err := cfg.Save(); err != nil {
		logger.Warn("InitVault: failed to save global config", "err", err)
		return fmt.Errorf("could not update global config: %w", err)
	}
	logger.Info("store initialized manually — READY", "path", abs)
	return nil
}

// ── File manager ──────────────────────────────────────────────────────────────

// ShowInFilesByID reveals a document or folder in the OS file manager.
// id is a UUID (note/buffer), an opaque folder ID (ExternalRef), or "prompt:name".
func (a *App) ShowInFilesByID(id string) error {
	if strings.HasPrefix(id, "prompt:") {
		return a.showInFiles(a.promptsDir())
	}
	if a.Documents != nil {
		if doc, err := a.Documents.LoadByUUID(id); err == nil {
			return a.showInFiles(doc.Storable().ExternalRef())
		}
	}
	// Folder: id is an ExternalRef (e.g. "store/my-folder") — resolvePath handles it.
	return a.showInFiles(id)
}

func (a *App) showInFiles(path string) error {
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

// loadThemeOverride reads the store-local theme override file for name, if any.
// Returns nil when no override exists or the store is not open.
func (a *App) loadThemeOverride(name string) []byte {
	if a.storePath == "" || name == "" {
		return nil
	}
	data, _ := os.ReadFile(filepath.Join(a.storePath, "themes", name+".json"))
	return data
}

// migrateStateFiles moves settings.json and session.json from hostDir to
// configDir. For settings.json it uses a smart merge: if the old file has a
// "cli" field and the new file does not, the old file wins (it carries real
// user configuration; the new file was likely written with defaults on the
// first startup before migration ran). session.json is only moved if absent
// in the new location.
func migrateStateFiles(hostDir, configDir string) {
	migrateSettings(
		filepath.Join(hostDir, "settings.json"),
		filepath.Join(configDir, "settings.json"),
	)

	oldSession := filepath.Join(hostDir, "session.json")
	nwSession := filepath.Join(configDir, "session.json")
	if _, err := os.Stat(oldSession); err != nil {
		return
	}
	if _, err := os.Stat(nwSession); err == nil {
		return
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
		return
	}

	var oldSettings domain.Settings
	if err := json.Unmarshal(oldData, &oldSettings); err != nil || oldSettings.CLI == "" {
		if _, err := os.Stat(newPath); os.IsNotExist(err) {
			if err := os.Rename(oldPath, newPath); err != nil {
				logger.Warn("migrateSettings: rename failed", "err", err)
			} else {
				logger.Info("migrated settings.json", "from", oldPath, "to", newPath)
			}
		}
		return
	}

	if newData, err := os.ReadFile(newPath); err == nil {
		var newSettings domain.Settings
		if json.Unmarshal(newData, &newSettings) == nil && newSettings.CLI != "" {
			return
		}
	}

	if err := os.WriteFile(newPath, oldData, 0o644); err != nil {
		logger.Warn("migrateSettings: write failed", "err", err)
		return
	}
	os.Remove(oldPath)
	logger.Info("migrated settings.json (cli merge)", "from", oldPath, "to", newPath)
}

