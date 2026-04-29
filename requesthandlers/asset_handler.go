package requesthandlers

import (
	"encoding/json"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type AssetHandler struct {
	ServiceProvider *sieve.ServiceProvider
	SaveAsset       func(context, id, dataUrl string) (interface{}, error)
}

func (h *AssetHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/asset/save", h.handleSave)
}

type saveAssetRequest struct {
	Path    string `json:"path"`
	ID      string `json:"id"`
	DataUrl string `json:"dataUrl"`
}

func (h *AssetHandler) handleSave(w http.ResponseWriter, r *http.Request) {
	var req saveAssetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	asset, err := h.SaveAsset(req.Path, req.ID, req.DataUrl)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(asset)
}
