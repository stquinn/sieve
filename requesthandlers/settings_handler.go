package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type SettingsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (h *SettingsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/settings", h.handleSettings)
	r.Post("/api/settings", h.handleSettingsSave)
}

func (h *SettingsHandler) handleSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	settings := h.ServiceProvider.State.LoadSettings()
	if err := h.Tmpl.ExecuteTemplate(w, "settings.html", settings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *SettingsHandler) handleSettingsSave(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	settings := h.ServiceProvider.State.LoadSettings()
	settings.CLI = r.FormValue("cli")
	settings.Model = r.FormValue("model")

	if debounceStr := r.FormValue("autosave_debounce"); debounceStr != "" {
		if val, err := strconv.Atoi(debounceStr); err == nil {
			settings.AutosaveDebounce = val
		}
	}
	settings.Theme = r.FormValue("theme")
	if maxHistStr := r.FormValue("max_history_versions"); maxHistStr != "" {
		if val, err := strconv.Atoi(maxHistStr); err == nil {
			settings.MaxHistoryVersions = val
		}
	}
	settings.Debug = r.FormValue("debug") == "on"

	if err := h.ServiceProvider.State.SaveSettings(settings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if err := h.Tmpl.ExecuteTemplate(w, "settings.html", settings); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
