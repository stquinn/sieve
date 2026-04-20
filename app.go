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

	"stash/logger"
	"stash/stash"
	"stash/store"
	"stash/store/filestore"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application backend.
type App struct {
	ctx      context.Context
	storePath string
	hostname  string // resolved at startup from os.Hostname

	// Phase 3/4 services — the Store-backed persistence layer.
	buffers *stash.BufferService
	notes   *stash.NoteService
	assets  *stash.AssetService

	// Kept for EvaluateBuffer, RunExplain, RunAsk, and prompt management.
	// Will be removed once those are refactored to standalone functions.
	stash *stash.Store

	settings stash.Settings
	themesFS fs.FS
	watcher  *notesWatcher
	closing  bool
	mu       sync.Mutex
}

func NewApp(storePath string, themesFS fs.FS) *App {
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "localhost"
	}
	return &App{
		storePath: storePath,
		hostname:  hostname,
		themesFS:  themesFS,
	}
}

// ── Path helpers ──────────────────────────────────────────────────────────────

// configDir returns the absolute path to the per-host config directory
// ({storePath}/{hostname}/config/). Settings and session live here.
func (a *App) configDir() string {
	return filepath.Join(a.storePath, a.hostname, "config")
}

func (a *App) settingsFilePath() string {
	return filepath.Join(a.configDir(), "settings.json")
}

func (a *App) sessionFilePath() string {
	return filepath.Join(a.configDir(), "session.json")
}

func (a *App) notesDir() string {
	return filepath.Join(a.storePath, "store")
}

func (a *App) promptsDir() string {
	return filepath.Join(a.storePath, a.hostname, "prompts")
}

func (a *App) buffersDir() string {
	return filepath.Join(a.storePath, a.hostname, "buffers")
}

// SettingsPath is exported for Wails startup config injection.
func (a *App) SettingsPath() string { return a.settingsFilePath() }
func (a *App) GetThemesFS() fs.FS   { return a.themesFS }
func (a *App) GetStorePath() string { return a.storePath }

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// startup is called by Wails when the application window is ready.
func (a *App) startup(ctx context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.ctx = ctx

	abs, _ := filepath.Abs(a.storePath)
	logger.Info("startup", "vault_raw", a.storePath, "vault_abs", abs)

	if a.storePath == "" {
		logger.Info("startup: no store path specified — entering bootstrap mode")
		return
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

	// ── Legacy path-bag store (kept for EvaluateBuffer / RunExplain / RunAsk) ──
	v, err := stash.Open(a.storePath)
	if err != nil {
		logger.Error("store open failed", "err", err)
		return
	}
	a.stash = v

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
	a.buffers = stash.NewBufferService(fs)
	a.notes = stash.NewNoteService(fs)
	a.assets = stash.NewAssetService(fs)

	a.settings = stash.LoadSettings(a.settingsFilePath())

	// Save last-used store path.
	config := stash.LoadGlobalConfig()
	config.LastStorePath = a.storePath
	if err := config.Save(); err != nil {
		logger.Warn("could not save global config", "err", err)
	}

	logger.Info("store ready",
		"root", a.storePath,
		"hostname", a.hostname,
		"tier", a.settings.Tier(),
		"autosave_debounce", a.settings.AutosaveDebounce,
		"debug", a.settings.Debug,
	)

	// Startup probe.
	probe := filepath.Join(a.storePath, ".startup-probe")
	_ = os.WriteFile(probe, []byte(fmt.Sprintf("started at %s\nvault: %s\nhost:  %s\n",
		time.Now().Format(time.RFC3339), a.storePath, a.hostname)), 0o644)

	// Restore window geometry.
	savedSession := stash.LoadSession(a.sessionFilePath())
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
	if a.storePath != "" {
		x, y := runtime.WindowGetPosition(ctx)
		w, h := runtime.WindowGetSize(ctx)
		session := stash.LoadSession(a.sessionFilePath())
		session.Window = stash.Window{X: x, Y: y, Width: w, Height: h}
		_ = session.Save(a.sessionFilePath())
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
	Tier               stash.Tier      `json:"tier"`
	Cli                string          `json:"cli"`
	Debug              bool            `json:"debug"`
	AutosaveDebounce   int             `json:"autosaveDebounce"`
	ThemeName          string          `json:"themeName"`
	ThemeVars          stash.ThemeVars `json:"themeVars"`
	MaxHistoryVersions int             `json:"maxHistoryVersions"`
	CLITimeoutLong     int             `json:"cliTimeoutLong"`
	ShowPrompts        bool            `json:"showPrompts"`
}

func (a *App) GetStoreInfo() StoreInfo {
	if a.storePath == "" {
		logger.Warn("GetStoreInfo: store not open")
		return StoreInfo{}
	}

	logger.Info("GetStoreInfo", "root", a.storePath)
	liveSettings := stash.LoadSettings(a.settingsFilePath())

	return StoreInfo{
		Root:               a.storePath,
		Hostname:           a.hostname,
		BuffersPath:        a.buffersDir(),
		NotesPath:          a.notesDir(),
		IsNew:              a.notes.Count() == 0,
		Tier:               liveSettings.Tier(),
		Cli:                liveSettings.CLI,
		Debug:              liveSettings.Debug,
		AutosaveDebounce:   liveSettings.AutosaveDebounce,
		ThemeName:          liveSettings.Theme,
		ThemeVars:          stash.LoadTheme(a.storePath, liveSettings.Theme, a.themesFS),
		MaxHistoryVersions: liveSettings.MaxHistoryVersions,
		CLITimeoutLong:     liveSettings.CLITimeoutLong,
		ShowPrompts:        stash.LoadSession(a.sessionFilePath()).ShowPrompts,
	}
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

func (a *App) SaveSidebarWidth(width int) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	session := stash.LoadSession(a.sessionFilePath())
	session.SidebarWidth = width
	if err := session.Save(a.sessionFilePath()); err != nil {
		logger.Error("SaveSidebarWidth failed", "err", err)
		return err
	}
	return nil
}

func (a *App) SaveMetaWidth(width int) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	session := stash.LoadSession(a.sessionFilePath())
	session.MetaWidth = width
	return session.Save(a.sessionFilePath())
}

func (a *App) SavePromptsHeight(height int) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	session := stash.LoadSession(a.sessionFilePath())
	session.PromptsHeight = height
	return session.Save(a.sessionFilePath())
}

// ── Bootstrapping ─────────────────────────────────────────────────────────────

func (a *App) SelectVault() (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Stash Store",
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := stash.ValidateStore(path); err != nil {
		return "", fmt.Errorf("this directory does not look like a Stash store: %w", err)
	}
	config := stash.LoadGlobalConfig()
	config.LastStorePath = path
	if err := config.Save(); err != nil {
		return "", fmt.Errorf("could not update global config: %w", err)
	}
	a.storePath = path
	a.startup(a.ctx)
	logger.Info("store selected", "path", path)
	return path, nil
}

func (a *App) CreateVault() (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	path, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Folder to Initialize Store",
	})
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	a.storePath = path
	a.startup(a.ctx)
	logger.Info("store creation initialized", "path", path)
	return path, nil
}

func (a *App) InitVault(path string) error {
	if path == "" {
		return fmt.Errorf("path cannot be empty")
	}
	if strings.HasPrefix(path, "~") {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, path[1:])
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("invalid path: %w", err)
	}
	config := stash.LoadGlobalConfig()
	config.LastStorePath = abs
	if err := config.Save(); err != nil {
		return fmt.Errorf("could not update global config: %w", err)
	}
	a.storePath = abs
	a.startup(a.ctx)
	logger.Info("store initialized manually — READY", "path", abs)
	return nil
}

// ── Prompts ───────────────────────────────────────────────────────────────────

func (a *App) GetPrompts() []stash.PromptEntry {
	if a.storePath == "" {
		return nil
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	return []stash.PromptEntry{
		{Name: "file", DisplayName: "Smart Filing", Path: settings.Prompts.File, IsVirtual: settings.Prompts.File == ""},
		{Name: "explain", DisplayName: "Explain Content", Path: settings.Prompts.Explain, IsVirtual: settings.Prompts.Explain == ""},
		{Name: "ask", DisplayName: "In-context Chat", Path: settings.Prompts.Ask, IsVirtual: settings.Prompts.Ask == ""},
		{Name: "refine", DisplayName: "Language Detection", Path: settings.Prompts.Refine, IsVirtual: settings.Prompts.Refine == ""},
		{Name: "image", DisplayName: "Describe Image", Path: settings.Prompts.Image, IsVirtual: settings.Prompts.Image == ""},
	}
}

func (a *App) LoadPrompt(name string) (string, error) {
	if a.storePath == "" {
		return "", fmt.Errorf("store not open")
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	return stash.GetPromptContent(name, settings)
}

func (a *App) SavePrompt(name string, content string) (string, error) {
	if a.storePath == "" {
		return "", fmt.Errorf("store not open")
	}
	if err := os.MkdirAll(a.promptsDir(), 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(a.promptsDir(), name+".md")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return "", err
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	switch name {
	case "file":
		settings.Prompts.File = path
	case "explain":
		settings.Prompts.Explain = path
	case "ask":
		settings.Prompts.Ask = path
	case "refine":
		settings.Prompts.Refine = path
	case "image":
		settings.Prompts.Image = path
	}
	if err := settings.Save(a.settingsFilePath()); err != nil {
		return "", err
	}
	logger.Info("prompt saved", "name", name, "path", path)
	runtime.EventsEmit(a.ctx, "prompts:changed")
	return path, nil
}

func (a *App) RestorePrompt(name string) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	var path string
	switch name {
	case "file":
		path = settings.Prompts.File
		settings.Prompts.File = ""
	case "explain":
		path = settings.Prompts.Explain
		settings.Prompts.Explain = ""
	case "ask":
		path = settings.Prompts.Ask
		settings.Prompts.Ask = ""
	case "refine":
		path = settings.Prompts.Refine
		settings.Prompts.Refine = ""
	case "image":
		path = settings.Prompts.Image
		settings.Prompts.Image = ""
	}
	if path != "" {
		_ = os.Remove(path)
	}
	if err := settings.Save(a.settingsFilePath()); err != nil {
		return err
	}
	logger.Info("prompt restored to default", "name", name)
	runtime.EventsEmit(a.ctx, "prompts:changed")
	return nil
}

func (a *App) TogglePrompts() (bool, error) {
	if a.storePath == "" {
		return false, fmt.Errorf("store not open")
	}
	session := stash.LoadSession(a.sessionFilePath())
	session.ShowPrompts = !session.ShowPrompts
	if err := session.Save(a.sessionFilePath()); err != nil {
		return false, err
	}
	return session.ShowPrompts, nil
}

// ── Notes ─────────────────────────────────────────────────────────────────────

func (a *App) GetNotes() []stash.NoteEntry {
	if a.notes == nil {
		logger.Warn("GetNotes: store not open")
		return nil
	}
	entries, err := a.notes.List()
	if err != nil {
		logger.Error("GetNotes failed", "err", err)
		return nil
	}
	logger.Debug("GetNotes", "entries", len(entries))
	return entries
}

func (a *App) SearchStore(query string) []stash.SearchResult {
	if a.notes == nil {
		logger.Warn("SearchStore: store not open")
		return nil
	}
	results, err := a.notes.Search(query)
	if err != nil {
		logger.Error("SearchStore failed", "err", err)
		return nil
	}
	logger.Debug("SearchStore", "query", query, "results", len(results))
	return results
}

// ── Session ───────────────────────────────────────────────────────────────────

func (a *App) GetSession() stash.Session {
	if a.storePath == "" {
		logger.Warn("GetSession: store not open")
		return stash.Session{}
	}

	logger.Info("GetSession", "path", a.sessionFilePath())
	session := stash.LoadSession(a.sessionFilePath())
	logger.Debug("session loaded", "tabs", len(session.Tabs))

	// Prune tabs whose files no longer exist.
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
		b, err := a.buffers.New()
		if err != nil {
			logger.Error("new buffer failed", "err", err)
			return stash.Session{}
		}
		logger.Info("session: no tabs — created default buffer", "path", b.Path(), "uuid", b.UUID())
		session.Tabs = []stash.Tab{{Path: b.Path(), Active: true, Mode: "wysiwyg"}}
		if err := session.Save(a.sessionFilePath()); err != nil {
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
		}
	}

	return session
}

func (a *App) SaveSession(session stash.Session) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	existing := stash.LoadSession(a.sessionFilePath())
	if session.SidebarWidth == 0 {
		session.SidebarWidth = existing.SidebarWidth
	}
	if session.MetaWidth == 0 {
		session.MetaWidth = existing.MetaWidth
	}
	if session.Window == (stash.Window{}) {
		session.Window = existing.Window
	}
	if len(session.OpenFolders) == 0 {
		session.OpenFolders = existing.OpenFolders
	}
	if err := session.Save(a.sessionFilePath()); err != nil {
		logger.Error("SaveSession failed", "err", err)
		return err
	}
	logger.Debug("session saved", "tabs", len(session.Tabs))
	return nil
}

// ── Buffers ───────────────────────────────────────────────────────────────────

func (a *App) NewBuffer() (BufferDTO, error) {
	if a.buffers == nil {
		return BufferDTO{}, fmt.Errorf("store not open")
	}
	b, err := a.buffers.New()
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
func (a *App) LoadBuffer(path string) (BufferDTO, error) {
	if a.buffers == nil {
		return BufferDTO{}, fmt.Errorf("store not open")
	}
	if b, err := a.buffers.Load(path); err == nil {
		logger.Debug("buffer loaded", "path", path)
		return toBufferDTO(b), nil
	}
	n, err := a.notes.Load(path)
	if err != nil {
		logger.Error("LoadBuffer: not found in buffers or notes", "path", path, "err", err)
		return BufferDTO{}, err
	}
	logger.Debug("note loaded via LoadBuffer", "path", path)
	return toNoteBufferDTO(n), nil
}

// SaveBuffer persists the body and writable meta fields from dto. The Store
// bumps the version and modified timestamp automatically. Returns the updated
// DTO with Store-stamped fields reflecting the saved state.
// Routes by dto.Meta.Status: "filed" → NoteService, anything else → BufferService.
func (a *App) SaveBuffer(dto BufferDTO) (BufferDTO, error) {
	if a.buffers == nil {
		return BufferDTO{}, fmt.Errorf("store not open")
	}
	if dto.Meta.Status == "filed" {
		n, err := a.notes.Load(dto.Path)
		if err != nil {
			logger.Error("SaveBuffer(note): load failed", "path", dto.Path, "err", err)
			return BufferDTO{}, err
		}
		n.SetBody([]byte(dto.Body))
		applyDTOToMeta(dto.Meta, n.Meta())
		saved, err := a.notes.Save(n)
		if err != nil {
			logger.Error("SaveBuffer(note): save failed", "path", dto.Path, "err", err)
			return BufferDTO{}, err
		}
		logger.Debug("note saved via SaveBuffer", "path", dto.Path)
		return toNoteBufferDTO(saved), nil
	}
	b, err := a.buffers.Load(dto.Path)
	if err != nil {
		logger.Error("SaveBuffer: load failed", "path", dto.Path, "err", err)
		return BufferDTO{}, err
	}
	b.SetBody([]byte(dto.Body))
	applyDTOToMeta(dto.Meta, b.Meta())
	saved, err := a.buffers.Save(b)
	if err != nil {
		logger.Error("SaveBuffer: save failed", "path", dto.Path, "err", err)
		return BufferDTO{}, err
	}
	logger.Debug("buffer saved", "path", dto.Path)
	return toBufferDTO(saved), nil
}

// RefileNote applies the filing recommendation already persisted in dto's
// metadata to a Library note: saves the updated meta, then renames/moves the
// note within the Library based on the filename and folder fields.
// Used when the user runs "Smart File" on a note that is already filed.
func (a *App) RefileNote(dto BufferDTO) (BufferDTO, error) {
	if a.notes == nil {
		return BufferDTO{}, fmt.Errorf("store not open")
	}
	n, err := a.notes.Load(dto.Path)
	if err != nil {
		return BufferDTO{}, fmt.Errorf("refile: load %s: %w", dto.Path, err)
	}
	n.SetBody([]byte(dto.Body))
	applyDTOToMeta(dto.Meta, n.Meta())
	// Save updated metadata first so Refile derives the correct name.
	saved, err := a.notes.Save(n)
	if err != nil {
		return BufferDTO{}, fmt.Errorf("refile: save %s: %w", dto.Path, err)
	}
	refiled, err := a.notes.Refile(saved)
	if err != nil {
		return BufferDTO{}, fmt.Errorf("refile: rename %s: %w", dto.Path, err)
	}
	logger.Info("note refiled", "from", dto.Path, "to", refiled.Path())
	return toNoteBufferDTO(refiled), nil
}

// DiscardBuffer deletes a buffer and its version history.
func (a *App) DiscardBuffer(path string) error {
	if a.buffers == nil {
		return fmt.Errorf("store not open")
	}
	b, err := a.buffers.Load(path)
	if err != nil {
		logger.Error("DiscardBuffer: load failed", "path", path, "err", err)
		return err
	}
	if err := a.buffers.Discard(b); err != nil {
		logger.Error("DiscardBuffer failed", "path", path, "err", err)
		return err
	}
	logger.Info("buffer discarded", "path", path)
	return nil
}

// FileBuffer promotes a buffer to the Library using the AI-derived name and
// folder. Returns the resulting NoteDTO.
func (a *App) FileBuffer(path string) (NoteDTO, error) {
	if a.buffers == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	b, err := a.buffers.Load(path)
	if err != nil {
		logger.Error("FileBuffer: load failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	n, err := a.buffers.File(b)
	if err != nil {
		logger.Error("FileBuffer failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	logger.Info("buffer filed", "from", path, "to", n.Path())
	return toNoteDTO(n), nil
}

// FileBufferWithName is like FileBuffer but overrides the filename.
func (a *App) FileBufferWithName(path, name string) (NoteDTO, error) {
	if a.buffers == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	b, err := a.buffers.Load(path)
	if err != nil {
		logger.Error("FileBufferWithName: load failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	n, err := a.buffers.FileWithName(b, name)
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
	if a.buffers == nil {
		return VersionedStorableDTO{}, fmt.Errorf("store not open")
	}
	vref := fromVersionRefDTO(ref)

	// Try as Buffer first, then as Note.
	if b, err := a.buffers.Load(path); err == nil {
		v, err := a.buffers.RetrieveVersion(b, vref)
		if err != nil {
			return VersionedStorableDTO{}, fmt.Errorf("retrieve version: %w", err)
		}
		return toVersionedStorableDTO(v), nil
	}
	if n, err := a.notes.Load(path); err == nil {
		v, err := a.notes.RetrieveVersion(n, vref)
		if err != nil {
			return VersionedStorableDTO{}, fmt.Errorf("retrieve version: %w", err)
		}
		return toVersionedStorableDTO(v), nil
	}
	return VersionedStorableDTO{}, fmt.Errorf("document not found: %s", path)
}

// ── Notes ─────────────────────────────────────────────────────────────────────

func (a *App) DeleteNote(path string) error {
	if a.notes == nil {
		return fmt.Errorf("store not open")
	}
	n, err := a.notes.Load(path)
	if err != nil {
		logger.Error("DeleteNote: load failed", "path", path, "err", err)
		return err
	}
	if err := a.notes.Delete(n); err != nil {
		logger.Error("DeleteNote failed", "path", path, "err", err)
		return err
	}
	logger.Info("note deleted", "path", path)
	return nil
}

// MoveNote moves a note to a different folder within the Library.
// targetFolder is a store-relative folder path (e.g. "ai-stuff") or empty
// to move to the Library root.
func (a *App) MoveNote(path, targetFolder string) (NoteDTO, error) {
	if a.notes == nil {
		return NoteDTO{}, fmt.Errorf("store not open")
	}
	n, err := a.notes.Load(path)
	if err != nil {
		logger.Error("MoveNote: load failed", "path", path, "err", err)
		return NoteDTO{}, err
	}
	moved, err := a.notes.Move(n, targetFolder)
	if err != nil {
		logger.Error("MoveNote failed", "path", path, "target", targetFolder, "err", err)
		return NoteDTO{}, err
	}
	logger.Info("note moved", "from", path, "to", moved.Path())
	return toNoteDTO(moved), nil
}

// ── Folders ───────────────────────────────────────────────────────────────────
//
// Folder ops use direct file operations — the Store interface does not yet have
// explicit CreateFolder support (folders are created implicitly by file ops).

func (a *App) CreateFolder(path string) error {
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	resolved := a.resolvePath(path)
	if err := os.MkdirAll(resolved, 0o755); err != nil {
		logger.Error("CreateFolder failed", "path", path, "err", err)
		return err
	}
	logger.Info("folder created", "path", path)
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
	if a.storePath == "" {
		return fmt.Errorf("store not open")
	}
	oldResolved := a.resolvePath(oldPath)
	newResolved := a.resolvePath(newPath)
	if err := os.Rename(oldResolved, newResolved); err != nil {
		logger.Error("RenameFolder failed", "from", oldPath, "to", newPath, "err", err)
		return err
	}
	return nil
}

// ── Assets ────────────────────────────────────────────────────────────────────

// SaveAsset stores a base64-encoded image and returns an AssetDTO whose
// ExternalRef can be inserted directly into markdown.
// context is the store-relative path of the owning document (or "" for a buffer paste).
func (a *App) SaveAsset(context, id, dataBase64 string) (AssetDTO, error) {
	if a.assets == nil {
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
	cat, key := assetLocation(context, id)
	asset, err := a.assets.Save(cat, key, data)
	if err != nil {
		logger.Error("SaveAsset failed", "key", key, "err", err)
		return AssetDTO{}, err
	}
	logger.Info("asset saved", "externalRef", asset.ExternalRef())
	return toAssetDTO(asset), nil
}

// DownloadAsset fetches an image from a URL and stores it as an asset.
// context is the store-relative path of the owning document (or "" for buffer paste).
func (a *App) DownloadAsset(context, targetURL, id string) (AssetDTO, error) {
	if a.assets == nil {
		return AssetDTO{}, fmt.Errorf("store not open")
	}
	data, err := downloadURL(targetURL)
	if err != nil {
		logger.Error("DownloadAsset: fetch failed", "url", targetURL, "err", err)
		return AssetDTO{}, err
	}
	cat, key := assetLocation(context, id)
	asset, err := a.assets.Save(cat, key, data)
	if err != nil {
		logger.Error("DownloadAsset: save failed", "key", key, "err", err)
		return AssetDTO{}, err
	}
	logger.Info("asset downloaded", "url", targetURL, "externalRef", asset.ExternalRef())
	return toAssetDTO(asset), nil
}

// assetLocation determines the Store category and key for an asset based on
// whether the owning document is a buffer (WorkingCopy) or a note (Library).
func assetLocation(context, id string) (store.Category, string) {
	isBuffer := context == "" || context == "new" || strings.Contains(context, "/buffers/")
	if isBuffer {
		return store.WorkingCopy, fmt.Sprintf("assets/%s.png", id)
	}
	noteName := strings.TrimSuffix(filepath.Base(context), filepath.Ext(context))
	return store.Library, fmt.Sprintf(".assets/%s-%s.png", noteName, id)
}

// ── AI / CLI operations ───────────────────────────────────────────────────────
//
// These still delegate to *stash.Store methods which are thin wrappers over
// standalone functions. They will be refactored to standalone calls in a
// future cleanup once the *Store dependency is fully removed.

func (a *App) EvaluateBuffer(path string) (*stash.FilingRecommendation, error) {
	if a.stash == nil {
		return nil, fmt.Errorf("store not open")
	}
	resolved := a.resolvePath(path)
	currentSettings := stash.LoadSettings(a.settingsFilePath())
	rec, err := a.stash.EvaluateBuffer(resolved, currentSettings)
	if err != nil {
		logger.Warn("EvaluateBuffer failed", "path", path, "err", err)
		return nil, err
	}
	logger.Info("EvaluateBuffer success", "path", path)
	return rec, nil
}

func (a *App) RefineLanguage(content string) (string, error) {
	if a.stash == nil {
		return "", fmt.Errorf("store not open")
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	if settings.Tier() == stash.TierDumb {
		return "", fmt.Errorf("dumb mode")
	}
	lang, err := stash.RefineLanguage(content, settings)
	if err != nil {
		logger.Warn("RefineLanguage failed", "err", err)
		return "", err
	}
	return lang, nil
}

func (a *App) DescribeImage(storeRelPath string) (stash.ImageDesc, error) {
	if a.stash == nil {
		return stash.ImageDesc{}, fmt.Errorf("store not open")
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	if settings.Tier() == stash.TierDumb {
		return stash.ImageDesc{}, fmt.Errorf("dumb mode")
	}
	absPath := filepath.Join(a.storePath, storeRelPath)
	desc, err := stash.DescribeImage(absPath, settings)
	if err != nil {
		logger.Warn("DescribeImage failed", "err", err)
		return stash.ImageDesc{}, err
	}
	return desc, nil
}

func (a *App) Explain(content string, history string, notePath string, imageStorePaths []string) (string, error) {
	if a.stash == nil {
		return "", fmt.Errorf("store not open")
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	if settings.Tier() == stash.TierDumb {
		return "", fmt.Errorf("explain not available in dumb mode")
	}
	cwd := filepath.Dir(a.resolvePath(notePath))
	var absImages []string
	for _, p := range imageStorePaths {
		absImages = append(absImages, filepath.Join(a.storePath, p))
	}
	resp, err := a.stash.RunExplain(content, history, settings, cwd, absImages)
	if err != nil {
		logger.Warn("Explain failed", "err", err)
		return "", err
	}
	return resp, nil
}

func (a *App) Ask(content string, history string, question string, notePath string, imageStorePaths []string) (string, error) {
	if a.stash == nil {
		return "", fmt.Errorf("store not open")
	}
	settings := stash.LoadSettings(a.settingsFilePath())
	if settings.Tier() == stash.TierDumb {
		return "", fmt.Errorf("ask not available in dumb mode")
	}
	cwd := filepath.Dir(a.resolvePath(notePath))
	var absImages []string
	for _, p := range imageStorePaths {
		absImages = append(absImages, filepath.Join(a.storePath, p))
	}
	resp, err := a.stash.RunAsk(content, history, question, settings, cwd, absImages)
	if err != nil {
		logger.Warn("Ask failed", "err", err)
		return "", err
	}
	return resp, nil
}

// ── File manager ──────────────────────────────────────────────────────────────

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
	var oldSettings stash.Settings
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
		var newSettings stash.Settings
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
