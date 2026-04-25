package main

import (
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"sieve/requesthandlers"

	"github.com/go-chi/chi/v5"
)

//go:embed ui/templates
var uiTemplates embed.FS

//go:embed ui/static
var uiStatic embed.FS

// apiHandler owns the chi router, templates, SSE hub, and static files.
type apiHandler struct {
	app    *App
	hub    *sseHub
	tmpl   *template.Template
	static http.Handler
	routes *chi.Mux
}

func newAPIHandler(app *App, hub *sseHub) (*apiHandler, error) {
	tmpl := template.New("").Funcs(template.FuncMap{
		"indent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 0.75+float64(depth)*1.0)
		},
		"fileIndent": func(depth int) string {
			return fmt.Sprintf("%.2frem", 1.5+float64(depth)*1.0)
		},
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
	}
	r := chi.NewRouter()
	for _, requestHandler := range requestHandlers {
		requestHandler.RegisterPaths(r)
	}
	r.Get("/sse", h.hub.ServeHTTP)
	r.Handle("/static/*", http.StripPrefix("/static", h.static))
	h.routes = r

	return h, nil
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.routes.ServeHTTP(w, r)
}
