package requesthandlers

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"sieve/logger"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type AssetHandler struct {
	ServiceProvider *sieve.ServiceProvider
}

func (h *AssetHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/asset/save", h.handleSave)
	r.Get("/sieve/{uuid}/{filename}", h.serveAsset)
}

type saveAssetRequest struct {
	UUID    string `json:"uuid"`
	ID      string `json:"id"`
	DataUrl string `json:"dataUrl"`
}

func (h *AssetHandler) handleSave(w http.ResponseWriter, r *http.Request) {
	var req saveAssetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Determine category from document kind; default to WorkingCopy for new/empty context.
	cat := sieve.WorkingCopy
	var doc sieve.Document
	if req.UUID != "" {
		if d, err := h.ServiceProvider.Documents.LoadByUUID(req.UUID); err == nil {
			doc = d
			if doc.Kind() == sieve.KindNote {
				cat = sieve.Library
			}
		}
	}

	asset, err := h.ServiceProvider.Assets.Save(cat, req.UUID, req.ID, decodeDataURL(req.DataUrl))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if doc != nil {
		doc.Storable().AttachAsset(asset.Storable())
		if _, err := h.ServiceProvider.Documents.Save(doc); err != nil {
			// Non-fatal: asset is saved, attachment metadata just won't persist.
			_ = err
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"externalRef": asset.ExternalRef()})
}

func decodeDataURL(dataURL string) []byte {
	if idx := strings.Index(dataURL, ","); idx >= 0 {
		dataURL = dataURL[idx+1:]
	}
	data, _ := base64.StdEncoding.DecodeString(dataURL)
	return data
}

func (h *AssetHandler) serveAsset(w http.ResponseWriter, r *http.Request) {
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
