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
	"sieve/sieve/ink"

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
// session whose tabs are the uuids open.
func newSearchServer(t *testing.T, search *recordingSearch, open ...string) *httptest.Server {
	t.Helper()
	h, _ := newTestSettingsHandler(t)
	sp := h.ServiceProvider
	sp.Search = search
	var tabs []domain.Tab
	for _, id := range open {
		tabs = append(tabs, domain.Tab{ID: id})
	}
	if err := sp.State.SaveSession(domain.Session{Tabs: tabs}); err != nil {
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

	var many []domain.Candidate
	var notes, buffers []string
	for i := range quickSwitchLimit + 5 {
		id := ident.New()
		notes = append(notes, id)
		many = append(many, domain.Candidate{URI: domain.NewContainerAddress(id).String(), Title: fmt.Sprintf("Note %d", i), Kind: "note"})
	}
	for i := range 3 {
		id := ident.New()
		buffers = append(buffers, id)
		many = append(many, domain.Candidate{URI: domain.NewContainerAddress(id).String(), Title: fmt.Sprintf("Untitled %d", i+1), Kind: "buffer"})
	}

	for _, tc := range []struct {
		name    string
		path    string
		hits    []domain.Candidate // defaults to hits
		open    []string           // defaults to the buffer
		asked   []domain.SearchCriteria
		renders []string
		rows    []string // when set, the uuids of the rows, in order
	}{
		{
			name:  "sidebar search: what the sidebar shows, on every field",
			path:  "/ui/views/sidebar/search?list_only=true&q=auth",
			asked: []domain.SearchCriteria{{Terms: "auth", Fields: all, Kinds: []string{"note", "digital-note", "buffer"}}},
			renders: []string{"open('" + note + "')", "Auth Design", "design · the auth flow",
				`store-search__badge">Title`, "Content</span>", "open('" + buffer + "')", "Scratch"},
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
			asked:   []domain.SearchCriteria{{Terms: "Aut", Fields: domain.SearchFields{domain.SearchName}}},
			renders: []string{"open('" + note + "')", "open('" + buffer + "')", `quick-switch__path">design`},
		},
		{
			name:    "quick switcher: no query lists everything",
			path:    "/ui/views/search?q=",
			asked:   []domain.SearchCriteria{{Fields: domain.SearchFields{domain.SearchName}}},
			renders: []string{"Auth Design", "Scratch"},
		},
		{
			name:  "quick switcher: what is open leads, in the search's order, and the list is cut to the limit",
			path:  "/ui/views/search?q=",
			hits:  many,
			open:  []string{buffers[1], notes[quickSwitchLimit+2], notes[3]},
			asked: []domain.SearchCriteria{{Fields: domain.SearchFields{domain.SearchName}}},
			rows: append([]string{notes[3], notes[quickSwitchLimit+2], buffers[1]},
				append(notes[:3:3], notes[4:quickSwitchLimit-2]...)...),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tcHits, tcOpen := hits, []string{buffer}
			if tc.hits != nil {
				tcHits, tcOpen = tc.hits, tc.open
			}
			search := &recordingSearch{hits: tcHits}
			body := getBody(t, newSearchServer(t, search, tcOpen...), tc.path)
			if fmt.Sprint(search.asked) != fmt.Sprint(tc.asked) {
				t.Errorf("asked %+v, want %+v", search.asked, tc.asked)
			}
			if tc.rows != nil {
				rows := strings.Split(body, `class="quick-switch__item"`)[1:]
				if len(rows) != len(tc.rows) {
					t.Fatalf("got %d rows, want %d", len(rows), len(tc.rows))
				}
				for i, id := range tc.rows {
					if !strings.Contains(rows[i], "open('"+id+"')") {
						t.Errorf("row %d is not %s:\n%s", i, id, rows[i])
					}
				}
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
	scratch, filed := rows[1], rows[2]
	if strings.Contains(filed, "quick-switch__badge") || !strings.Contains(scratch, "quick-switch__badge") {
		t.Errorf("only the open buffer is marked open:\nfiled: %s\nscratch: %s", filed, scratch)
	}
	if strings.Contains(filed, "M18.5 2.5") || !strings.Contains(scratch, "M18.5 2.5") {
		t.Errorf("only the buffer is drawn with the buffer icon")
	}
}

// Through the search the composition root builds, the sidebar search finds a notebook by its name,
// a word of its summary and a keyword, and the quick switcher lists it.
func TestSearchHandler_FindsANotebook(t *testing.T) {
	srv, sp := newInkServer(t)
	c, err := sp.Containers.Create(ink.KindDigitalNote, map[string]interface{}{"title": "Untitled 05/11"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sp.Containers.SaveMeta(c.UUID(), func(m domain.DocumentMeta) {
		ink.NewDigitalNoteKind().Describe(m, domain.NoteMetadata{Title: "Kitchen plans", Summary: "A rough budget.", Keywords: []string{"extension"}}, 3)
	}); err != nil {
		t.Fatal(err)
	}
	opens := "open('" + c.UUID() + "')"
	for _, tc := range []struct{ path, badge string }{
		{"/ui/views/sidebar/search?list_only=true&q=kitchen", `store-search__badge">Title`},
		{"/ui/views/sidebar/search?list_only=true&q=budget", `store-search__badge">Summary`},
		{"/ui/views/sidebar/search?list_only=true&q=extension", `store-search__badge">Tag`},
		{"/ui/views/search?q=", ""},
		{"/ui/views/search?q=plans", ""},
	} {
		body := getBody(t, srv, tc.path)
		if !strings.Contains(body, opens) || !strings.Contains(body, "Kitchen plans") || !strings.Contains(body, tc.badge) {
			t.Errorf("%s lacks the notebook:\n%s", tc.path, body)
		}
	}
}
