package requesthandlers

import (
	"crypto/tls"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/domain"

	"github.com/go-chi/chi/v5"
)

// AssetHandler serves the non-view bytes the UI fetches under /ui: stored
// assets, store-root-relative files, the generated theme stylesheet, and the
// image proxy. They share a handler because they share a shape — GET-only,
// idempotent, no template — not because they share a data source.
type AssetHandler struct {
	ServiceProvider *sieve.ServiceProvider
	// Themes is the embedded builtin-theme filesystem. It is read directly
	// rather than through StateService because /ui/theme.css is requested before
	// the store opens, when no StateService exists yet.
	Themes fs.FS
	// proxyClient fetches remote images. Certificate verification is off because
	// the proxy exists to render whatever a clipped page pointed at, including
	// hosts with broken chains; the bytes are only ever painted as an image,
	// never trusted as code or credentials.
	proxyClient *http.Client
}

// NewAssetHandler builds the /ui byte handler over the composition root and the
// embedded builtin themes.
func NewAssetHandler(sp *sieve.ServiceProvider, themes fs.FS) *AssetHandler {
	return &AssetHandler{
		ServiceProvider: sp,
		Themes:          themes,
		proxyClient: &http.Client{
			Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}},
			Timeout:   30 * time.Second,
		},
	}
}

func (h *AssetHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/assets/{uuid}/{filename}", h.serveAsset)
	r.Get("/ui/files/*", h.serveStoreFile)
	r.Get("/ui/theme.css", h.serveThemeCSS)
	r.Get("/ui/image-proxy", h.serveProxy)
}

func (h *AssetHandler) serveAsset(w http.ResponseWriter, r *http.Request) {
	uuid := chi.URLParam(r, "uuid")
	filename := chi.URLParam(r, "filename")
	data, err := h.ServiceProvider.Assets.ServeAssetData(uuid, filename)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h.writeBytes(w, data)
}

// serveStoreFile serves a file named relative to the library root — what a
// relative markdown image source resolves to.
func (h *AssetHandler) serveStoreFile(w http.ResponseWriter, r *http.Request) {
	if h.ServiceProvider.Assets == nil {
		http.Error(w, "store not initialized", http.StatusServiceUnavailable)
		return
	}
	data, err := h.ServiceProvider.Assets.ServeStoreFile(chi.URLParam(r, "*"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	h.writeBytes(w, data)
}

func (h *AssetHandler) writeBytes(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Type", h.ServiceProvider.Assets.DetectContentType(data))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// serveThemeCSS renders the active theme as :root custom properties. The
// stylesheet is generated per request and never cached: a settings save changes
// it, and index.html re-links it with a cache-buster on settings:changed.
func (h *AssetHandler) serveThemeCSS(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")

	var vars domain.ThemeVars
	if state := h.ServiceProvider.State; state != nil {
		vars = state.ActiveThemeVars()
		// User overrides win over the theme's own values — see LookAndFeel doc
		// comment for the three-layer precedence model (CSS default < theme < user).
		for k, v := range state.LoadSettings().LookAndFeel.Overrides() {
			vars[k] = v
		}
	} else {
		vars = domain.LoadTheme("tokyo-night", nil, h.Themes)
	}

	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("html:root {\n"))
	for k, v := range vars {
		fmt.Fprintf(w, "  --theme-%s: %s;\n", k, v)
	}
	_, _ = w.Write([]byte("}\n"))
}

// serveProxy fetches a remote image on the page's behalf. The webview cannot
// load cross-origin images into a canvas, so anything the editor needs to
// measure or re-encode comes through here.
func (h *AssetHandler) serveProxy(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		http.Error(w, "missing url parameter", http.StatusBadRequest)
		return
	}

	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	} else {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL, nil)
	if err != nil {
		logger.Warn("proxy: request creation failed", "err", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

	resp, err := h.proxyClient.Do(req)
	if err != nil {
		logger.Warn("proxy: fetch failed", "url", targetURL, "err", err)
		http.Error(w, fmt.Sprintf("failed to fetch url: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

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
