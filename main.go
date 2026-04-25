package main

import (
	"crypto/tls"
	"embed"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sieve/sieve"

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

	// Ensure we're still inside the store root
	if !strings.HasPrefix(filePath+string(filepath.Separator), abs+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, filePath)
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
	m.store.ServeHTTP(w, r)
}

func (m *muxHandler) serveProxy(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		http.Error(w, "missing url parameter", http.StatusBadRequest)
		return
	}

	w.Header().Set("Access-Control-Allow-Origin", "*")
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

	settings := m.app.LoadSettings()
	vars := sieve.LoadTheme(settings.Theme, m.app.loadThemeOverride(settings.Theme), m.app.GetThemesFS())

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("html:root {\n"))
	for k, v := range vars {
		fmt.Fprintf(w, "  --theme-%s: %s;\n", k, v)
	}
	w.Write([]byte("}\n"))
}

func main() {
	cliArg := ""
	if len(os.Args) > 1 {
		cliArg = os.Args[1]
	}
	storePath := FindBestStorePath(cliArg, os.Getenv("SIEVE_STORE"))

	hub := newSSEHub()
	app := NewApp(storePath, themes, hub)

	api, err := newAPIHandler(app, hub)
	if err != nil {
		log.Fatalf("failed to init API handler: %v", err)
	}

	err = wails.Run(&options.App{
		Title:                    "Sieve",
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
