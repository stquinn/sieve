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

	"github.com/go-chi/chi/v5"
)

//go:embed ui/templates
var uiTemplates embed.FS

//go:embed ui/static
var uiStatic embed.FS

//go:embed ui/index.html
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
		},
		"image": {
			{"{image_filename}", "The original filename of the image"},
		},
	}
	return m[t]
}

func newAPIHandler(app *App, hub *sseHub) (*apiHandler, error) {
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
	tmpl, err = tmpl.ParseFS(uiTemplates, "ui/templates/*.html")
	if err != nil {
		return nil, fmt.Errorf("parse templates: %w", err)
	}

	staticFS, err := fs.Sub(uiStatic, "ui/static")
	if err != nil {
		return nil, err
	}

	h := &apiHandler{
		app:    app,
		hub:    hub,
		tmpl:   tmpl,
		static: http.FileServer(http.FS(staticFS)),
	}
	requestHandlers := []requesthandlers.RequestHandler{
		&requesthandlers.SideBarHandler{Notes: &app.notes, State: &app.state, Tmpl: tmpl},
		&requesthandlers.TabHandler{State: &app.state, Tmpl: tmpl},
		&requesthandlers.ContextMenuHandler{
			Notes: &app.notes,
			State: &app.state,
			Tmpl:  tmpl,
			DeleteNote: func(uuid string) error {
				return app.DeleteNote(uuid)
			},
			DeleteFolder: func(id string) error {
				return app.DeleteFolder(id)
			},
			RenameNote: func(uuid, name string) error {
				_, err := app.RenameNote(uuid, name)
				return err
			},
			RenameFolder: func(id, name string) error {
				_, err := app.RenameFolder(id, name)
				return err
			},
		},
		&requesthandlers.MetaHandler{Buffers: &app.buffers, Notes: &app.notes, Tmpl: tmpl},
		&requesthandlers.EditorHandler{Buffers: &app.buffers, Notes: &app.notes, Prompts: &app.prompts, Tmpl: tmpl},
		&requesthandlers.SettingsHandler{State: &app.state, Tmpl: tmpl},
		&requesthandlers.HelpHandler{Tmpl: tmpl},
		&requesthandlers.SearchHandler{Notes: &app.notes, State: &app.state, Tmpl: tmpl},
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
	session := h.app.GetSession()

	activeUUID := ""
	if session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeUUID = session.Tabs[session.ActiveIdx].ID
	}

	tierStr := "dumb"
	if info.Tier == 2 { // TierSmart
		tierStr = "smart"
	}

	data := struct {
		ThemeName     string
		Tier          string
		SidebarWidth  int
		MetaWidth     int
		ShowSidebar   bool
		ShowMeta      bool
		ShowPrompts   bool
		PromptsHeight int
		ActiveUUID    string
	}{
		ThemeName:     info.ThemeName,
		Tier:          tierStr,
		SidebarWidth:  session.SidebarWidth,
		MetaWidth:     session.MetaWidth,
		ShowSidebar:   session.ShowSidebar,
		ShowMeta:      session.ShowMeta,
		ShowPrompts:   session.ShowPrompts,
		PromptsHeight: session.PromptsHeight,
		ActiveUUID:    activeUUID,
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
