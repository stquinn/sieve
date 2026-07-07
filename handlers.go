package main

import (
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
	"sieve/sse"

	"github.com/go-chi/chi/v5"
)

// apiHandler owns the chi router, templates, SSE hub, and static files. It is
// bound to *App (composition root) because handleIndex reads live store state,
// so it stays in package main; the per-concern request handlers it mounts live
// in the requesthandlers package (see requesthandlers.Registry).
type apiHandler struct {
	app    *App
	hub    *sse.Hub
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

func newAPIHandler(app *App, hub *sse.Hub, sp *sieve.ServiceProvider) (*apiHandler, error) {
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
	jobTracker.Broadcast = hub.Broadcast
	sp.Jobs = jobTracker
	// NOTE: the JobEngine and the Editor's SetJobs/SetEngine/SetAI wiring live in
	// ServiceProvider.Init (runs at Wails startup, AFTER this) — that is where
	// State/AI/Editor exist. Doing it here nil-derefs: sp is an empty struct until
	// Init. Init consumes sp.Jobs (the hub-wired tracker set just above).
	r := chi.NewRouter()
	requesthandlers.Registry{
		ServiceProvider: sp,
		Tmpl:            tmpl,
		Broadcast:       hub.Broadcast,
		Jobs:            jobTracker,
	}.Mount(r)
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
