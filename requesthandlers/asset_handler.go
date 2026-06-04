package requesthandlers

import (
	"bytes"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"sieve/sieve"
)

type AssetHandler struct {
	ServiceProvider *sieve.ServiceProvider
}

func (h *AssetHandler) RegisterPaths(r chi.Router) {
	r.Get("/sieve/{uuid}/{filename}", h.serveAsset)
}



func (h *AssetHandler) serveAsset(w http.ResponseWriter, r *http.Request) {
	uuid := chi.URLParam(r, "uuid")
	filename := chi.URLParam(r, "filename")
	data, err := h.ServiceProvider.Assets.ServeAssetData(uuid, filename)
	if err != nil {
		http.NotFound(w, r)
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
