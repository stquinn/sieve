package main

import (
	"html/template"
	"io/fs"
	"net/http"
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

func newAPIHandler(app *App, hub *sse.Hub, sp *sieve.ServiceProvider) (*apiHandler, error) {
	tmpl, err := requesthandlers.NewTemplates(uiTemplates)
	if err != nil {
		return nil, err
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
	// Internal Sieve MCP (read-only knowledge base). The server is built at
	// Init (after this mount), so the route derefs sp.MCP live at request time
	// — same pattern as the sp-holding request handlers. It authenticates via a
	// per-run bearer token before delegating to the streamable MCP handler.
	r.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if sp.MCP == nil {
			http.Error(w, "sieve mcp unavailable", http.StatusServiceUnavailable)
			return
		}
		sp.MCP.ServeHTTP(w, req)
	}))
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
	info := h.app.getStoreInfo()

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
