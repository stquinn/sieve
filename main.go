package main

import (
	"embed"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"stash/vault"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed themes/*.json
var themes embed.FS

// vaultHandler serves files from the vault root directory at the /vault/ URL prefix.
type vaultHandler struct{ root string }

func (h *vaultHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const prefix = "/vault/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	rel := filepath.FromSlash(strings.TrimPrefix(r.URL.Path, prefix))
	abs := filepath.Join(h.root, filepath.Clean(rel))
	if !strings.HasPrefix(abs+string(filepath.Separator), h.root+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, abs)
}

// muxHandler sits in front of vaultHandler and intercepts /theme.css so that
// the Go backend can serve the active theme as a proper stylesheet before the
// browser renders a single pixel — no JS injection required.
type muxHandler struct {
	app   *App
	vault *vaultHandler
}

func (m *muxHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/theme.css" {
		m.serveThemeCSS(w, r)
		return
	}
	m.vault.ServeHTTP(w, r)
}

func (m *muxHandler) serveThemeCSS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")

	vaultRoot := m.app.GetVaultPath()
	settingsPath := m.app.SettingsPath()
	if vaultRoot == "" || settingsPath == "" {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	settings := vault.LoadSettings(settingsPath)
	vars := vault.LoadTheme(vaultRoot, settings.Theme, m.app.GetThemesFS())

	w.WriteHeader(http.StatusOK)
	w.Write([]byte("html:root {\n"))
	for k, v := range vars {
		fmt.Fprintf(w, "  --theme-%s: %s;\n", k, v)
	}
	w.Write([]byte("}\n"))
}

func main() {
	// Resolve vault path.
	// Priority: CLI arg > STASH_VAULT env var > PWD.
	// The env var is the reliable path in `wails dev` (which doesn't forward -- args).
	vaultPath := "."
	if v := os.Getenv("STASH_VAULT"); v != "" {
		vaultPath = v
	}
	if len(os.Args) > 1 {
		vaultPath = os.Args[1]
	}

	absVaultPath, _ := filepath.Abs(vaultPath)
	app := NewApp(vaultPath, themes)

	err := wails.Run(&options.App{
		Title:            "Stash",
		Width:            1200,
		Height:           800,
		MinWidth:         800,
		MinHeight:        500,
		EnableDefaultContextMenu: false,
		BackgroundColour: &options.RGBA{R: 26, G: 27, B: 38, A: 1},
		AssetServer: &assetserver.Options{
			Assets: assets,
			Handler: &muxHandler{
				app:   app,
				vault: &vaultHandler{root: absVaultPath},
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

