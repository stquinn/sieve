package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type SideBarHandler struct {
	Notes **sieve.NoteService
	State **sieve.StateService
	Tmpl  *template.Template
}

func (s *SideBarHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/sidebar", s.handleSidebar)
	r.Post("/api/sidebar", s.handleSidebar)
}

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

// RenderSidebar writes the sidebar HTML fragment to w. It is shared by the
// sidebar handler and any action handler that needs to return a refreshed tree.
func RenderSidebar(w http.ResponseWriter, notes *sieve.NoteService, state *sieve.StateService, tmpl *template.Template) {
	if notes == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<div class="sidebar__empty">No store open</div>`)
		return
	}

	session := state.LoadSession()
	openFolders := make(map[string]bool, len(session.OpenFolders))
	for _, id := range session.OpenFolders {
		openFolders[id] = true
	}

	entries, err := notes.List()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	data := prepSidebarEntries(entries, openFolders, 0)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := tmpl.ExecuteTemplate(w, "sidebar.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *SideBarHandler) handleSidebar(w http.ResponseWriter, r *http.Request) {
	notes := *s.Notes
	state := *s.State

	if notes == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `<div class="sidebar__empty">No store open</div>`)
		return
	}

	if toggle := r.URL.Query().Get("toggle"); toggle != "" {
		session := state.LoadSession()
		session.OpenFolders = toggleFolder(session.OpenFolders, toggle)
		_ = state.SaveSession(session)
	}

	RenderSidebar(w, notes, state, s.Tmpl)
}

func toggleFolder(folders []string, id string) []string {
	for i, f := range folders {
		if f == id {
			return append(folders[:i], folders[i+1:]...)
		}
	}
	return append(folders, id)
}
