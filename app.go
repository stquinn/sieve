package main

import (
	"context"
	"crypto/tls"
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
	"sieve/store"
	"sieve/store/filestore"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/net/html"
)

// App is the Wails application backend.
type App struct {
	ctx      context.Context
	storePath string // current library root; internal file-path detail
	hostname  string

	ServiceProvider *sieve.ServiceProvider
	Documents       *sieve.DocumentService
	Assets          *sieve.AssetService
	State           *sieve.StateService
	Prompts         *sieve.PromptService
	AI              *sieve.AIService

	library  sieve.LibraryService // owns library discovery, recents, naming
	themesFS fs.FS
	hub      *sseHub
	watcher  *notesWatcher
	closing  bool
	mu       sync.Mutex

	DevServerPort int
}

func NewApp(storePath string, themesFS fs.FS, hub *sseHub, serviceProvider *sieve.ServiceProvider, library sieve.LibraryService) *App {
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

// GetThemesFS returns the embedded themes filesystem.
func (a *App) GetThemesFS() fs.FS { return a.themesFS }

// GetStorePath returns the active store root path.
func (a *App) GetStorePath() string { return a.storePath }

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
	a.ServiceProvider.Init(fs, a.storePath)
	a.Documents = a.ServiceProvider.Documents
	a.Assets = a.ServiceProvider.Assets
	a.State = a.ServiceProvider.State
	a.Prompts = a.ServiceProvider.Prompts
	a.AI = a.ServiceProvider.AI

	if err := fs.RunMigrationIfNeeded([]store.Category{sieve.LibraryCategory, sieve.WorkingCopy}); err != nil {
		logger.Error("store migration failed", "err", err)
	}

	settings := a.State.LoadSettings()

	// Attach the library service to the live store and record this switch.
	a.library.Attach(a.storePath, fs)
	a.library.RecordSwitch(a.storePath)
	a.ServiceProvider.Library = a.library
	a.hub.broadcast("library:changed", "")

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
		if a.ServiceProvider.Editor != nil {
			a.ServiceProvider.Editor.FlushAll()
		}
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
	if a.storePath == "" || a.State == nil {
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
		IsNew:              a.Documents.Count() == 0,
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
		a.ServiceProvider.Editor.FlushAll()
	}
	a.storePath = path
	a.startup(a.ctx)
	if a.storePath == "" {
		return "", fmt.Errorf("failed to load the selected library")
	}
	runtime.MenuSetApplicationMenu(a.ctx, buildMenu(a))
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

// ── Assets ────────────────────────────────────────────────────────────────────

// DownloadAsset fetches an image from a URL and stores it as an asset.
// uuid identifies the owning document (or "" when no document is active).
// Called directly from editor.js via the Wails bridge.
func (a *App) DownloadAsset(uuid, targetURL, id string) (AssetDTO, error) {
	if a.Assets == nil {
		return AssetDTO{}, fmt.Errorf("store not open")
	}
	data, err := downloadURL(targetURL)
	if err != nil {
		logger.Error("DownloadAsset: fetch failed", "url", targetURL, "err", err)
		return AssetDTO{}, err
	}

	cat := sieve.WorkingCopy
	var doc sieve.Document
	if uuid != "" && a.Documents != nil {
		if d, err := a.Documents.LoadByUUID(uuid); err == nil {
			doc = d
			if doc.Kind() == sieve.KindNote {
				cat = sieve.LibraryCategory
			}
		}
	}

	asset, err := a.Assets.Save(cat, uuid, id, data)
	if err != nil {
		logger.Error("DownloadAsset: save failed", "id", id, "err", err)
		return AssetDTO{}, err
	}

	if doc != nil {
		doc.Storable().AttachAsset(asset.Storable())
		if _, err := a.Documents.Save(doc); err != nil {
			logger.Warn("DownloadAsset: failed to attach asset", "err", err)
		}
	}
	logger.Info("asset downloaded", "url", targetURL, "externalRef", asset.ExternalRef())
	return toAssetDTO(asset), nil
}

// ── AI / CLI operations ───────────────────────────────────────────────────────

// window.__stashActiveTabUuid, mdPath, blkId
func (a *App) DescribeImage(uuid string, storeRelPath string, blkId string) (sieve.ImageDesc, error) {
	if a.AI == nil {
		return sieve.ImageDesc{}, fmt.Errorf("store not open")
	}
	desc, err := a.AI.DescribeImage(uuid, storeRelPath, blkId)
	if err != nil {
		logger.Warn("DescribeImage failed", "err", err)
		return sieve.ImageDesc{}, err
	}
	return desc, nil
}

func (a *App) RefineLanguage(content string) (string, error) {
	if a.AI == nil {
		return "", fmt.Errorf("store not open")
	}
	lang, err := a.AI.RefineLanguage(content)
	if err != nil {
		logger.Warn("RefineLanguage failed", "err", err)
		return "", err
	}
	return lang, nil
}

func (a *App) GetLinkTitle(url string) (string, error) {
	logger.Info("Getting title for ", url)
	if url == "" {
		return "", fmt.Errorf("store not open")
	}
	var title string = ""
	// 1. Make the HTTP GET request
	client := &http.Client{}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("status code error: %d %s", resp.StatusCode, resp.Status)
	}

	// 2. Parse the HTML document
	doc, err := html.Parse(resp.Body)
	if err != nil {
		return "", err
	}

	// 3. Recursively find the <title> node

	var f func(*html.Node)
	f = func(n *html.Node) {
		if title != "" {
			return
		}
		if n.Type == html.ElementNode && n.Data == "title" && n.FirstChild != nil {
			title = n.FirstChild.Data
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			f(c)
		}
	}
	f(doc)
	logger.Info("Returning title", "url", url, "title", title)
	return strings.TrimSpace(title), nil
}

// ── File manager ──────────────────────────────────────────────────────────────

// ShowInFilesByID reveals a document or folder in the OS file manager.
// id is a UUID (note/buffer), an opaque folder ID (ExternalRef), or "prompt:name".
func (a *App) ShowInFilesByID(id string) error {
	if strings.HasPrefix(id, "prompt:") {
		return a.ShowInFiles(a.promptsDir())
	}
	if a.Documents != nil {
		if doc, err := a.Documents.LoadByUUID(id); err == nil {
			return a.ShowInFiles(doc.Storable().ExternalRef())
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

	var oldSettings sieve.Settings
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
		var newSettings sieve.Settings
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
