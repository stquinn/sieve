package requesthandlers

import (
	"html/template"
	"net/http"
	"strings"

	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type SearchHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (h *SearchHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/search", h.handleSearch)
	r.Get("/api/search-prompt", h.handleSearchPrompt)
}

type switchItem struct {
	ID          string
	Name        string
	DisplayPath string
	Icon        string // "buffer" or "note"
	IsOpen      bool
}

func flattenNotes(entries []sieve.NoteEntry, currentPath string) []switchItem {
	var list []switchItem
	for _, entry := range entries {
		if entry.IsDir {
			list = append(list, flattenNotes(entry.Children, currentPath+entry.Name+"/")...)
		} else {
			name := entry.DisplayName
			if name == "" {
				name = entry.Name
			}
			list = append(list, switchItem{
				ID:          entry.ID,
				Name:        name,
				DisplayPath: currentPath + entry.Name + ".md",
				Icon:        "note",
			})
		}
	}
	return list
}

func (h *SearchHandler) handleSearchPrompt(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if err := h.Tmpl.ExecuteTemplate(w, "quickswitcher.html", nil); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func (h *SearchHandler) handleSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	query := strings.ToLower(r.URL.Query().Get("q"))

	session := h.ServiceProvider.State.LoadSession()
	entries, err := h.ServiceProvider.Notes.List()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	openIDs := make(map[string]bool)
	for _, t := range session.Tabs {
		openIDs[t.ID] = true
	}

	var buffers []switchItem
	for _, t := range session.Tabs {
		if t.Status != "filed" {
			name := t.DisplayName
			if name == "" {
				name = "Buffer"
			}
			buffers = append(buffers, switchItem{
				ID:          t.ID,
				Name:        name,
				DisplayPath: "",
				Icon:        "buffer",
				IsOpen:      true,
			})
		}
	}

	allNotes := flattenNotes(entries, "")
	for i := range allNotes {
		if openIDs[allNotes[i].ID] {
			allNotes[i].IsOpen = true
		}
	}

	itemsMap := make(map[string]switchItem)
	for _, b := range buffers {
		itemsMap[b.ID] = b
	}
	for _, n := range allNotes {
		if existing, ok := itemsMap[n.ID]; ok {
			existing.IsOpen = true
			itemsMap[n.ID] = existing
		} else {
			itemsMap[n.ID] = n
		}
	}

	var allItems []switchItem
	for _, item := range itemsMap {
		if query == "" || strings.Contains(strings.ToLower(item.Name), query) || strings.Contains(strings.ToLower(item.DisplayPath), query) {
			allItems = append(allItems, item)
		}
	}

	// Cap results
	if len(allItems) > 50 {
		allItems = allItems[:50]
	}

	data := struct {
		Query string
		Items []switchItem
	}{
		Query: query,
		Items: allItems,
	}

	if err := h.Tmpl.ExecuteTemplate(w, "quickswitcher_list.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
