package requesthandlers

import (
	"bytes"
	"net/http"
	"strings"

	"sieve/logger"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

// AssetServeHandler serves document assets via the UUID-stable URL scheme:
//
//	GET /sieve/{uuid}/{filename}
//
// The UUID identifies the document that owns the asset; the filename is the
// asset file co-located inside the document directory.
type AssetServeHandler struct {
	ServiceProvider *sieve.ServiceProvider
}

func (h *AssetServeHandler) RegisterPaths(r chi.Router) {
	r.Get("/sieve/{uuid}/{filename}", h.serveAsset)
}

func (h *AssetServeHandler) serveAsset(w http.ResponseWriter, r *http.Request) {
	uuid := chi.URLParam(r, "uuid")
	filename := chi.URLParam(r, "filename")
	logger.Info("Serving Asset", "filename", filename, "uuid", uuid)
	doc, err := h.ServiceProvider.Documents.LoadByUUID(uuid)
	if err != nil {
		http.NotFound(w, r)
	}
	logger.Info("Document Found", "Document", uuid, "Assets", len(doc.Storable().Owns()))
	for _, asset := range doc.Storable().Owns() {
		logger.Info("Asset", "filename", asset.Key())
		if asset.Key() == filename {
			logger.Info("Found Asset", "filename", filename, "uuid", uuid)
			data := asset.Body()
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
	http.NotFound(w, r)
}
