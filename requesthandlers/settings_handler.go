package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/ai"
	"sieve/sieve/domain"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type SettingsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

// settingsView is the template payload for settings.html. Settings is embedded
// so its fields (Theme, CLITimeoutLong, PromptTimeouts, …) are promoted; Prompts
// drives the per-prompt timeout override table.
type settingsView struct {
	domain.Settings
	LastSettingsPanel string
	Prompts           []ai.PromptEntry
}

// buildView assembles the template payload, resolving the prompt list from the
// PromptService when available.
func (h *SettingsHandler) buildView(settings domain.Settings, lastPanel string) settingsView {
	var prompts []ai.PromptEntry
	if h.ServiceProvider.Prompts != nil {
		prompts = h.ServiceProvider.Prompts.ListPrompts()
	}
	return settingsView{
		Settings:          settings,
		LastSettingsPanel: lastPanel,
		Prompts:           prompts,
	}
}

func (h *SettingsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/settings", h.handleSettings)
	r.Post("/api/settings", h.handleSettingsSave)
	r.Post("/api/settings/panel", h.handleSettingsPanel)
}

func (h *SettingsHandler) handleSettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if h.ServiceProvider.State == nil {
		return
	}

	settings := h.ServiceProvider.State.LoadSettings()
	session := h.ServiceProvider.State.LoadSession()

	data := h.buildView(settings, session.LastSettingsPanel)

	if err := h.Tmpl.ExecuteTemplate(w, "settings.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *SettingsHandler) handleSettingsSave(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := r.ParseForm(); err != nil {
		logger.Error("handleSettingsSave: parse form failed", "err", err)
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
	if longStr := r.FormValue("cli_timeout_long"); longStr != "" {
		if val, err := strconv.Atoi(longStr); err == nil && val > 0 {
			settings.CLITimeoutLong = val
		}
	}

	// Per-prompt timeout overrides. Blank/0/invalid ⇒ absent from the map, which
	// falls back to CLITimeoutLong. Rebuild the map from the form each save so a
	// cleared field removes its override.
	promptTimeouts := map[string]int{}
	if h.ServiceProvider.Prompts != nil {
		for _, p := range h.ServiceProvider.Prompts.ListPrompts() {
			if v := r.FormValue("prompt_timeout_" + p.Name); v != "" {
				if val, err := strconv.Atoi(v); err == nil && val > 0 {
					promptTimeouts[p.Name] = val
				}
			}
		}
	}
	settings.PromptTimeouts = promptTimeouts

	settings.Debug = r.FormValue("debug") == "on"

	var customParsers []domain.CustomLogParser
	names := r.PostForm["parser_name"]
	patterns := r.PostForm["parser_pattern"]
	for i := 0; i < len(names); i++ {
		if i < len(patterns) && names[i] != "" && patterns[i] != "" {
			customParsers = append(customParsers, domain.CustomLogParser{
				Name:    names[i],
				Pattern: patterns[i],
			})
		}
	}
	settings.CustomLogParsers = customParsers

	logger.Info("handleSettingsSave: saving settings", "cli", settings.CLI, "theme", settings.Theme, "debug", settings.Debug)

	if err := h.ServiceProvider.State.SaveSettings(settings); err != nil {
		logger.Error("handleSettingsSave: save failed", "err", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Apply history retention live so a changed max_history_versions takes effect
	// without an app restart.
	h.ServiceProvider.ApplyRetention(settings.MaxHistoryVersions)

	w.Header().Set("HX-Trigger", "settings:changed")

	session := h.ServiceProvider.State.LoadSession()
	if lastPanel := r.FormValue("last_settings_panel"); lastPanel != "" {
		session.LastSettingsPanel = lastPanel
		_ = h.ServiceProvider.State.SaveSession(session)
	}

	data := h.buildView(settings, session.LastSettingsPanel)

	if err := h.Tmpl.ExecuteTemplate(w, "settings.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Re-apply the AI tier class on #app-root so configuring (or removing) a CLI
	// updates the tier-gated AI buttons live, without a reload. This <script> runs
	// because the response is swapped into #settings-dialog-content (innerHTML).
	// settings.Tier() re-resolves the CLI on PATH, so it reflects the just-saved CLI.
	tierStr := "dumb"
	if settings.Tier() == domain.TierSmart {
		tierStr = "smart"
	}
	fmt.Fprintf(w, `<script>var r=document.getElementById('app-root');if(r)r.className=r.className.replace(/tier-\S+/,'tier-%s');</script>`, tierStr)
}

func (h *SettingsHandler) handleSettingsPanel(w http.ResponseWriter, r *http.Request) {
	tab := r.URL.Query().Get("tab")
	if tab != "" {
		session := h.ServiceProvider.State.LoadSession()
		session.LastSettingsPanel = tab
		_ = h.ServiceProvider.State.SaveSession(session)
	}
	w.WriteHeader(http.StatusNoContent)
}
