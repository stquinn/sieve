package main

import (
	"crypto/tls"
	"embed"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"stash/stash"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed themes/*.json
var themes embed.FS

type storeHandler struct{ app *App }

func (h *storeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const prefix = "/store/"
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

	// Ensure we're still inside the store root
	if !strings.HasPrefix(filePath+string(filepath.Separator), abs+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filePath)
}

// muxHandler sits in front of storeHandler and intercepts /theme.css so that
// the Go backend can serve the active theme as a proper stylesheet before the
// browser renders a single pixel — no JS injection required.
type muxHandler struct {
	app   *App
	stash *storeHandler
}

func (m *muxHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fmt.Printf("[stash] request: %s %s (URI: %s)\n", r.Method, r.URL.Path, r.RequestURI)
	
	// Intercept proxy requests early.
	if strings.Contains(r.URL.Path, "/stash-image-proxy") {
		m.serveProxy(w, r)
		return
	}

	if r.URL.Path == "/theme.css" {
		m.serveThemeCSS(w, r)
		return
	}
	m.stash.ServeHTTP(w, r)
}

func (m *muxHandler) serveProxy(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		http.Error(w, "missing url parameter", http.StatusBadRequest)
		return
	}

	// Always allow CORS for the proxy itself
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	fmt.Printf("[stash:proxy] fetching: %s\n", targetURL)

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
		},
		Timeout: 30 * time.Second,
	}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		fmt.Printf("[stash:proxy] request creation failed: %v\n", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Use a standard browser User-Agent to avoid being blocked as a bot
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := client.Do(req)
	if err != nil {
		fmt.Printf("[stash:proxy] fetch failed: %v\n", err)
		http.Error(w, fmt.Sprintf("failed to fetch url: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	fmt.Printf("[stash:proxy] status: %d, type: %s\n", resp.StatusCode, resp.Header.Get("Content-Type"))

	// Forward selective response headers — don't blindly forward everything (e.g. security/CORS headers from target)
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

	var settings stash.Settings
	var storeRoot string

	if m.app.GetStorePath() != "" {
		storeRoot = m.app.GetStorePath()
		settings = stash.LoadSettings(m.app.SettingsPath())
	} else {
		// Fallback: show the default theme (Sublime) for the splash screen
		settings = stash.LoadSettings("") // load defaults
		storeRoot = ""
	}

	vars := stash.LoadTheme(storeRoot, settings.Theme, m.app.GetThemesFS())

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("html:root {\n"))
	for k, v := range vars {
		fmt.Fprintf(w, "  --theme-%s: %s;\n", k, v)
	}
	w.Write([]byte("}\n"))
}

func main() {
	// Resolve store path.
	cliArg := ""
	if len(os.Args) > 1 {
		cliArg = os.Args[1]
	}
	storePath := stash.FindBestStorePath(cliArg, os.Getenv("STASH_STORE"))


	app := NewApp(storePath, themes)

	err := wails.Run(&options.App{
		Title:            "Stash",
		Width:            1200,
		Height:           800,
		MinWidth:         800,
		MinHeight:        500,
		EnableDefaultContextMenu: true,
		BackgroundColour: &options.RGBA{R: 26, G: 27, B: 38, A: 1},
		AssetServer: &assetserver.Options{
			Assets: assets,
			Handler: &muxHandler{
				app:   app,
				stash: &storeHandler{app: app},
			},
		},
		OnStartup:     app.startup,
		OnBeforeClose: app.beforeClose,
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}

