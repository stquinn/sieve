package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"slices"

	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/services"

	"github.com/go-chi/chi/v5"
)

type SideBarHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (s *SideBarHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/sidebar", s.handleSidebar)
	r.Get("/ui/views/sidebar/buffers", s.handleBuffers)
}

// buffersTreeID is the Buffers item's id among the tree's expanded folders
// (domain.Session.OpenFolders). A folder's id is a uuid, so it is never this.
const buffersTreeID = "buffers"

// buffersSidebarView is the payload of buffers_sidebar.html, the Buffers item at
// the foot of the sidebar's tree, which is there also when it holds nothing.
type buffersSidebarView struct {
	// ID is the item's id among the expanded folders; Open is its being expanded.
	ID      string
	Open    bool
	Buffers []bufferItem
}

// bufferItem is a buffer as the sidebar lists it.
type bufferItem struct {
	UUID string
	// Title is the buffer's display name, the one its tab shows.
	Title string
	// Intent is the user_intent its open tab carries; empty for a buffer not open.
	Intent string
	Active bool
}

// bufferCriteria is what the Buffers item asks the search for: every buffer.
func (s SideBarHandler) bufferCriteria() domain.SearchCriteria {
	return domain.SearchCriteria{
		Fields: domain.SearchFields{domain.SearchName},
		Kinds:  []string{string(domain.KindBuffer)},
	}
}

// buffers is the Buffers item as session shows it; no buffers when no search is wired.
func (s SideBarHandler) buffers(session domain.Session) buffersSidebarView {
	var hits []domain.Candidate
	if s.ServiceProvider.Search != nil {
		hits = s.ServiceProvider.Search.Search(s.bufferCriteria())
	}
	var v buffersSidebarView
	v.show(hits, session)
	return v
}

// show fills the view with hits as the tree's Buffers item shows them in session:
// expanded as session remembers it, the active tab's row marked.
func (v *buffersSidebarView) show(hits []domain.Candidate, session domain.Session) {
	intents := make(map[string]string, len(session.Tabs))
	for _, t := range session.Tabs {
		intents[t.ID] = t.UserIntent
	}
	active := session.ActiveID()
	*v = buffersSidebarView{ID: buffersTreeID, Open: slices.Contains(session.OpenFolders, buffersTreeID)}
	v.Buffers = make([]bufferItem, 0, len(hits))
	for _, hit := range hits {
		id := hit.Container()
		v.Buffers = append(v.Buffers, bufferItem{UUID: id, Title: hit.Title, Intent: intents[id], Active: id != "" && id == active})
	}
}

// handleBuffers writes the Buffers item of the sidebar's tree, which the tree
// also renders in place.
func (s *SideBarHandler) handleBuffers(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if s.ServiceProvider.State == nil {
		return
	}
	if err := s.Tmpl.ExecuteTemplate(w, "buffers_sidebar.html", s.buffers(s.ServiceProvider.State.LoadSession())); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

type sidebarEntry struct {
	ID          string
	Name        string
	DisplayName string
	UserIntent  string
	Status      string
	IsDir       bool
	IsOpen      bool
	IsActive    bool
	Children    []sidebarEntry
	Depth       int
	ParentID    string
}

func prepSidebarEntries(entries []services.NoteEntry, openFolders map[string]bool, depth int, parentId string, activeID string) []sidebarEntry {
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
			IsActive:    !e.IsDir && e.ID == activeID,
			Depth:       depth,
			ParentID:    parentId,
		}
		if se.IsOpen && len(e.Children) > 0 {
			se.Children = prepSidebarEntries(e.Children, openFolders, depth+1, e.ID, activeID)
		}
		out = append(out, se)
	}
	return out
}

// sidebarTree is the payload of sidebar.html: the Ink item above the library's
// tree and the Buffers item below it.
type sidebarTree struct {
	Ink     inkSidebarView
	Entries []sidebarEntry
	Buffers buffersSidebarView
}

// Render writes the sidebar HTML fragment to w. It is shared by the sidebar
// handler and any action handler that needs to return a refreshed tree.
func (s SideBarHandler) Render(w http.ResponseWriter) {
	notes, state := s.ServiceProvider.Documents, s.ServiceProvider.State
	w.Header().Set("Cache-Control", "no-store")
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

	var activeID string
	if session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeID = session.Tabs[session.ActiveIdx].ID
	}

	entries, err := notes.List()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	data := sidebarTree{Entries: prepSidebarEntries(entries, openFolders, 0, "", activeID), Buffers: s.buffers(session)}
	if s.ServiceProvider.Ink != nil {
		data.Ink.show(s.ServiceProvider.Ink.Status(), session)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.Tmpl.ExecuteTemplate(w, "sidebar.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (s *SideBarHandler) handleSidebar(w http.ResponseWriter, r *http.Request) {
	if s.ServiceProvider.Documents == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `<div class="sidebar__empty">No store open</div>`)
		return
	}

	s.Render(w)
}
