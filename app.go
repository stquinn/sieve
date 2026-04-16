package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"stash/logger"
	"stash/vault"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application backend.
type App struct {
	ctx          context.Context
	vaultPath    string
	settingsPath string
	vault        *vault.Vault
	settings     vault.Settings
	themesFS     fs.FS
	watcher      *notesWatcher
	closing      bool // prevents OnBeforeClose loop
	mu           sync.Mutex
}

func NewApp(vaultPath string, themesFS fs.FS) *App {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "localhost"
	}
	return &App{
		vaultPath:    vaultPath,
		settingsPath: filepath.Join(vaultPath, hostname, "settings.json"),
		themesFS:     themesFS,
	}
}

func (a *App) SettingsPath() string {
	return a.settingsPath
}

func (a *App) GetThemesFS() fs.FS {
	return a.themesFS
}

func (a *App) GetVaultPath() string {
	return a.vaultPath
}

// startup is called by Wails when the application window is ready.
func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.ctx = ctx

	abs, _ := filepath.Abs(a.vaultPath)
	logger.Info("startup", "vault_raw", a.vaultPath, "vault_abs", abs)

	if a.vaultPath == "" {
		logger.Info("startup: no vault path specified — entering bootstrap mode")
		return
	}

	// Close old watcher if any
	if a.watcher != nil {
		a.watcher.Close()
		a.watcher = nil
	}

	v, err := vault.Open(a.vaultPath)
	if err != nil {
		logger.Error("vault open failed", "err", err)
		return
	}

	a.vault = v
	a.settings = vault.LoadSettings(v.SettingsPath())

	// Save this vault path as the last used one
	config := vault.LoadGlobalConfig()
	config.LastVaultPath = v.Root
	if err := config.Save(); err != nil {
		logger.Warn("could not save global config", "err", err)
	}

	logger.Info("vault ready",
		"root", v.Root,
		"hostname", v.Hostname,
		"tier", a.settings.Tier(),
		"autosave_debounce", a.settings.AutosaveDebounce,
		"debug", a.settings.Debug,
	)

	// Write a startup probe so the vault path is easily confirmed on disk
	probe := filepath.Join(v.Root, ".startup-probe")
	_ = os.WriteFile(probe, []byte(fmt.Sprintf("started at %s\nvault: %s\nhost:  %s\n",
		time.Now().Format(time.RFC3339), v.Root, v.Hostname)), 0o644)

	// Restore window size and position from last session.
	// Position is stored in absolute screen coordinates, so it works across
	// multi-monitor setups. If the saved position is negative (off the primary
	// monitor to the left/above) we still restore it — Wails/the WM will keep
	// it on whatever monitor owns that coordinate space. We only skip positions
	// that look completely bogus (both axes deeply negative), which would
	// indicate a monitor that no longer exists.
	savedSession := vault.LoadSession(v.SessionPath())
	if savedSession.Window.Width >= 800 && savedSession.Window.Height >= 500 {
		runtime.WindowSetSize(ctx, savedSession.Window.Width, savedSession.Window.Height)
		logger.Debug("window size restored", "w", savedSession.Window.Width, "h", savedSession.Window.Height)
	}
	win := savedSession.Window
	if win.X > -4000 && win.Y > -4000 {
		runtime.WindowSetPosition(ctx, win.X, win.Y)
		logger.Debug("window position restored", "x", win.X, "y", win.Y)
	}

	// Start watching vault/notes/ for filesystem changes
	w, err := newNotesWatcher(v.NotesPath(), func() {
		logger.Debug("notes changed — emitting event")
		runtime.EventsEmit(a.ctx, "notes:changed")
	})
	if err != nil {
		logger.Warn("could not start notes watcher", "err", err)
	} else {
		a.watcher = w
	}
}

func (a *App) beforeClose(ctx context.Context) bool {
	if a.closing {
		return false // final exit allowed
	}

	// Save window state Go-side (fast synchronously)
	if a.vault != nil {
		x, y := runtime.WindowGetPosition(ctx)
		w, h := runtime.WindowGetSize(ctx)
		session := vault.LoadSession(a.vault.SessionPath())
		session.Window = vault.Window{X: x, Y: y, Width: w, Height: h}
		_ = session.Save(a.vault.SessionPath())
	}

	// Signpost frontend to flush state
	logger.Info("beforeClose: vetoing and requesting flush")
	runtime.EventsEmit(ctx, "app:closing")
	return true 
}

// Quit terminates the app. Frontend calls this after flushing its state.
func (a *App) Quit() {
	if a.closing { return }
	a.closing = true
	
	logger.Info("App.Quit: exiting")
	if a.watcher != nil {
		a.watcher.Close()
	}
	
	// Try graceful runtime quit first, then force exit
	runtime.Quit(a.ctx)
	
	// Fallback to os.Exit if runtime.Quit is somehow blocked for more than 500ms
	go func() {
		time.Sleep(500 * time.Millisecond)
		logger.Warn("App.Quit: runtime.Quit timed out, forcing os.Exit")
		os.Exit(0)
	}()
}

// ── Vault info ────────────────────────────────────────────────────────────────

type VaultInfo struct {
	Root               string          `json:"root"`
	Hostname           string          `json:"hostname"`
	BuffersPath        string          `json:"buffersPath"`
	NotesPath          string          `json:"notesPath"`
	IsNew              bool            `json:"isNew"`
	Tier               vault.Tier      `json:"tier"`
	Cli                string          `json:"cli"`
	Debug              bool            `json:"debug"`
	AutosaveDebounce   int             `json:"autosaveDebounce"`
	ThemeName          string          `json:"themeName"`
	ThemeVars          vault.ThemeVars `json:"themeVars"`
	MaxHistoryVersions int             `json:"maxHistoryVersions"`
	CLITimeoutLong     int             `json:"cliTimeoutLong"`
}

func (a *App) GetVaultInfo() VaultInfo {
	if a.vault == nil {
		logger.Warn("GetVaultInfo: vault not open")
		return VaultInfo{}
	}

	logger.Info("GetVaultInfo", "root", a.vault.Root)
	liveSettings := vault.LoadSettings(a.vault.SettingsPath())

	return VaultInfo{
		Root:               a.vault.Root,
		Hostname:           a.vault.Hostname,
		BuffersPath:        a.vault.BuffersPath(),
		NotesPath:          a.vault.NotesPath(),
		IsNew:              a.vault.IsNewVault(),
		Tier:               liveSettings.Tier(),
		Cli:                liveSettings.CLI,
		Debug:              liveSettings.Debug,
		AutosaveDebounce:   liveSettings.AutosaveDebounce,
		ThemeName:          liveSettings.Theme,
		ThemeVars:          vault.LoadTheme(a.vault.Root, liveSettings.Theme, a.themesFS),
		MaxHistoryVersions: liveSettings.MaxHistoryVersions,
		CLITimeoutLong:     liveSettings.CLITimeoutLong,
	}
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

func (a *App) SaveSidebarWidth(width int) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	session := vault.LoadSession(a.vault.SessionPath())
	session.SidebarWidth = width
	if err := session.Save(a.vault.SessionPath()); err != nil {
		logger.Error("SaveSidebarWidth failed", "err", err)
		return err
	}
	logger.Debug("sidebar width saved", "width", width)
	return nil
}

func (a *App) SaveMetaWidth(width int) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	session := vault.LoadSession(a.vault.SessionPath())
	session.MetaWidth = width
	if err := session.Save(a.vault.SessionPath()); err != nil {
		logger.Error("SaveMetaWidth failed", "err", err)
		return err
	}
	logger.Debug("meta width saved", "width", width)
	return nil
}

// ── Bootstrapping ─────────────────────────────────────────────────────────────

func (a *App) SelectVault() (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}

	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Stash Vault",
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // user cancelled
	}

	// Try to validate it.
	if err := vault.ValidateVault(path); err != nil {
		return "", fmt.Errorf("this directory does not look like a Stash vault: %w", err)
	}

	// Save to global config so it's found on reload
	config := vault.LoadGlobalConfig()
	config.LastVaultPath = path
	if err := config.Save(); err != nil {
		return "", fmt.Errorf("could not update global config: %w", err)
	}

	a.vaultPath = path
	a.startup(a.ctx)

	logger.Info("vault selected", "path", path)
	return path, nil
}

func (a *App) CreateVault() (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}

	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Folder to Initialize Vault",
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil // user cancelled
	}
	// vault.Open will create the directories
	a.vaultPath = path
	a.startup(a.ctx)

	logger.Info("vault creation initialized", "path", path)
	return path, nil
}

func (a *App) InitVault(path string) error {
	if path == "" {
		return fmt.Errorf("path cannot be empty")
	}

	// Expand ~ if present
	if strings.HasPrefix(path, "~") {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, path[1:])
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("invalid path: %w", err)
	}

	// Save to global config
	config := vault.LoadGlobalConfig()
	config.LastVaultPath = abs
	if err := config.Save(); err != nil {
		return fmt.Errorf("could not update global config: %w", err)
	}

	a.vaultPath = abs
	a.startup(a.ctx)

	logger.Info("vault initialized manually — READY", "path", abs)
	return nil
}


// ── Notes ─────────────────────────────────────────────────────────────────────

func (a *App) GetNotes() []vault.NoteEntry {
	if a.vault == nil {
		logger.Warn("GetNotes: vault not open")
		return nil
	}
	entries := vault.ScanNotes(a.vault.Root, a.vault.NotesPath())
	logger.Debug("GetNotes", "entries", len(entries))
	return entries
}

func (a *App) SearchVault(query string) []vault.SearchResult {
	if a.vault == nil {
		logger.Warn("SearchVault: vault not open")
		return nil
	}
	searchDirs := []string{a.vault.NotesPath(), a.vault.BuffersPath()}
	results := vault.SearchVault(a.vault.Root, searchDirs, query)
	logger.Debug("SearchVault", "query", query, "results", len(results))
	return results
}


// ── Session ───────────────────────────────────────────────────────────────────

func (a *App) GetSession() vault.Session {
	if a.vault == nil {
		logger.Warn("GetSession: vault not open")
		return vault.Session{}
	}

	logger.Info("GetSession", "path", a.vault.SessionPath())
	session := vault.LoadSession(a.vault.SessionPath())
	logger.Debug("session loaded", "tabs", len(session.Tabs))

	// Prune tabs whose files no longer exist
	live := session.Tabs[:0]
	for _, t := range session.Tabs {
		if _, err := os.Stat(a.resolvePath(t.Path)); err == nil {
			live = append(live, t)
		} else {
			logger.Warn("session: skipping missing file", "path", t.Path)
		}
	}
	session.Tabs = live

	if len(session.Tabs) == 0 {
		result, err := a.vault.NewBuffer()
		if err != nil {
			logger.Error("new buffer failed", "err", err)
			return vault.Session{}
		}
		logger.Info("session: no tabs — created default buffer", "path", result.Path, "uuid", result.UUID)
		session.Tabs = []vault.Tab{{Path: result.Path, Active: true, Mode: "wysiwyg"}}
		if err := session.Save(a.vault.SessionPath()); err != nil {
			logger.Error("session save failed", "err", err)
		}
	} else {
		hasActive := false
		for _, t := range session.Tabs {
			if t.Active {
				hasActive = true
				break
			}
		}
		if !hasActive {
			session.Tabs[0].Active = true
			logger.Debug("session: no active tab — defaulting to first")
		}
	}

	return session
}

func (a *App) SaveSession(session vault.Session) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	// Merge with existing session so fields saved independently (widths, window)
	// are not overwritten when the frontend sends partial session state.
	existing := vault.LoadSession(a.vault.SessionPath())
	if session.SidebarWidth == 0 {
		session.SidebarWidth = existing.SidebarWidth
	}
	if session.MetaWidth == 0 {
		session.MetaWidth = existing.MetaWidth
	}
	if session.Window == (vault.Window{}) {
		session.Window = existing.Window
	}
	if err := session.Save(a.vault.SessionPath()); err != nil {
		logger.Error("SaveSession failed", "err", err)
		return err
	}
	logger.Debug("session saved", "tabs", len(session.Tabs))
	return nil
}

func (a *App) NewBuffer() (vault.NewBufferResult, error) {
	if a.vault == nil {
		return vault.NewBufferResult{}, fmt.Errorf("vault not open")
	}
	result, err := a.vault.NewBuffer()
	if err != nil {
		logger.Error("NewBuffer failed", "err", err)
		return vault.NewBufferResult{}, err
	}
	logger.Info("buffer created", "path", result.Path, "uuid", result.UUID)
	return result, nil
}

// ── Buffer I/O ────────────────────────────────────────────────────────────────

func (a *App) LoadBuffer(path string) (string, error) {
	resolved := a.resolvePath(path)
	data, err := os.ReadFile(resolved)
	if err != nil {
		logger.Error("LoadBuffer failed", "path", path, "err", err)
		return "", err
	}
	logger.Debug("buffer loaded", "path", path, "bytes", len(data))
	return string(data), nil
}

func (a *App) SaveBuffer(path string, content string) error {
	// Safety guard: never write back content that has lost its frontmatter.
	// This prevents a race condition during hot reload from silently stripping meta.
	if !strings.HasPrefix(content, "---\n") {
		logger.Error("SaveBuffer rejected — missing frontmatter", "path", path, "preview", content[:min(40, len(content))])
		return fmt.Errorf("save rejected: content missing frontmatter block")
	}
	resolved := a.resolvePath(path)
	if err := os.WriteFile(resolved, []byte(content), 0o644); err != nil {
		logger.Error("SaveBuffer failed", "path", path, "err", err)
		return err
	}
	logger.Debug("buffer saved", "path", path, "bytes", len(content))
	return nil
}

func (a *App) GetBufferHistory(uuid string) []vault.HistorySnapshot {
	if a.vault == nil {
		return nil
	}
	return a.vault.ListHistory(uuid)
}

func splitFrontmatter(content string) (fm string, body string) {
	if !strings.HasPrefix(content, "---\n") {
		return "", content
	}
	end := strings.Index(content[4:], "\n---\n")
	if end == -1 {
		return "", content
	}
	return content[:end+9], content[end+9:]
}

func replaceAndBumpVersion(fm string) string {
	versionRe := regexp.MustCompile(`(?m)^version:\s*(\d+)`)
	m := versionRe.FindStringSubmatch(fm)
	if m != nil {
		if v, err := strconv.Atoi(m[1]); err == nil {
			return versionRe.ReplaceAllString(fm, fmt.Sprintf("version: %d", v+1))
		}
	}
	return fm
}

func (a *App) GetBufferHistoryBody(uuid string, targetVersion int) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}

	p1 := filepath.Join(a.vault.HostHistoryDir(), fmt.Sprintf("%s.%d.md", uuid, targetVersion))
	p2 := filepath.Join(a.vault.VaultHistoryDir(), fmt.Sprintf("%s.%d.md", uuid, targetVersion))

	histData, err := os.ReadFile(p1)
	if err != nil {
		histData, err = os.ReadFile(p2)
		if err != nil {
			return "", fmt.Errorf("history file not found for version %d (checked global and local space)", targetVersion)
		}
	}

	_, histBody := splitFrontmatter(string(histData))
	return histBody, nil
}

func (a *App) EvaluateBuffer(path string) (*vault.FilingRecommendation, error) {
	if a.vault == nil {
		return nil, fmt.Errorf("vault not open")
	}

	resolved := a.resolvePath(path)
	currentSettings := vault.LoadSettings(a.vault.SettingsPath())
	
	rec, err := a.vault.EvaluateBuffer(resolved, currentSettings)
	if err != nil {
		logger.Warn("EvaluateBuffer failed", "path", path, "err", err)
		return nil, err
	}

	logger.Info("EvaluateBuffer success", "path", path)
	return rec, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func (a *App) FileBuffer(path string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}
	resolved := a.resolvePath(path)
	newPath, err := a.vault.FileBuffer(resolved)
	if err != nil {
		logger.Error("FileBuffer failed", "path", path, "err", err)
		return "", err
	}
	logger.Info("buffer filed", "from", path, "to", newPath)
	return newPath, nil
}

func (a *App) DiscardBuffer(path string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	resolved := a.resolvePath(path)
	if err := a.vault.DiscardBuffer(resolved); err != nil {
		logger.Error("DiscardBuffer failed", "path", path, "err", err)
		return err
	}
	logger.Info("buffer discarded", "path", path)
	return nil
}

func (a *App) DeleteNote(path string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	resolved := a.resolvePath(path)
	uuid := vault.ExtractUuid(resolved)

	if err := os.Remove(resolved); err != nil {
		logger.Error("DeleteNote failed", "path", path, "err", err)
		return err
	}

	if uuid != "" {
		if err := a.vault.DeleteHistory(uuid); err != nil {
			logger.Warn("DeleteHistory failed during note deletion", "uuid", uuid, "err", err)
		}
	}

	logger.Info("note deleted", "path", path, "uuid", uuid)
	return nil
}

func (a *App) MoveNote(oldPath, newPath string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	oldResolved := a.resolvePath(oldPath)
	newResolved := a.resolvePath(newPath)

	// Ensure destination directory exists
	if err := os.MkdirAll(filepath.Dir(newResolved), 0755); err != nil {
		return err
	}

	if err := os.Rename(oldResolved, newResolved); err != nil {
		logger.Error("MoveNote failed", "from", oldPath, "to", newPath, "err", err)
		return err
	}

	logger.Info("note moved", "from", oldPath, "to", newPath)
	return nil
}

func (a *App) CreateFolder(path string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	resolved := a.resolvePath(path)
	if err := os.MkdirAll(resolved, 0755); err != nil {
		logger.Error("CreateFolder failed", "path", path, "err", err)
		return err
	}
	logger.Info("folder created", "path", path)
	return nil
}

func (a *App) DeleteFolder(path string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	resolved := a.resolvePath(path)
	
	// Ensure it's a directory
	info, err := os.Stat(resolved)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("not a directory")
	}

	// Check if empty
	entries, err := os.ReadDir(resolved)
	if err != nil {
		return err
	}
	if len(entries) > 0 {
		return fmt.Errorf("directory not empty")
	}

	if err := os.Remove(resolved); err != nil {
		logger.Error("DeleteFolder failed", "path", path, "err", err)
		return err
	}
	logger.Info("folder deleted", "path", path)
	return nil
}

func (a *App) RenameFolder(oldPath, newPath string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	oldResolved := a.resolvePath(oldPath)
	newResolved := a.resolvePath(newPath)

	if err := os.Rename(oldResolved, newResolved); err != nil {
		logger.Error("RenameFolder failed", "from", oldPath, "to", newPath, "err", err)
		return err
	}
	return nil
}

// ShowInFiles opens the OS file manager at the given vault-relative path.
// On macOS it uses "open -R" to reveal files; on Linux it uses xdg-open on
// the containing directory. Directories are opened directly on both platforms.
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
		// Linux — xdg-open the directory; revealing a specific file is not
		// portable across file managers.
		dir := resolved
		if !info.IsDir() {
			dir = filepath.Dir(resolved)
		}
		cmd = exec.Command("xdg-open", dir)
	}

	logger.Debug("ShowInFiles", "path", resolved, "os", goruntime.GOOS)
	return cmd.Start()
}

// RefineLanguage asks the configured CLI to identify the programming language of
// a code snippet. Returns empty string in dumb mode or when the CLI response is
// unrecognised.
func (a *App) RefineLanguage(content string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}
	settings := vault.LoadSettings(a.vault.SettingsPath())
	if settings.Tier() == vault.TierDumb {
		return "", fmt.Errorf("dumb mode")
	}
	lang, err := vault.RefineLanguage(content, settings)
	if err != nil {
		logger.Warn("RefineLanguage failed", "err", err)
		return "", err
	}
	logger.Debug("RefineLanguage", "lang", lang)
	return lang, nil
}

// FileBufferWithName moves a buffer to vault/notes/ using the supplied name as
// user_suggested_name so the filer picks it up as the filename.
func (a *App) FileBufferWithName(path, name string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}
	resolved := a.resolvePath(path)
	newPath, err := a.vault.FileBufferWithName(resolved, name)
	if err != nil {
		logger.Error("FileBufferWithName failed", "path", path, "err", err)
		return "", err
	}
	logger.Info("buffer filed with name", "from", path, "to", newPath, "name", name)
	return newPath, nil
}

// Explain asks the configured CLI to explain the given content (selected text or
// full buffer body). Returns the response as a markdown string for inline insertion.
// Returns an error in dumb mode or if the CLI times out.
func (a *App) Explain(content string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}
	settings := vault.LoadSettings(a.vault.SettingsPath())
	if settings.Tier() == vault.TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}
	resp, err := a.vault.RunExplain(content, settings)
	if err != nil {
		logger.Warn("Explain failed", "err", err)
		return "", err
	}
	logger.Debug("Explain complete", "resp_len", len(resp))
	return resp, nil
}

// Ask asks the configured CLI a question with the given content as context.
// history may be empty for first-turn asks. Returns the response as a markdown string.
func (a *App) Ask(content, history, question string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}
	settings := vault.LoadSettings(a.vault.SettingsPath())
	if settings.Tier() == vault.TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}
	resp, err := a.vault.RunAsk(content, history, question, settings)
	if err != nil {
		logger.Warn("Ask failed", "err", err)
		return "", err
	}
	logger.Debug("Ask complete", "resp_len", len(resp))
	return resp, nil
}

// SaveVersionSnapshot writes a full content snapshot to .history/{uuid}.{version}.md.
// Called from the frontend after every meaningful save (version bump). Never blocks
// the save path — prune runs in a background goroutine.
func (a *App) SaveVersionSnapshot(uuid string, version int, content string) error {
	if a.vault == nil {
		return fmt.Errorf("vault not open")
	}
	maxVersions := a.settings.MaxHistoryVersions
	if err := a.vault.SaveVersionSnapshot(uuid, version, content); err != nil {
		logger.Error("SaveVersionSnapshot failed", "uuid", uuid, "version", version, "err", err)
		return err
	}
	go func() {
		if err := a.vault.PruneHistory(uuid, maxVersions); err != nil {
			logger.Warn("PruneHistory failed", "uuid", uuid, "err", err)
		}
	}()
	logger.Debug("version snapshot saved", "uuid", uuid, "version", version)
	return nil
}

func (a *App) resolvePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	if a.vault != nil {
		return filepath.Join(a.vault.Root, path)
	}
	return path
}

func (a *App) SaveBufferAsset(id string, dataBase64 string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}

	idx := strings.Index(dataBase64, ",")
	if idx >= 0 {
		dataBase64 = dataBase64[idx+1:]
	}

	decoded, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		logger.Error("SaveBufferAsset decode failed", "err", err)
		return "", err
	}

	filename := fmt.Sprintf("%s.png", id)
	path := filepath.Join(a.vault.BufferAssetsPath(), filename)

	if err := os.WriteFile(path, decoded, 0o644); err != nil {
		logger.Error("SaveBufferAsset write failed", "path", path, "err", err)
		return "", err
	}

	// Return vault-relative path so frontend can construct display URL and markdown path
	rel, err := filepath.Rel(a.vault.Root, path)
	if err != nil {
		return filename, nil
	}
	rel = filepath.ToSlash(rel) // always forward slashes for frontend
	logger.Info("buffer asset saved", "vaultRelPath", rel)
	return rel, nil
}

// SaveNoteAsset saves a pasted image directly to vault/assets/ for use in filed notes.
// It uses the note's filename as a prefix (e.g. "note-20250101-blk-xxx.png") to avoid global collisions.
// Returns vault-relative path (e.g. "assets/note-20250101-blk-xxx.png").
func (a *App) SaveNoteAsset(notePath string, id string, dataBase64 string) (string, error) {
	if a.vault == nil {
		return "", fmt.Errorf("vault not open")
	}

	idx := strings.Index(dataBase64, ",")
	if idx >= 0 {
		dataBase64 = dataBase64[idx+1:]
	}

	decoded, err := base64.StdEncoding.DecodeString(dataBase64)
	if err != nil {
		logger.Error("SaveNoteAsset decode failed", "err", err)
		return "", err
	}

	noteName := strings.TrimSuffix(filepath.Base(notePath), filepath.Ext(notePath))
	filename := fmt.Sprintf("%s-%s.png", noteName, id)
	path := filepath.Join(a.vault.AssetsPath(), filename)

	if err := os.WriteFile(path, decoded, 0o644); err != nil {
		logger.Error("SaveNoteAsset write failed", "path", path, "err", err)
		return "", err
	}

	rel, err := filepath.Rel(a.vault.Root, path)
	if err != nil {
		return "assets/" + filename, nil
	}
	rel = filepath.ToSlash(rel)
	logger.Info("note asset saved", "vaultRelPath", rel)
	return rel, nil
}
