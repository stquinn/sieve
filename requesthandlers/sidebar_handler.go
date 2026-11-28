package requesthandlers

import (
	"fmt"
	"html/template"
	"math"
	"net/http"
	"slices"
	"time"

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
	r.Get("/ui/views/sidebar/chats", s.handleChats)
}

// chatsTreeID is the Chats item's id among the tree's expanded folders
// (domain.Session.OpenFolders). A folder's id is a uuid, so it is never this.
const chatsTreeID = "chats"

// chatsSidebarView is the payload of chats_sidebar.html, the Chats item directly
// after the Diary, which is there also when no chat is.
type chatsSidebarView struct {
	// ID is the item's id among the expanded folders; Open is its being expanded.
	ID   string
	Open bool
	// Groups are the chats, most recently changed first, under the headings of
	// chatsSidebarView.dayGroup, each group holding at least one chat.
	Groups []chatGroup
}

// chatGroup is a run of the Chats item's rows under one quiet heading.
type chatGroup struct {
	Heading string
	Chats   []chatItem
}

// The headings the Chats item's rows are grouped under, in the order they are
// shown.
const (
	chatsToday     = "Today"
	chatsYesterday = "Yesterday"
	chatsEarlier   = "Earlier"
)

// chatItem is a chat as the sidebar lists it.
type chatItem struct {
	UUID string
	// Title is the chat's name, the one its tab shows.
	Title string
	// When is the quiet time at the row's right that says when the chat last
	// changed (chatsSidebarView.changedAt); empty when that is not known.
	When   string
	Active bool
}

// chatCriteria is what the Chats item asks the search for: every chat.
func (s SideBarHandler) chatCriteria() domain.SearchCriteria {
	return domain.SearchCriteria{
		Fields: domain.SearchFields{domain.SearchName},
		Kinds:  []string{domain.ChatKind},
	}
}

// chats is the Chats item as session shows it; no chats when no search is wired.
func (s SideBarHandler) chats(session domain.Session) chatsSidebarView {
	var hits []domain.Candidate
	if s.ServiceProvider.Search != nil {
		hits = s.ServiceProvider.Search.Search(s.chatCriteria())
	}
	var v chatsSidebarView
	v.show(hits, session, time.Now())
	return v
}

// show fills the view with hits, newest first as the search answers them, as the
// tree's Chats item shows them in session at now: expanded as session remembers
// it, grouped by the day each chat last changed (dayGroup), the active tab's row
// marked, each row saying when its chat last changed.
func (v *chatsSidebarView) show(hits []domain.Candidate, session domain.Session, now time.Time) {
	active := session.ActiveID()
	*v = chatsSidebarView{ID: chatsTreeID, Open: slices.Contains(session.OpenFolders, chatsTreeID)}
	grouped := map[string][]chatItem{}
	for _, hit := range hits {
		id := hit.Container()
		heading := v.dayGroup(hit.Modified, now)
		grouped[heading] = append(grouped[heading], chatItem{UUID: id, Title: hit.Title, When: v.changedAt(hit.Modified, now), Active: id != "" && id == active})
	}
	for _, heading := range []string{chatsToday, chatsYesterday, chatsEarlier} {
		if chats := grouped[heading]; len(chats) > 0 {
			v.Groups = append(v.Groups, chatGroup{Heading: heading, Chats: chats})
		}
	}
}

// dayGroup is the heading a chat that last changed at modified (RFC 3339) is
// listed under at now, in now's zone: chatsToday on now's day, chatsYesterday on
// the day before, and chatsEarlier before that, after now's day, or when modified
// does not parse.
func (v chatsSidebarView) dayGroup(modified string, now time.Time) string {
	at, err := time.Parse(time.RFC3339, modified)
	if err != nil {
		return chatsEarlier
	}
	switch v.daysBefore(at, now) {
	case 0:
		return chatsToday
	case 1:
		return chatsYesterday
	default:
		return chatsEarlier
	}
}

// daysBefore is how many calendar days in now's zone at falls before now's day; 0
// on now's day, below 0 after it.
func (v chatsSidebarView) daysBefore(at, now time.Time) int {
	at = at.In(now.Location())
	day := func(t time.Time) time.Time { return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()) }
	return int(math.Round(day(now).Sub(day(at)).Hours() / 24))
}

// changedAt is when a chat last changed, modified (RFC 3339), as its row says it
// at now, in now's zone: the time ("14:02") on now's day, the weekday ("Mon") on
// any of the six days before it, and the day and month ("21 Aug") before that or
// after now's day. It is empty when modified does not parse.
func (v chatsSidebarView) changedAt(modified string, now time.Time) string {
	at, err := time.Parse(time.RFC3339, modified)
	if err != nil {
		return ""
	}
	days := v.daysBefore(at, now)
	at = at.In(now.Location())
	switch {
	case days == 0:
		return at.Format("15:04")
	case days > 0 && days < 7:
		return at.Format("Mon")
	default:
		return at.Format("2 Jan")
	}
}

// handleChats writes the Chats item of the sidebar's tree, which the tree also
// renders in place.
func (s *SideBarHandler) handleChats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if s.ServiceProvider.State == nil {
		return
	}
	if err := s.Tmpl.ExecuteTemplate(w, "chats_sidebar.html", s.chats(s.ServiceProvider.State.LoadSession())); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
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

// sidebarTree is the payload of sidebar.html: the Ink, Diary and Chats items above
// the library's tree and the Buffers item below it.
type sidebarTree struct {
	Ink     inkSidebarView
	Diary   diarySidebarView
	Chats   chatsSidebarView
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

	data := sidebarTree{Entries: prepSidebarEntries(entries, openFolders, 0, "", activeID), Chats: s.chats(session), Buffers: s.buffers(session)}
	if s.ServiceProvider.Ink != nil {
		st := s.ServiceProvider.Ink.Status()
		data.Ink.show(st, session)
		data.Diary.show(st, session)
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
