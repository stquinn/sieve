package main

import (
	"embed"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"sieve/sieve"
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

	r := chi.NewRouter()
	r.Get("/api/sidebar", h.handleSidebar)
	r.Get("/sse", h.hub.ServeHTTP)
	r.Handle("/static/*", http.StripPrefix("/static", h.static))
	h.routes = r

	return h, nil
}

func (h *apiHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.routes.ServeHTTP(w, r)
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

type sidebarEntry struct {
	ID          string
	Name        string
	DisplayName string
	UserIntent  string
	Status      string
	IsDir       bool
	IsOpen      bool
	Children    []sidebarEntry
	Depth       int
}

func prepSidebarEntries(entries []sieve.NoteEntry, openFolders map[string]bool, depth int) []sidebarEntry {
	out := make([]sidebarEntry, 0, len(entries))
	for _, e := range entries {
		se := sidebarEntry{
			ID:          e.ID,
			Name:        e.Name,
			DisplayName: e.DisplayName,
			UserIntent:  e.UserIntent,
			Status:      e.Status,
			IsDir:       e.IsDir,
			IsOpen:      e.IsDir && openFolders[e.ID],
			Depth:       depth,
		}
		if se.IsOpen && len(e.Children) > 0 {
			se.Children = prepSidebarEntries(e.Children, openFolders, depth+1)
		}
		out = append(out, se)
	}
	return out
}

func (h *apiHandler) handleSidebar(w http.ResponseWriter, r *http.Request) {
	if h.app.notes == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `<div class="sidebar__empty">No store open</div>`)
		return
	}

	entries, err := h.app.notes.List()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	openFolders := parseFolderCookie(r)

	if toggle := r.URL.Query().Get("toggle"); toggle != "" {
		if openFolders[toggle] {
			delete(openFolders, toggle)
		} else {
			openFolders[toggle] = true
		}
		ids := make([]string, 0, len(openFolders))
		for id := range openFolders {
			ids = append(ids, id)
		}
		http.SetCookie(w, &http.Cookie{
			Name:  "open_folders",
			Value: strings.Join(ids, ","),
			Path:  "/",
		})
	}

	data := prepSidebarEntries(entries, openFolders, 0)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.tmpl.ExecuteTemplate(w, "sidebar.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func parseFolderCookie(r *http.Request) map[string]bool {
	result := map[string]bool{}
	cookie, err := r.Cookie("open_folders")
	if err != nil {
		return result
	}
	for _, id := range strings.Split(cookie.Value, ",") {
		if id != "" {
			result[id] = true
		}
	}
	return result
}
