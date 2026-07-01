package main

import (
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"net/url"
	"sieve/logger"
	"sieve/requesthandlers"
	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"strconv"

	"github.com/go-chi/chi/v5"
)

//go:embed frontend/src/templates
var uiTemplates embed.FS

//go:embed frontend/src/static
var uiStatic embed.FS

//go:embed frontend/src/index.html
var uiIndexHTML string

// apiHandler owns the chi router, templates, SSE hub, and static files.
type apiHandler struct {
	app    *App
	hub    *sseHub
	tmpl   *template.Template
	static http.Handler
	routes *chi.Mux
}

type metaRowData struct {
	Label string
	Value string
}

type promptVarDef struct {
	Name string
	Desc string
}

func promptVarsForType(t string) []promptVarDef {
	m := map[string][]promptVarDef{
		"file": {
			{"{content}", "Note body text"},
			{"{folder_list}", "Existing store folders"},
			{"{version}", "Doc version number"},
			{"{focus_count}", "Open frequency"},
			{"{created}", "Creation timestamp"},
			{"{modified}", "Last modified timestamp"},
			{"{now}", "Current timestamp"},
		},
		"explain": {
			{"{type}", "Detected content type"},
			{"{history}", "Relevant conversation context"},
			{"{content}", "Target text to explain"},
			{"{images}", "List of relevant asset names"},
		},
		"ask": {
			{"{type}", "Detected content type"},
			{"{content}", "Context document text"},
			{"{history}", "Conversation history"},
			{"{question}", "User question"},
			{"{images}", "List of relevant asset names"},
		},
		"refine": {
			{"{content}", "The code block text to identify"},
			{"{current_language}", "The language currently detected by heuristics"},
			{"{detection_method}", "The method used to detect the current language"},
		},
		"image": {
			{"{image_filename}", "The original filename of the image"},
		},
		"web-clip-fetch": {
			{"{source}", "URL to retrieve"},
		},
		"web-clip-summarise": {
			{"{source}", "URL to summarise"},
			{"{document}", "Current document content (sent automatically — not manually editable)"},
		},
	}
	return m[t]
}

func newAPIHandler(app *App, hub *sseHub, sp *sieve.ServiceProvider) (*apiHandler, error) {
	tmpl := template.New("").Funcs(template.FuncMap{
		"indent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 0.75+float64(depth)*1.0)
		},
		"fileIndent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 1.5+float64(depth)*1.0)
		},
		"urlenc": url.QueryEscape,
		"metaRow": func(label, value string) metaRowData {
			return metaRowData{Label: label, Value: value}
		},
		"promptVars": promptVarsForType,
	})
	var err error
	tmpl, err = tmpl.ParseFS(uiTemplates, "frontend/src/templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parse templates: %w", err)
	}

	staticFS, err := fs.Sub(uiStatic, "frontend/src/static")
	if err != nil {
		return nil, err
	}

	h := &apiHandler{
		app:    app,
		hub:    hub,
		tmpl:   tmpl,
		static: http.FileServer(http.FS(staticFS)),
	}
	jobTracker := services.NewJobTracker()
	jobTracker.Broadcast = hub.broadcast
	sp.Jobs = jobTracker

	const defaultWorkers = 4
	sp.Engine = services.NewJobEngine(sp.State.LoadSettings().WorkerPools, defaultWorkers, jobTracker)
	if sp.Editor != nil {
		sp.Editor.SetJobs(jobTracker)
		sp.Editor.SetEngine(sp.Engine)
	}
	requestHandlers := []requesthandlers.RequestHandler{
		&requesthandlers.SideBarHandler{ServiceProvider: sp, Tmpl: tmpl},
		&requesthandlers.TabHandler{ServiceProvider: sp, Tmpl: tmpl},
		&requesthandlers.ContextMenuHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitNotesChanged: func() {
				hub.broadcast("notes:changed", "{}")
			},
			EmitPromptsChanged: func() {
				hub.broadcast("prompts:changed", "{}")
			},
		},
		&requesthandlers.MetaHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitNotesChanged: func() {
				logger.Info("MetaHandler: notes changed event")
				hub.broadcast("notes:changed", "{}")
			},
		},
		&requesthandlers.EditorHandler{ServiceProvider: sp, Tmpl: tmpl, Broadcast: hub.broadcast},
		&requesthandlers.SettingsHandler{ServiceProvider: sp, Tmpl: tmpl},
		&requesthandlers.HelpHandler{Tmpl: tmpl},
		&requesthandlers.SearchHandler{ServiceProvider: sp, Tmpl: tmpl},
		&requesthandlers.AssetHandler{ServiceProvider: sp},
		&requesthandlers.PromptsHandler{ServiceProvider: sp, Tmpl: tmpl},
		&requesthandlers.SessionHandler{
			ServiceProvider: sp,
			Broadcast:       hub.broadcast,
		},
		&requesthandlers.NoteHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitSessionChanged: func() {
				hub.broadcast("session:changed", "{}")
			},
		},
		&requesthandlers.AiHandler{
			ServiceProvider: sp,
			JobTracker:      jobTracker,
			EmitNotesChanged: func() {
				logger.Info("AI: notes changed event")
				hub.broadcast("notes:changed", "{}")
			},
			Broadcast: hub.broadcast,
		},
		requesthandlers.NewWsHandler(sp),
		&requesthandlers.LibraryHandler{
			Tmpl:            tmpl,
			ServiceProvider: sp,
		},
	}
	r := chi.NewRouter()
	for _, requestHandler := range requestHandlers {
		requestHandler.RegisterPaths(r)
	}
	r.Get("/sse", h.hub.ServeHTTP)
	r.Handle("/static/*", http.StripPrefix("/static", h.static))
	r.Get("/", h.handleIndex)

	r.NotFound(h.handleIndex)
	h.routes = r

	return h, nil
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.routes.ServeHTTP(w, r)
}

func (h *apiHandler) handleIndex(w http.ResponseWriter, r *http.Request) {
	info := h.app.GetStoreInfo()

	var session domain.Session
	if h.app.ServiceProvider.State != nil {
		session = h.app.ServiceProvider.State.LoadSession()
	} else {
		// Sensible defaults for bootstrap screen
		session = domain.Session{
			SidebarWidth:  260,
			MetaWidth:     280,
			PromptsHeight: 180,
			ShowSidebar:   true,
		}
	}

	activeUUID := ""
	if session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeUUID = session.Tabs[session.ActiveIdx].ID
	}

	tierStr := "dumb"
	if info.Tier == 2 { // TierSmart
		tierStr = "smart"
	}

	data := struct {
		StoreRoot        string
		ThemeName        string
		Tier             string
		SidebarWidth     int
		MetaWidth        int
		ShowSidebar      bool
		ShowMeta         bool
		ShowPrompts      bool
		ShowToolbar      bool
		ShowAskPanel     bool
		ShowLineNumbers  bool
		PromptsHeight    int
		AskPanelHeight   int
		ActiveUUID       string
		AutosaveDebounce int
		CLITimeoutLong   int
		DevServerPort    int
	}{
		StoreRoot:        info.Root,
		ThemeName:        info.ThemeName,
		Tier:             tierStr,
		SidebarWidth:     session.SidebarWidth,
		MetaWidth:        session.MetaWidth,
		ShowSidebar:      session.ShowSidebar,
		ShowMeta:         session.ShowMeta,
		ShowPrompts:      session.ShowPrompts,
		ShowToolbar:      session.ShowToolbar,
		ShowAskPanel:     session.ShowAskPanel,
		ShowLineNumbers:  session.ShowLineNumbers,
		PromptsHeight:    session.PromptsHeight,
		AskPanelHeight:   session.AskPanelHeight,
		ActiveUUID:       activeUUID,
		AutosaveDebounce: info.AutosaveDebounce,
		CLITimeoutLong:   info.CLITimeoutLong,
		DevServerPort:    h.app.DevServerPort,
	}

	if data.ThemeName == "" {
		data.ThemeName = "tokyo-night"
	}

	tmpl, err := template.New("index").Parse(uiIndexHTML)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.Execute(w, data); err != nil {
		logger.Error("failed to execute index template", "err", err)
	}
}

// ── Note & Tab Operations ───────────────────────────────────────────────────

func (h *apiHandler) handleTabsClose(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	session := h.app.ServiceProvider.State.LoadSession()

	newTabs := []domain.Tab{}
	for _, t := range session.Tabs {
		if t.ID != id {
			newTabs = append(newTabs, t)
		}
	}
	session.Tabs = newTabs
	if session.ActiveIdx >= len(session.Tabs) {
		session.ActiveIdx = len(session.Tabs) - 1
	}
	if session.ActiveIdx < 0 && len(session.Tabs) > 0 {
		session.ActiveIdx = 0
	}

	if len(session.Tabs) == 0 {
		dto, _ := h.app.ServiceProvider.Documents.New()
		session.Tabs = []domain.Tab{{ID: dto.UUID(), Mode: "wysiwyg"}}
		session.ActiveIdx = 0
	}

	_ = h.app.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	activeID := session.Tabs[session.ActiveIdx].ID
	fmt.Fprintf(w, `<div id="htmx-editor" hx-swap-oob="true" class="editor-wrapper" style="flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column;">
		<div id="tiptap-mount" data-uuid="%s" data-mode="wysiwyg" style="flex: 1; min-height: 0; height: 100%%; display: flex; flex-direction: column;"></div>
	</div>`, activeID)
}

func (h *apiHandler) handleTabsReorder(w http.ResponseWriter, r *http.Request) {
	fromStr := r.FormValue("from")
	toStr := r.FormValue("to")

	fromIdx, _ := strconv.Atoi(fromStr)
	toIdx, _ := strconv.Atoi(toStr)

	session := h.app.ServiceProvider.State.LoadSession()
	if fromIdx < 0 || fromIdx >= len(session.Tabs) || toIdx < 0 || toIdx > len(session.Tabs) {
		http.Error(w, "invalid indices", http.StatusBadRequest)
		return
	}

	tabs := session.Tabs
	moved := tabs[fromIdx]

	tabs = append(tabs[:fromIdx], tabs[fromIdx+1:]...)

	if toIdx > fromIdx {
		toIdx--
	}

	tabs = append(tabs[:toIdx], append([]domain.Tab{moved}, tabs[toIdx:]...)...)
	session.Tabs = tabs

	activeIdx := session.ActiveIdx
	if activeIdx == fromIdx {
		activeIdx = toIdx
	} else if activeIdx > fromIdx && activeIdx <= toIdx {
		activeIdx--
	} else if activeIdx < fromIdx && activeIdx >= toIdx {
		activeIdx++
	}
	session.ActiveIdx = activeIdx

	_ = h.app.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// ── Session & Layout Operations ───────────────────────────────────────────────

func (h *apiHandler) handleSidebarToggle(w http.ResponseWriter, r *http.Request) {
	session := h.app.ServiceProvider.State.LoadSession()
	session.ShowSidebar = !session.ShowSidebar
	_ = h.app.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#app-root {
			--sidebar-w: %dpx;
		}
		#htmx-sidebar {
			display: %s;
		}
	</style>`, map[bool]int{true: session.SidebarWidth, false: 0}[session.ShowSidebar],
		map[bool]string{true: "block", false: "none"}[session.ShowSidebar])
}

func (h *apiHandler) handleMetaToggle(w http.ResponseWriter, r *http.Request) {
	session := h.app.ServiceProvider.State.LoadSession()
	session.ShowMeta = !session.ShowMeta
	_ = h.app.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#app-root {
			--meta-w: %dpx;
		}
		#htmx-meta-panel {
			display: %s;
		}
	</style>`, map[bool]int{true: session.MetaWidth, false: 0}[session.ShowMeta],
		map[bool]string{true: "flex", false: "none"}[session.ShowMeta])
}

func (h *apiHandler) handlePromptsToggle(w http.ResponseWriter, r *http.Request) {
	session := h.app.ServiceProvider.State.LoadSession()
	session.ShowPrompts = !session.ShowPrompts
	_ = h.app.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#prompts-panel {
			display: %s;
		}
	</style>`, map[bool]string{true: "block", false: "none"}[session.ShowPrompts])
}

func (h *apiHandler) handleSessionLayout(w http.ResponseWriter, r *http.Request) {
	session := h.app.ServiceProvider.State.LoadSession()

	if wStr := r.FormValue("sidebarWidth"); wStr != "" {
		if wInt, err := strconv.Atoi(wStr); err == nil {
			session.SidebarWidth = wInt
		}
	}
	if wStr := r.FormValue("metaWidth"); wStr != "" {
		if wInt, err := strconv.Atoi(wStr); err == nil {
			session.MetaWidth = wInt
		}
	}
	if hStr := r.FormValue("promptsHeight"); hStr != "" {
		if hInt, err := strconv.Atoi(hStr); err == nil {
			session.PromptsHeight = hInt
		}
	}

	_ = h.app.ServiceProvider.State.SaveSession(session)
	w.WriteHeader(http.StatusNoContent)
}

func (h *apiHandler) handleSessionRefresh(w http.ResponseWriter, r *http.Request) {
	info := h.app.GetStoreInfo()

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<script hx-swap-oob="true">
		var root = document.documentElement;
		var themeName = "%s";
		root.className = root.className.replace(/theme-\S+/, 'theme-' + themeName);
	</script>`, info.ThemeName)
}
