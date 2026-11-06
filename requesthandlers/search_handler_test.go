package requesthandlers

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"sieve/ident"
	"sieve/sieve/domain"

	"github.com/go-chi/chi/v5"
)

// recordingSearch is a domain.SearchService double: it records every criteria it
// is asked with and answers a fixed list of hits.
type recordingSearch struct {
	hits  []domain.Candidate
	asked []domain.SearchCriteria
}

func (s *recordingSearch) Search(criteria domain.SearchCriteria) []domain.Candidate {
	s.asked = append(s.asked, criteria)
	return s.hits
}

// newSearchServer serves the search handler over a recording search, with a
// session whose one tab is the uuid open.
func newSearchServer(t *testing.T, search *recordingSearch, open string) *httptest.Server {
	t.Helper()
	h, _ := newTestSettingsHandler(t)
	sp := h.ServiceProvider
	sp.Search = search
	if err := sp.State.SaveSession(domain.Session{Tabs: []domain.Tab{{ID: open, Kind: string(domain.KindBuffer)}}}); err != nil {
		t.Fatalf("SaveSession: %v", err)
	}
	r := chi.NewRouter()
	(&SearchHandler{ServiceProvider: sp, Tmpl: h.Tmpl}).RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func getBody(t *testing.T, srv *httptest.Server, path string) string {
	t.Helper()
	resp, err := http.Get(srv.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %d %s", path, resp.StatusCode, body)
	}
	return string(body)
}

// Each finding view asks the search service for what it shows, and renders the
// hits it is given.
func TestSearchHandler_EachViewAsksForWhatItShows(t *testing.T) {
	note, buffer := ident.New(), ident.New()
	hits := []domain.Candidate{
		{URI: domain.NewContainerAddress(note).String(), Title: "Auth Design", Kind: "note",
			Detail: "design · the auth flow", Folder: "design", Matched: domain.SearchFields{domain.SearchName, domain.SearchContent}},
		{URI: domain.NewContainerAddress(buffer).String(), Title: "Scratch", Kind: "buffer"},
	}
	all := domain.SearchFields{domain.SearchName, domain.SearchSummary, domain.SearchTags, domain.SearchContent}
	for _, tc := range []struct {
		name    string
		path    string
		asked   []domain.SearchCriteria
		renders []string
	}{
		{
			name:  "sidebar search: what the sidebar shows, on every field",
			path:  "/ui/views/sidebar/search?list_only=true&q=auth",
			asked: []domain.SearchCriteria{{Terms: "auth", Fields: all, Kinds: []string{"note", "digital-note"}}},
			renders: []string{"open('" + note + "')", "Auth Design", "design · the auth flow",
				`store-search__badge">Title`, "Content</span>"},
		},
		{
			name:    "sidebar search: no query asks nothing",
			path:    "/ui/views/sidebar/search?q=",
			asked:   nil,
			renders: []string{"Enter a query to search the library"},
		},
		{
			name:    "quick switcher: everything by name",
			path:    "/ui/views/search?q=Aut",
			asked:   []domain.SearchCriteria{{Terms: "Aut", Fields: domain.SearchFields{domain.SearchName}, Limit: quickSwitchLimit}},
			renders: []string{"open('" + note + "')", "open('" + buffer + "')", `quick-switch__path">design`},
		},
		{
			name:    "quick switcher: no query lists everything",
			path:    "/ui/views/search?q=",
			asked:   []domain.SearchCriteria{{Fields: domain.SearchFields{domain.SearchName}, Limit: quickSwitchLimit}},
			renders: []string{"Auth Design", "Scratch"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			search := &recordingSearch{hits: hits}
			body := getBody(t, newSearchServer(t, search, buffer), tc.path)
			if fmt.Sprint(search.asked) != fmt.Sprint(tc.asked) {
				t.Errorf("asked %+v, want %+v", search.asked, tc.asked)
			}
			for _, want := range tc.renders {
				if !strings.Contains(body, want) {
					t.Errorf("body lacks %q:\n%s", want, body)
				}
			}
		})
	}
}

// The quick switcher marks what is open in a tab — session state laid over the
// hits — and draws a buffer with its own icon.
func TestSearchHandler_QuickSwitcherMarksWhatIsOpen(t *testing.T) {
	note, buffer := ident.New(), ident.New()
	search := &recordingSearch{hits: []domain.Candidate{
		{URI: domain.NewContainerAddress(note).String(), Title: "Filed", Kind: "note"},
		{URI: domain.NewContainerAddress(buffer).String(), Title: "Scratch", Kind: "buffer"},
	}}
	body := getBody(t, newSearchServer(t, search, buffer), "/ui/views/search?q=")

	rows := strings.Split(body, `class="quick-switch__item"`)
	if len(rows) != 3 {
		t.Fatalf("want two rows, got:\n%s", body)
	}
	filed, scratch := rows[1], rows[2]
	if strings.Contains(filed, "quick-switch__badge") || !strings.Contains(scratch, "quick-switch__badge") {
		t.Errorf("only the open buffer is marked open:\nfiled: %s\nscratch: %s", filed, scratch)
	}
	if strings.Contains(filed, "M18.5 2.5") || !strings.Contains(scratch, "M18.5 2.5") {
		t.Errorf("only the buffer is drawn with the buffer icon")
	}
}
