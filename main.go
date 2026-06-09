package main

import (
	"bytes"
	"crypto/tls"
	"embed"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/src
var assets embed.FS

//go:embed themes/*.json
var themes embed.FS

//go:embed build/appicon.png
var icon []byte

type storeHandler struct{ app *App }

func (h *storeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const prefix = "/sieve/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}

	root := h.app.GetStorePath()
	if root == "" {
		http.Error(w, "store not initialized", http.StatusServiceUnavailable)
		return
	}
	abs, _ := filepath.Abs(root)

	rel := filepath.FromSlash(strings.TrimPrefix(r.URL.Path, prefix))
	filePath := filepath.Join(abs, filepath.Clean(rel))

	logger.Info("About to Serve path", "path", filePath)
	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	contentType := http.DetectContentType(data)
	if strings.HasPrefix(contentType, "text/xml") || strings.HasPrefix(contentType, "text/plain") {
		if bytes.Contains(data, []byte("<svg")) {
			contentType = "image/svg+xml"
		}
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// muxHandler routes requests: proxy and theme.css are intercepted first, then
// API/SSE/static go to apiHandler, store files go to storeHandler, and
// everything else falls through to the embedded React assets via Wails.
type muxHandler struct {
	app   *App
	store *storeHandler
	api   *apiHandler
}

func (m *muxHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	logger.Debug("request", "method", r.Method, "path", r.URL.Path)

	if strings.Contains(r.URL.Path, "/sieve-image-proxy") {
		m.serveProxy(w, r)
		return
	}
	if r.URL.Path == "/theme.css" {
		m.serveThemeCSS(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") ||
		r.URL.Path == "/sse" ||
		strings.HasPrefix(r.URL.Path, "/static/") {
		m.api.ServeHTTP(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/sieve/") {
		m.api.ServeHTTP(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/stash/") {
		// Rewrite /stash/ to /sieve/ essentially
		r.URL.Path = strings.Replace(r.URL.Path, "/stash/", "/sieve/", 1)
		m.store.ServeHTTP(w, r)
		return
	}

	// Try serving from store root as a fallback for relative markdown images
	storeRoot := m.app.GetStorePath()
	if storeRoot != "" {
		abs, _ := filepath.Abs(storeRoot)
		rel := filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/"))
		filePath := filepath.Join(abs, filepath.Clean(rel))

		if strings.HasPrefix(filePath+string(filepath.Separator), abs+string(filepath.Separator)) {
			if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
				data, err := os.ReadFile(filePath)
				if err == nil {
					contentType := http.DetectContentType(data)
					if strings.HasPrefix(contentType, "text/xml") || strings.HasPrefix(contentType, "text/plain") {
						if bytes.Contains(data, []byte("<svg")) {
							contentType = "image/svg+xml"
						}
					}
					w.Header().Set("Content-Type", contentType)
					w.WriteHeader(http.StatusOK)
					_, _ = w.Write(data)
					return
				}
			}
		}
	}

	// Fallback to apiHandler (serves index.html via NotFound)
	m.api.ServeHTTP(w, r)
}

func (m *muxHandler) serveProxy(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		http.Error(w, "missing url parameter", http.StatusBadRequest)
		return
	}

	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	logger.Debug("proxy: fetching", "url", targetURL)

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 30 * time.Second,
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		logger.Warn("proxy: request creation failed", "err", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		logger.Warn("proxy: fetch failed", "err", err)
		http.Error(w, fmt.Sprintf("failed to fetch url: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	logger.Debug("proxy: response", "status", resp.StatusCode, "content_type", resp.Header.Get("Content-Type"))

	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if ce := resp.Header.Get("Content-Encoding"); ce != "" {
		w.Header().Set("Content-Encoding", ce)
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000")

	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (m *muxHandler) serveThemeCSS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")

	themeName := "tokyo-night"
	var themeOverride []byte

	if m.app.ServiceProvider.State != nil {
		settings := m.app.ServiceProvider.State.LoadSettings()
		themeName = settings.Theme
		themeOverride = m.app.loadThemeOverride(themeName)
	}

	vars := sieve.LoadTheme(themeName, themeOverride, m.app.GetThemesFS())

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("html:root {\n"))
	for k, v := range vars {
		fmt.Fprintf(w, "  --theme-%s: %s;\n", k, v)
	}
	w.Write([]byte("}\n"))
}

func buildMenu(app *App) *menu.Menu {
	js := func(script string) func(*menu.CallbackData) {
		return func(_ *menu.CallbackData) {
			logger.Debug("Menu Action: executing JS", "script", script)
			wailsruntime.WindowExecJS(app.ctx, script)
		}
	}

	isMac := goruntime.GOOS == "darwin"
	openSettings := js("htmx.ajax('GET','/api/settings',{target:'#settings-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('settings-dialog').showModal()})")

	appMenu := menu.NewMenu()

	if isMac {
		// macOS: AppMenu role provides "Sieve > About, Services, Hide, Quit"
		// EditMenu role provides a proper "Edit" menu with Cut/Copy/Paste/Undo
		appMenu.Append(menu.AppMenu())
	}

	file := appMenu.AddSubmenu("File")
	file.AddText("New Note", keys.CmdOrCtrl("n"), js("htmx.ajax('POST','/api/note/new',{target:'#htmx-tabbar',swap:'innerHTML'})"))
	file.AddText("Save", keys.CmdOrCtrl("s"), js("document.dispatchEvent(new CustomEvent('sieve:save'))"))
	file.AddText("Close Tab", keys.CmdOrCtrl("w"), js("var id=document.getElementById('tiptap-mount')?.getAttribute('data-uuid');if(id)htmx.ajax('POST','/api/tabs/close/'+id,{target:'#htmx-tabbar',swap:'innerHTML'})"))
	file.AddSeparator()
	file.AddText("Open Library…", keys.Combo("o", keys.CmdOrCtrlKey, keys.ShiftKey),
		js("window.sieveSelectLibrary()"))
	recentMenu := file.AddSubmenu("Open Recent")
	cfg := LoadGlobalConfig()
	for _, entry := range cfg.RecentLibraries {
		entryPath := entry.Path
		entryName := entry.Name
		recentMenu.AddText(entryName, nil, func(_ *menu.CallbackData) {
			wailsruntime.WindowExecJS(app.ctx, fmt.Sprintf(`window.sieveSwitchLibrary(%q)`, entryPath))
		})
	}
	if len(cfg.RecentLibraries) > 0 {
		recentMenu.AddSeparator()
	}
	recentMenu.AddText("Open Other Library…", nil, js("window.sieveSelectLibrary()"))
	file.AddText("Create New Library…", nil,
		js("window.go.main.App.CreateVault().then(function(p){ if(p) location.reload() })"))
	//this shuld be Preferences in App menu
	file.AddSeparator()
	settingsLabel := "Settings"
	if isMac {
		settingsLabel = "Preferences"
	}
	file.AddText(settingsLabel, keys.CmdOrCtrl(","), openSettings)	
	file.AddSeparator()
	if !isMac {
		// On macOS: Settings lives in Sieve > Preferences (injected by AppMenu role),
		file.AddText("Quit", keys.CmdOrCtrl("q"), func(_ *menu.CallbackData) {
			wailsruntime.Quit(app.ctx)
		})
	}

	if isMac {
		appMenu.Append(menu.EditMenu())
	}

	view := appMenu.AddSubmenu("View")
	view.AddText("Toggle Sidebar", keys.CmdOrCtrl("\\"), js("htmx.ajax('POST','/api/session/sidebar/toggle',{swap:'none'})"))
	view.AddText("Toggle Meta Panel", keys.Combo("i", keys.CmdOrCtrlKey, keys.ShiftKey), js("htmx.ajax('POST','/api/session/meta/toggle',{swap:'none'})"))
	view.AddText("Toggle Prompts", keys.Combo("p", keys.CmdOrCtrlKey, keys.ShiftKey), js("htmx.ajax('POST','/api/session/prompts/toggle',{swap:'none'})"))
	view.AddText("Toggle Editor Mode", keys.Combo("m", keys.CmdOrCtrlKey, keys.ShiftKey), js("document.dispatchEvent(new CustomEvent('sieve:toggle-mode'))"))
	view.AddSeparator()
	view.AddText("Toggle Search", keys.CmdOrCtrl("f"), js("document.dispatchEvent(new CustomEvent('sieve:toggle-search'))"))
	view.AddText("Sidebar Search", keys.Combo("f", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.sieveSidebarSearch?.()"))
	view.AddText("Toggle AI Blocks", keys.CmdOrCtrl("j"), js("document.dispatchEvent(new CustomEvent('sieve:toggle-ai-blocks'))"))
	view.AddText("Quick Switcher", keys.CmdOrCtrl("p"), js("htmx.ajax('GET','/api/search-prompt',{target:'#quickswitcher-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('quickswitcher-dialog').showModal()})"))

	tools := appMenu.AddSubmenu("Tools")
	tools.AddText("Smart File", keys.Combo("e", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.SieveAI?.smartFile()"))
	tools.AddText("Keep & Smart File", keys.Combo("return", keys.CmdOrCtrlKey, keys.ShiftKey), js("window.SieveAI?.keepAndSmartFile()"))

	help := appMenu.AddSubmenu("Help")
	help.AddText("Shortcuts", keys.CmdOrCtrl("/"), js("htmx.ajax('GET','/api/help',{target:'#help-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('help-dialog').showModal()})"))
	if !isMac {
		// On Linux/Windows: About belongs in Help
		help.AddText("About", nil, func(_ *menu.CallbackData) {
			wailsruntime.MessageDialog(app.ctx, wailsruntime.MessageDialogOptions{
				Type:    wailsruntime.InfoDialog,
				Title:   "About Sieve",
				Message: "Sieve v1.0",
			})
		})
	}

	return appMenu
}

func main() {
	cliArg := ""
	if len(os.Args) > 1 {
		cliArg = os.Args[1]
	}
	storePath := FindBestStorePath(cliArg, os.Getenv("SIEVE_STORE"))

	hub := newSSEHub()
	serviceProvider := &sieve.ServiceProvider{}
	app := NewApp(storePath, themes, hub, serviceProvider)
	api, err := newAPIHandler(app, hub, serviceProvider)
	if err != nil {
		logger.Error("failed to init API handler", "err", err)
		os.Exit(1)
	}

	// Standalone HTTP server so Vite dev proxy can reach API/SSE/static routes.
	// In production the AssetServer.Handler covers these; this is a no-op there.
	devPort := os.Getenv("SIEVE_DEV_PORT")
	if devPort == "" {
		devPort = "0"
	}
	ln, err := net.Listen("tcp", "127.0.0.1:"+devPort)
	if err != nil {
		logger.Warn("failed to start dev HTTP listener", "err", err)
	} else {
		app.DevServerPort = ln.Addr().(*net.TCPAddr).Port
		logger.Info("Dev HTTP server listening", "addr", ln.Addr().String(), "port", app.DevServerPort)
		go func() {
			mux := &muxHandler{app: app, store: &storeHandler{app: app}, api: api}
			if err := http.Serve(ln, mux); err != nil && err != http.ErrServerClosed {
				logger.Error("dev HTTP server error", "err", err)
			}
		}()
	}

	err = wails.Run(&options.App{
		Title:                    "Sieve",
		Menu:                     buildMenu(app),
		Width:                    1200,
		Height:                   800,
		MinWidth:                 800,
		MinHeight:                500,
		EnableDefaultContextMenu: true,
		BackgroundColour:         &options.RGBA{R: 26, G: 27, B: 38, A: 1},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "sieve-app-6f3a2b1c",
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				// bring existing window to front
			},
		},
		AssetServer: &assetserver.Options{
			Assets: assets,
			Handler: &muxHandler{
				app:   app,
				store: &storeHandler{app: app},
				api:   api,
			},
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/" || r.URL.Path == "/index.html" {
						m := &muxHandler{app: app, store: &storeHandler{app: app}, api: api}
						m.ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind: []interface{}{
			app,
		},

		Linux: &linux.Options{
			Icon:                icon,
			WindowIsTranslucent: false,
			WebviewGpuPolicy:    linux.WebviewGpuPolicyAlways,
			ProgramName:         "Sieve",
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: false,
				HideTitle:                  false,
				HideTitleBar:               false,
				FullSizeContent:            false,
				UseToolbar:                 false,
				HideToolbarSeparator:       true,
			},
			Appearance:           mac.NSAppearanceNameDarkAqua,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  false,
			ContentProtection:    false,
			About: &mac.AboutInfo{
				Title:   "Sieve",
				Message: "© 2026 SQ",
				Icon:    icon,
			},
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
