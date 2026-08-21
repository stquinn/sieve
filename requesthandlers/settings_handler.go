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
	"strings"

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

// parseHeaders parses the settings panel's compact MCP header line —
// "Key=Value,Key2=Value2" (the joinHeaders template func's inverse, see
// requesthandlers/templates.go) — into a header map. Blank entries and entries
// without an "=" are skipped; a value may itself contain "=" (only the first
// one splits key from value).
func (h *SettingsHandler) parseHeaders(raw string) map[string]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	headers := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		k = strings.TrimSpace(k)
		if !ok || k == "" {
			continue
		}
		headers[k] = strings.TrimSpace(v)
	}
	if len(headers) == 0 {
		return nil
	}
	return headers
}

func (h *SettingsHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/settings", h.handleSettings)
	r.Post("/api/settings", h.handleSettingsSave)
	r.Post("/api/settings/panel", h.handleSettingsPanel)
	r.Post("/api/settings/editor-scale/step", h.handleEditorScaleStep)
}

// handleEditorScaleStep backs the "Increase/Decrease/Reset Editor Font" native
// menu accelerators (main.go buildMenu, View menu). It persists through the
// normal settings path (LookAndFeel.StepEditorScale + SaveSettings) so the
// change survives a restart — it is not a transient client-side zoom — and
// reuses the same HX-Trigger:settings:changed the settings-panel save uses to
// bust the /theme.css cache, so the new scale is visible immediately.
func (h *SettingsHandler) handleEditorScaleStep(w http.ResponseWriter, r *http.Request) {
	dir := r.URL.Query().Get("dir")

	settings := h.ServiceProvider.State.LoadSettings()
	settings.LookAndFeel = settings.LookAndFeel.StepEditorScale(dir)

	if err := h.ServiceProvider.State.SaveSettings(settings); err != nil {
		logger.Error("handleEditorScaleStep: save failed", "err", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("HX-Trigger", "settings:changed")
	w.WriteHeader(http.StatusNoContent)
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
	settings.CLIPath = strings.TrimSpace(r.FormValue("cli_path"))
	settings.Model = r.FormValue("model")
	settings.Diagram.PlantumlServer = r.FormValue("diagram_plantuml_server")
	settings.Diagram.DefaultType = r.FormValue("diagram_default_type")

	if debounceStr := r.FormValue("autosave_debounce"); debounceStr != "" {
		if val, err := strconv.Atoi(debounceStr); err == nil {
			settings.AutosaveDebounce = val
		}
	}
	settings.Theme = r.FormValue("theme")

	// LookAndFeel: every field is three-state (empty = follow theme), so an
	// empty form value must persist as empty, never a copied theme value.
	// Number inputs arrive bare ("16") and are stored with their CSS unit;
	// line-height is stored unitless. Overrides() (domain/settings.go)
	// re-validates on the way OUT of settings.json, so a value that fails
	// validation here is merely inert rather than a security boundary.
	settings.LookAndFeel.EditorFont = r.FormValue("look_and_feel_editor_font")
	settings.LookAndFeel.MonoFont = r.FormValue("look_and_feel_mono_font")
	settings.LookAndFeel.UIFont = r.FormValue("look_and_feel_ui_font")
	// Select of a closed step set (see LookAndFeel.EditorScaleSteps) — the
	// value is the unitless multiplier itself, stored verbatim.
	settings.LookAndFeel.EditorScale = r.FormValue("look_and_feel_editor_scale")
	settings.LookAndFeel.EditorLineHeight = strings.TrimSpace(r.FormValue("look_and_feel_editor_line_height"))
	settings.LookAndFeel.EditorMeasure = ""
	if v := strings.TrimSpace(r.FormValue("look_and_feel_editor_measure")); v != "" {
		settings.LookAndFeel.EditorMeasure = v + "ch"
	}
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
	// Apply the debug flag to the logger live, so toggling it takes effect without
	// an app restart (mirrors the startup application in app.go).
	logger.SetDebug(settings.Debug)

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

	// Containment additions (user-granted tools/dirs/MCP servers on top of the
	// baseline). Rebuild from the form each save — like custom parsers — so a
	// removed row disappears; LoadContainmentProfile overlays these onto the
	// baseline to produce the full in-memory profile, and Marshal drops the
	// baseline back out at persistence time (WithoutBaseline), so settings.json
	// only ever holds the user's additions.
	adds := domain.ContainmentProfile{}
	// Typed tool grants (#41): each row carries a verb (the CLI tool name), a type
	// (file|network|other, drives scoping), and a constraint (network domains /
	// other verbatim specifier; unused for file). The verb goes into Names for the
	// ACTIVE CLI only — a named tool follows the CLI it was added under; a different
	// CLI simply can't resolve it and the grant is omitted (fail closed). The three
	// arrays align by index (every row submits all three, readonly included).
	toolNames := r.PostForm["containment_tool_name"]
	toolTypes := r.PostForm["containment_tool_type"]
	toolConstraints := r.PostForm["containment_tool_constraint"]
	for i, name := range toolNames {
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}
		typ := "file"
		if i < len(toolTypes) && toolTypes[i] != "" {
			typ = toolTypes[i]
		}
		constraint := ""
		if typ != "file" && i < len(toolConstraints) {
			constraint = strings.TrimSpace(toolConstraints[i])
		}
		adds.Tools = append(adds.Tools, domain.ToolGrant{
			Type:       typ,
			Label:      name,
			Names:      map[string]string{settings.CLI: name},
			Constraint: constraint,
		})
	}
	for _, p := range r.PostForm["containment_dir_path"] {
		if p != "" {
			adds.Directories = append(adds.Directories, domain.DirGrant{Path: p})
		}
	}
	mcpNames := r.PostForm["containment_mcp_name"]
	mcpTransports := r.PostForm["containment_mcp_transport"]
	mcpCommands := r.PostForm["containment_mcp_command"]
	mcpArgs := r.PostForm["containment_mcp_args"]
	mcpURLs := r.PostForm["containment_mcp_url"]
	mcpHeaders := r.PostForm["containment_mcp_headers"]
	for i, name := range mcpNames {
		if name == "" {
			continue
		}
		transport := "stdio"
		if i < len(mcpTransports) && mcpTransports[i] != "" {
			transport = mcpTransports[i]
		}
		grant := domain.McpGrant{Name: name, Transport: transport}
		switch transport {
		case "http", "sse":
			if i < len(mcpURLs) {
				grant.URL = mcpURLs[i]
			}
			if i < len(mcpHeaders) {
				grant.Headers = h.parseHeaders(mcpHeaders[i])
			}
		default: // stdio
			if i < len(mcpCommands) {
				grant.Command = mcpCommands[i]
			}
			if i < len(mcpArgs) && mcpArgs[i] != "" {
				grant.Args = strings.Fields(mcpArgs[i])
			}
		}
		adds.McpServers = append(adds.McpServers, grant)
	}
	settings.AI.Containment = domain.LoadContainmentProfile(adds)

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
