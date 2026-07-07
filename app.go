package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sse"
	"sieve/watcher"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the Wails application backend — a thin native shell. It owns the Wails
// context, native dialogs, the window lifecycle, the OS file manager, and the
// notes watcher. All library/store lifecycle (open/switch/init, path layout,
// state wiring, event broadcasting) is delegated to sieve.FileLibraryService,
// which implements services.LibraryService; App holds the concrete type so it
// can reach the file-backend path accessors that are kept off the interface.
type App struct {
	ctx context.Context

	ServiceProvider *sieve.ServiceProvider
	library         *sieve.FileLibraryService

	hub     *sse.Hub
	watcher *watcher.NotesWatcher
	closing bool

	DevServerPort int
}

func NewApp(hub *sse.Hub, serviceProvider *sieve.ServiceProvider, library *sieve.FileLibraryService) *App {
	a := &App{
		hub:             hub,
		ServiceProvider: serviceProvider,
		library:         library,
	}
	// App-scoped side effects after a successful library open: re-arm the notes
	// watcher and restore window geometry. These stay in the native shell.
	library.OnOpened(a.afterOpen)
	return a
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// startup is the Wails OnStartup callback. It captures the context, then hands
// off to the library lifecycle. isFirstStartup is true only on this cold-start
// call (a.ctx nil), enabling the recents/cwd fallback inside Open.
func (a *App) startup(ctx context.Context) {
	isFirstStartup := a.ctx == nil
	a.ctx = ctx
	if _, err := a.library.Open(a.library.StorePath(), isFirstStartup); err != nil {
		logger.Error("startup: library open failed", "err", err)
	}
}

// afterOpen runs (via the lifecycle's OnOpened hook) after every successful
// Open. It restores window geometry and (re-)arms the notes watcher — concerns
// that belong to the native shell, not the library service.
func (a *App) afterOpen() {
	// Restore window geometry.
	if a.ctx != nil && a.ServiceProvider.State != nil {
		savedSession := a.ServiceProvider.State.LoadSession()
		if savedSession.Window.Width >= 800 && savedSession.Window.Height >= 500 {
			runtime.WindowSetSize(a.ctx, savedSession.Window.Width, savedSession.Window.Height)
			logger.Debug("window size restored", "w", savedSession.Window.Width, "h", savedSession.Window.Height)
		}
		win := savedSession.Window
		if win.X > -4000 && win.Y > -4000 {
			runtime.WindowSetPosition(a.ctx, win.X, win.Y)
			logger.Debug("window position restored", "x", win.X, "y", win.Y)
		}
	}

	// File-system watcher for notes: close any previous one, then arm a new one
	// pointing at the newly-opened library's notes directory.
	if a.watcher != nil {
		a.watcher.Close()
		a.watcher = nil
	}
	w, err := watcher.New(a.library.NotesDir(), func() {
		logger.Debug("notes changed — emitting event")
		runtime.EventsEmit(a.ctx, "notes:changed")
		if a.hub != nil {
			a.hub.Broadcast("notes:changed", "{}")
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
	if a.ServiceProvider.State != nil {
		x, y := runtime.WindowGetPosition(ctx)
		w, h := runtime.WindowGetSize(ctx)
		session := a.ServiceProvider.State.LoadSession()
		session.Window = domain.Window{X: x, Y: y, Width: w, Height: h}
		_ = a.ServiceProvider.State.SaveSession(session)
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

// getStoreInfo is a thin delegator so handlers can reach the live store info.
func (a *App) getStoreInfo() sieve.StoreInfo { return a.library.StoreInfo() }

// ── Bootstrapping (native dialogs → library lifecycle) ─────────────────────────

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

	logger.Debug("SelectVault: opening library", "path", path)
	result, _ := a.library.Open(path, false)

	logger.Debug("SelectVault: open completed", "resulting_storePath", result)
	if result == "" {
		logger.Warn("SelectVault: open rejected the folder")
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

	logger.Debug("CreateVault: opening library", "path", path)
	result, _ := a.library.Open(path, false)

	logger.Debug("CreateVault: open completed", "resulting_storePath", result)
	if result == "" {
		logger.Warn("CreateVault: open rejected the folder")
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

// SwitchLibrary switches to an existing library at path without opening a file
// dialog. Used by the File > Open Recent submenu. The lifecycle owns validation,
// editor teardown, and re-wiring; App keeps only the native menu refresh.
func (a *App) SwitchLibrary(path string) (string, error) {
	if a.ctx == nil {
		return "", fmt.Errorf("app context not initialized")
	}
	if _, err := a.library.Switch(path); err != nil {
		return "", err
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
	return a.library.InitAt(path)
}

// ── File manager ──────────────────────────────────────────────────────────────

// ShowInFilesByID reveals a document or folder in the OS file manager.
// id is a UUID (note/buffer), an opaque folder ID (ExternalRef), or "prompt:name".
func (a *App) ShowInFilesByID(id string) error {
	if strings.HasPrefix(id, "prompt:") {
		return a.showInFiles(a.library.PromptsDir())
	}
	if a.ServiceProvider.Documents != nil {
		if doc, err := a.ServiceProvider.Documents.LoadByUUID(id); err == nil {
			return a.showInFiles(doc.Storable().ExternalRef())
		}
	}
	// Folder: id is an ExternalRef (e.g. "store/my-folder") — ResolvePath handles it.
	return a.showInFiles(id)
}

func (a *App) showInFiles(path string) error {
	resolved := a.library.ResolvePath(path)
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
