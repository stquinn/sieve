package main

import (
	"encoding/json"
	"html/template"
	"io/fs"
	"net/http"
	"sieve/logger"
	"sieve/requesthandlers"
	"sieve/sieve"
	"sieve/sieve/domain"

	"github.com/go-chi/chi/v5"
)

// apiHandler owns the chi router, templates and static files. It is bound to
// *App (composition root) because handleIndex reads live store state, so it
// stays in package main; the per-concern request handlers it mounts live in the
// requesthandlers package (see requesthandlers.Registry).
type apiHandler struct {
	app    *App
	tmpl   *template.Template
	static http.Handler
	routes *chi.Mux
}

func newAPIHandler(app *App, broadcast *requesthandlers.WorkspaceBroadcast, sp *sieve.ServiceProvider) (*apiHandler, error) {
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
		tmpl:   tmpl,
		static: http.FileServer(http.FS(staticFS)),
	}
	// The job tracker and its wiring into broadcast (constructor-injected, so it
	// is set exactly once before any socket can dial in) live in main(), which
	// builds both before this function runs — sp.Jobs already carries it here.
	// /keep-and-file writes user_intent and the sidebar must show it NOW; the
	// watcher notices the same write only after its debounce. command/ cannot name
	// a topic, so it drives a port and gets the concrete here.
	sp.Invalidator = broadcast
	// A save is a workspace-wide fact, so the Editor's save chokepoint publishes
	// through the same fan-out. Set here for the same reason Invalidator is: the
	// port lives below this package and the concrete above it. Init reads it.
	sp.SavedNotifier = broadcast
	// NOTE: the JobEngine and the Editor's SetJobs/SetEngine/SetAI wiring live in
	// ServiceProvider.Init (runs at Wails startup, AFTER this) — that is where
	// State/AI/Editor exist. Doing it here nil-derefs: sp is an empty struct until
	// Init. Init consumes sp.Jobs (the tracker set just above).
	r := chi.NewRouter()
	requesthandlers.Registry{
		ServiceProvider: sp,
		Tmpl:            tmpl,
		Broadcast:       broadcast,
		Version:         version,
		Credits:         thirdPartyLicenses,
		Themes:          app.getThemesFS(),
		WSToken:         app.WSToken,
		MCP:             mcpRoute{sp: sp},
		Static:          http.StripPrefix("/ui/static", h.static),
		Index:           http.HandlerFunc(h.handleIndex),
	}.Mount(r)

	r.NotFound(h.handleIndex)
	h.routes = r

	return h, nil
}

// mcpRoute serves the internal Sieve MCP (read-only knowledge base). The server
// is built at ServiceProvider.Init, after routing is assembled, so sp.MCP is
// dereferenced live at request time — the same pattern the sp-holding request
// handlers use. The MCP server itself authenticates the per-run bearer token
// before answering.
type mcpRoute struct{ sp *sieve.ServiceProvider }

func (m mcpRoute) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if m.sp.MCP == nil {
		http.Error(w, "sieve mcp unavailable", http.StatusServiceUnavailable)
		return
	}
	m.sp.MCP.ServeHTTP(w, r)
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

	// Which shape a reader left a container in is session state, so the shell
	// mounts the active tab in its own mode — the same field editor.html carries
	// on every other mount.
	activeUUID := ""
	activeMode := "wysiwyg"
	if session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeUUID = session.Tabs[session.ActiveIdx].ID
		if m := session.Tabs[session.ActiveIdx].Mode; m != "" {
			activeMode = m
		}
	}

	tierStr := "dumb"
	if info.Tier == 2 { // TierSmart
		tierStr = "smart"
	}

	commandsJSON := []byte("[]")
	if h.app.ServiceProvider != nil && h.app.ServiceProvider.Commands != nil {
		if b, err := json.Marshal(h.app.ServiceProvider.Commands.List()); err == nil {
			commandsJSON = b
		}
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
		ActiveMode       string
		AutosaveDebounce int
		CLITimeoutLong   int
		// MaxAttachmentBytes is the user's attachment ceiling (#84). The client
		// enforces it before it reads a file at all, so it has to know the number
		// Go would enforce — not a constant of its own that can drift from it.
		MaxAttachmentBytes int
		// SpellcheckEnabled seeds the toolbar toggle's pressed state. It is a
		// persisted global, so the page has to be told it at boot — the wire only
		// carries a CHANGE.
		SpellcheckEnabled bool
		DevServerPort     int
		// WSToken is this run's WebSocket upgrade credential (#83). The shell is
		// where the page learns it, because the shell is the one thing only the app
		// is served — a local process that dials the wires cannot ask for it.
		WSToken  string
		Commands template.JS
	}{
		StoreRoot:          info.Root,
		ThemeName:          info.ThemeName,
		Tier:               tierStr,
		SidebarWidth:       session.SidebarWidth,
		MetaWidth:          session.MetaWidth,
		ShowSidebar:        session.ShowSidebar,
		ShowMeta:           session.ShowMeta,
		ShowPrompts:        session.ShowPrompts,
		ShowToolbar:        session.ShowToolbar,
		ShowAskPanel:       session.ShowAskPanel,
		ShowLineNumbers:    session.ShowLineNumbers,
		PromptsHeight:      session.PromptsHeight,
		AskPanelHeight:     session.AskPanelHeight,
		ActiveUUID:         activeUUID,
		ActiveMode:         activeMode,
		AutosaveDebounce:   info.AutosaveDebounce,
		CLITimeoutLong:     info.CLITimeoutLong,
		MaxAttachmentBytes: info.MaxAttachmentBytes,
		SpellcheckEnabled:  info.SpellcheckEnabled,
		DevServerPort:      h.app.DevServerPort,
		WSToken:            h.app.WSToken,
		Commands:           template.JS(commandsJSON),
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
