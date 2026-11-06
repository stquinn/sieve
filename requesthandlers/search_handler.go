package requesthandlers

import (
	"html/template"
	"net/http"
	"slices"

	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/ink"

	"github.com/go-chi/chi/v5"
)

// quickSwitchLimit caps the quick switcher's list.
const quickSwitchLimit = 50

type SearchHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (h *SearchHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/search", h.handleSearch)
	r.Get("/ui/views/search/dialog", h.handleSearchPrompt)
	r.Get("/ui/views/sidebar/search", h.handleSidebarSearch)
}

// sidebarCriteria is what the sidebar search asks for: what the sidebar shows —
// filed notes, notebooks and buffers — whose name, summary, tags or content hold q.
func (h *SearchHandler) sidebarCriteria(q string) domain.SearchCriteria {
	return domain.SearchCriteria{
		Terms:  q,
		Fields: domain.SearchFields{domain.SearchName, domain.SearchSummary, domain.SearchTags, domain.SearchContent},
		Kinds:  []string{string(domain.KindNote), ink.KindDigitalNote, string(domain.KindBuffer)},
	}
}

// quickSwitchCriteria is what the quick switcher asks for: everything whose name
// holds q, and with no q everything. It sets no limit: the switcher cuts its list
// only after putting what is open first.
func (h *SearchHandler) quickSwitchCriteria(q string) domain.SearchCriteria {
	return domain.SearchCriteria{
		Terms:  q,
		Fields: domain.SearchFields{domain.SearchName},
	}
}

// search asks the search service, finding nothing when none is wired.
func (h *SearchHandler) search(criteria domain.SearchCriteria) []domain.Candidate {
	if h.ServiceProvider.Search == nil {
		return nil
	}
	return h.ServiceProvider.Search.Search(criteria)
}

func (h *SearchHandler) handleSidebarSearch(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	query := r.URL.Query().Get("q")
	var results []domain.Candidate
	if query != "" {
		results = h.search(h.sidebarCriteria(query))
	}

	data := struct {
		Query   string
		Results []domain.Candidate
	}{
		Query:   query,
		Results: results,
	}

	templateName := "sidebar_search_results.html"
	if r.URL.Query().Get("list_only") == "true" {
		templateName = "sidebar_search_results_list.html"
	}

	if err := h.Tmpl.ExecuteTemplate(w, templateName, data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// switchItem is one row of the quick switcher: a hit, and whether it is open in
// a tab of the session.
type switchItem struct {
	domain.Candidate
	IsOpen bool
}

// openFirst orders the quick switcher's rows with those open in a tab first,
// keeping the search's order within each group, and cuts them to quickSwitchLimit.
func (h *SearchHandler) openFirst(items []switchItem) []switchItem {
	slices.SortStableFunc(items, func(a, b switchItem) int {
		switch {
		case a.IsOpen == b.IsOpen:
			return 0
		case a.IsOpen:
			return -1
		default:
			return 1
		}
	})
	if len(items) > quickSwitchLimit {
		items = items[:quickSwitchLimit]
	}
	return items
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

	query := r.URL.Query().Get("q")

	open := make(map[string]bool)
	for _, t := range h.ServiceProvider.State.LoadSession().Tabs {
		open[t.ID] = true
	}
	var items []switchItem
	for _, hit := range h.search(h.quickSwitchCriteria(query)) {
		items = append(items, switchItem{Candidate: hit, IsOpen: open[hit.Container()]})
	}
	items = h.openFirst(items)

	data := struct {
		Query string
		Items []switchItem
	}{
		Query: query,
		Items: items,
	}

	if err := h.Tmpl.ExecuteTemplate(w, "quickswitcher_list.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
