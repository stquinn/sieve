package main

import (
	"embed"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

// vaultHandler serves files from the vault root directory at the /vault/ URL prefix.
// This allows the Wails webview to display images stored in the vault (buffer assets,
// vault assets) using a stable URL like /vault/dash/buffers/assets/blk-xxx.png.
type vaultHandler struct{ root string }

func (h *vaultHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const prefix = "/vault/"
	if !strings.HasPrefix(r.URL.Path, prefix) {
		http.NotFound(w, r)
		return
	}
	rel := filepath.FromSlash(strings.TrimPrefix(r.URL.Path, prefix))
	abs := filepath.Join(h.root, filepath.Clean(rel))
	// Security: must stay within vault root
	if !strings.HasPrefix(abs+string(filepath.Separator), h.root+string(filepath.Separator)) {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, abs)
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
	app := NewApp(vaultPath)

	err := wails.Run(&options.App{
		Title:            "Stash",
		Width:            1200,
		Height:           800,
		MinWidth:         800,
		MinHeight:        500,
		EnableDefaultContextMenu: false,
		BackgroundColour: &options.RGBA{R: 26, G: 27, B: 38, A: 1},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: &vaultHandler{root: absVaultPath},
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

