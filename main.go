package main

import (
	"bytes"
	"crypto/tls"
	"embed"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"time"

	"sieve/logger"
	"sieve/sieve"

	"github.com/wailsapp/wails/v3/pkg/application"
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
// everything else falls through to the embedded assets via Wails.
type muxHandler struct {
	app   *App
	store *storeHandler
	api   *apiHandler
}

func (m *muxHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fmt.Printf("[sieve] request: %s %s\n", r.Method, r.URL.Path)

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

	fmt.Printf("[sieve:proxy] fetching: %s\n", targetURL)

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 30 * time.Second,
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		fmt.Printf("[sieve:proxy] request creation failed: %v\n", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[sieve:proxy] fetch failed: %v\n", err)
		http.Error(w, fmt.Sprintf("failed to fetch url: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	fmt.Printf("[sieve:proxy] status: %d, type: %s\n", resp.StatusCode, resp.Header.Get("Content-Type"))

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

func buildMenu(wailsApp *application.App) *application.Menu {
	isMac := goruntime.GOOS == "darwin"

	js := func(script string) func(*application.Context) {
		logger.Info("Executing JS1")
		return func(_ *application.Context) {
			logger.Info("Executing JS2")
			if wailsApp.Window.Current() != nil {
				logger.Info("Executing JS3")
				wailsApp.Window.Current().ExecJS(script)
			}
		}
	}

	openSettings := js("htmx.ajax('GET','/api/settings',{target:'#settings-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('settings-dialog').showModal()})")

	appMenu := wailsApp.NewMenu()

	if isMac {
		appMenu.AddRole(application.AppMenu)
	}

	// modKey := "Ctrl"
	// if isMac {
	// 	modKey = "Cmd"
	// }

	// appMenu.AddRole(application.FileMenu)

	file := appMenu.AddSubmenu("File")

	// fileMenu.FindByRole(application.NewFile).OnClick(func(ctx *application.Context) { logger.Info("New") })
	appMenu.AddRole(application.EditMenu)

	newNote := file.Add("New Note")
	newNote.SetRole(application.NewFile)
	newNote.SetAccelerator("CmdOrCtrl+n")
	newNote.SetEnabled(true)
	newNote.OnClick(func(ctx *application.Context) {
		logger.Info("CLICKED NEW NOTE")
	})
	file.Add("Save").SetAccelerator("CmdOrCtrl+s").OnClick(js("document.dispatchEvent(new CustomEvent('sieve:save'))"))
	file.Add("Close Tab").SetAccelerator("CmdOrCtrl+w").OnClick(js("var id=document.getElementById('tiptap-mount')?.getAttribute('data-uuid');if(id)htmx.ajax('POST','/api/tabs/close/'+id,{target:'#htmx-tabbar',swap:'innerHTML'})"))
	file.AddSeparator()
	settingsLabel := "Settings"
	if isMac {
		settingsLabel = "Preferences"
	}
	file.Add(settingsLabel).SetAccelerator("CmdOrCtrl+,").OnClick(openSettings)
	if !isMac {
		file.AddSeparator()
		file.AddRole(application.Quit)
	}

	// if isMac {
	// 	appMenu.AddRole(application.EditMenu)
	// }

	// view := appMenu.AddSubmenu("View")
	// view.Add("Toggle Sidebar").SetAccelerator(modKey + "+\\").OnClick(js("htmx.ajax('POST','/api/session/sidebar/toggle',{swap:'none'})"))
	// view.Add("Toggle Meta Panel").SetAccelerator(modKey + "+Shift+i").OnClick(js("htmx.ajax('POST','/api/session/meta/toggle',{swap:'none'})"))
	// view.Add("Toggle Prompts").SetAccelerator(modKey + "+Shift+p").OnClick(js("htmx.ajax('POST','/api/session/prompts/toggle',{swap:'none'})"))
	// view.Add("Toggle Editor Mode").SetAccelerator(modKey + "+Shift+m").OnClick(js("document.dispatchEvent(new CustomEvent('sieve:toggle-mode'))"))
	// view.AddSeparator()
	// view.Add("Toggle Search").SetAccelerator(modKey + "+f").OnClick(js("document.dispatchEvent(new CustomEvent('sieve:toggle-search'))"))
	// view.Add("Sidebar Search").SetAccelerator(modKey + "+Shift+f").OnClick(js("window.sieveSidebarSearch?.()"))
	// view.Add("Toggle AI Blocks").SetAccelerator(modKey + "+j").OnClick(js("document.dispatchEvent(new CustomEvent('sieve:toggle-ai-blocks'))"))
	// view.Add("Quick Switcher").SetAccelerator(modKey + "+p").OnClick(js("htmx.ajax('GET','/api/search-prompt',{target:'#quickswitcher-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('quickswitcher-dialog').showModal()})"))

	tools := appMenu.AddSubmenu("Tools")
	tools.Add("Smart File").SetAccelerator("CmdOrCtrl+Shift+e").OnClick(js("window.SieveAI?.smartFile()"))
	tools.Add("Keep & Smart File").SetAccelerator("CmdOrCtrl+Shift+Return").OnClick(js("window.SieveAI?.keepAndSmartFile()"))

	// appMenu.AddRole(application.WindowMenu)

	appMenu.AddRole(application.WindowMenu)
	appMenu.AddRole(application.HelpMenu)

	// help := appMenu.AddSubmenu("Help")
	// help.Add("Shortcuts").SetAccelerator(modKey + "+/").OnClick(js("htmx.ajax('GET','/api/help',{target:'#help-dialog-content',swap:'innerHTML'}).then(function(){document.getElementById('help-dialog').showModal()})"))
	// if !isMac {
	// 	help.Add("About").OnClick(func(_ *application.Context) {
	// 		wailsApp.Dialog.Info().
	// 			SetTitle("About Sieve").
	// 			SetMessage("Sieve v1.0").
	// 			Show()
	// 	})
	// }

	wailsApp.Menu.Set(appMenu)
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
	appInstance := NewApp(storePath, themes, hub, serviceProvider)
	api, err := newAPIHandler(appInstance, hub, serviceProvider)
	if err != nil {
		log.Fatalf("failed to init API handler: %v", err)
	}

	mux := &muxHandler{
		app:   appInstance,
		store: &storeHandler{app: appInstance},
		api:   api,
	}

	// Standalone HTTP server so dev proxy can reach API/SSE/static routes.
	devPort := os.Getenv("SIEVE_DEV_PORT")
	if devPort == "" {
		devPort = "0"
	}
	go func() {
		if err := http.ListenAndServe("127.0.0.1:"+devPort, mux); err != nil {
			log.Printf("dev HTTP server: %v", err)
		}
	}()

	wailsApp := application.New(application.Options{
		Name:        "Sieve",
		Description: "Scratchpad-first thinking tool",
		Icon:        icon,
		Services: []application.Service{
			application.NewService(appInstance),
		},
		Assets: application.AssetOptions{
			Handler: mux,
		},
		Linux: application.LinuxOptions{
			ProgramName:                   "Sieve",
			DisableQuitOnLastWindowClosed: false,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "sieve-app-6f3a2b1c",
		},
		ShouldQuit: func() bool {
			return appInstance.shouldQuit()
		},
	})

	menu := buildMenu(wailsApp)

	window := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:              "Sieve",
		Width:              1200,
		Height:             800,
		MinWidth:           800,
		MinHeight:          500,
		BackgroundColour:   application.NewRGBA(26, 27, 38, 255),
		UseApplicationMenu: true,
		URL:                "/",
		Linux: application.LinuxWindow{
			Menu: menu,
		},
		Mac: application.MacWindow{
			Backdrop: application.MacBackdropNormal,
			TitleBar: application.MacTitleBar{
				AppearsTransparent:   false,
				Hide:                 false,
				HideToolbarSeparator: true,
			},
		},
	})
	appInstance.SetApp(wailsApp, window)

	if err := wailsApp.Run(); err != nil {
		println("Error:", err.Error())
	}
}
