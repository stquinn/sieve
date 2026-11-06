package requesthandlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/ink"
	"sieve/sieve/ink/radio"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// newTestSettingsHandler builds a SettingsHandler backed by a real FileStore in
// a temp dir (so we can inspect the persisted settings.json on disk afterwards)
// and the real embedded templates, parsed from the repo tree via os.DirFS — the
// same *.html files the app serves, so this proves the actual save round-trip,
// not a stand-in.
func newTestSettingsHandler(t *testing.T) (*SettingsHandler, string) {
	t.Helper()
	dir := t.TempDir()
	fs, err := filestore.NewFileStore(dir, "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	state, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatalf("NewTemplates: %v", err)
	}
	sp := &sieve.ServiceProvider{Store: fs, State: state}
	return &SettingsHandler{ServiceProvider: sp, Tmpl: tmpl}, dir
}

// parseHeaders (settings_handler.go) is the inverse of the settings-panel
// template's joinHeaders func: "Key=Value,Key2=Value2" -> map[string]string.
func TestParseHeaders(t *testing.T) {
	h := &SettingsHandler{}
	cases := []struct {
		name string
		in   string
		want map[string]string
	}{
		{"empty", "", nil},
		{"single", "X-Api-Key=abc123", map[string]string{"X-Api-Key": "abc123"}},
		{"multiple", "A=1,B=2", map[string]string{"A": "1", "B": "2"}},
		{"trims whitespace", " A = 1 , B = 2 ", map[string]string{"A": "1", "B": "2"}},
		{"value may contain equals", "Authorization=Bearer tok=en", map[string]string{"Authorization": "Bearer tok=en"}},
		{"skips malformed entries", "noequalshere,A=1", map[string]string{"A": "1"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := h.parseHeaders(c.in)
			if len(got) != len(c.want) {
				t.Fatalf("parseHeaders(%q) = %+v, want %+v", c.in, got, c.want)
			}
			for k, v := range c.want {
				if got[k] != v {
					t.Errorf("parseHeaders(%q)[%q] = %q, want %q", c.in, k, got[k], v)
				}
			}
		})
	}
}

// End-to-end over the REAL /api/settings save route: saving one user stdio MCP
// server and one user http MCP server persists both — url+headers on the http
// server survive to disk, and the builtin "sieve" server (always Baseline) is
// never written to settings.json.
func TestSettingsSaveRoute_PersistsStdioAndHTTPMcpServers(t *testing.T) {
	h, dir := newTestSettingsHandler(t)
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	form := url.Values{
		"cli":                       {"claude"},
		"cli_timeout_long":          {"20"},
		"containment_mcp_name":      {"forgejo", "docs"},
		"containment_mcp_transport": {"stdio", "http"},
		"containment_mcp_command":   {"forgejo-mcp", ""},
		"containment_mcp_args":      {"serve --stdio", ""},
		"containment_mcp_url":       {"", "https://docs.example.com/mcp"},
		"containment_mcp_headers":   {"", "X-Api-Key=secret1,X-Team=eng"},
		"last_settings_panel":       {"aiaccess"},
	}

	resp, err := http.PostForm(srv.URL+"/api/settings", form)
	if err != nil {
		t.Fatalf("POST /api/settings: %v", err)
	}
	// Drain the body before closing: the handler streams a template + trailing
	// <script> tag, and an early Close on an undrained body races the server's
	// write with a client-side RST (a "broken pipe" false alarm, not a real bug).
	_, _ = io.Copy(io.Discard, resp.Body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	// Verify via the in-memory reload path first.
	saved := h.ServiceProvider.State.LoadSettings()
	var forgejo, docs domain.McpGrant
	var foundForgejo, foundDocs bool
	for _, m := range saved.AI.Containment.McpServers {
		switch m.Name {
		case "forgejo":
			forgejo, foundForgejo = m, true
		case "docs":
			docs, foundDocs = m, true
		}
	}
	if !foundForgejo || !foundDocs {
		t.Fatalf("McpServers = %+v, want forgejo+docs present", saved.AI.Containment.McpServers)
	}
	if forgejo.EffectiveTransport() != "stdio" || forgejo.Command != "forgejo-mcp" {
		t.Errorf("forgejo = %+v, want stdio/forgejo-mcp", forgejo)
	}
	if len(forgejo.Args) != 2 || forgejo.Args[0] != "serve" || forgejo.Args[1] != "--stdio" {
		t.Errorf("forgejo.Args = %v, want [serve --stdio]", forgejo.Args)
	}
	if docs.EffectiveTransport() != "http" || docs.URL != "https://docs.example.com/mcp" {
		t.Errorf("docs = %+v, want http/https://docs.example.com/mcp", docs)
	}
	if docs.Headers["X-Api-Key"] != "secret1" || docs.Headers["X-Team"] != "eng" {
		t.Errorf("docs.Headers = %+v, want X-Api-Key=secret1,X-Team=eng", docs.Headers)
	}

	// Now inspect settings.json ON DISK directly — proves the persisted form,
	// not just what LoadSettings reconstructs, and proves the builtin sieve
	// server (Baseline:true, WithoutBaseline-stripped) never lands in the file.
	raw := readSettingsJSON(t, dir)
	if strings.Contains(raw, `"sieve"`) {
		t.Errorf("settings.json must never contain the builtin sieve MCP server: %s", raw)
	}
	if !strings.Contains(raw, "forgejo-mcp") || !strings.Contains(raw, "docs.example.com") {
		t.Errorf("settings.json missing persisted MCP servers: %s", raw)
	}
	if !strings.Contains(raw, "secret1") {
		t.Errorf("settings.json missing persisted header value: %s", raw)
	}

	var onDisk struct {
		AI struct {
			Containment struct {
				McpServers []domain.McpGrant `json:"mcpServers"`
			} `json:"containment"`
		} `json:"ai"`
	}
	if err := json.Unmarshal([]byte(raw), &onDisk); err != nil {
		t.Fatalf("settings.json not valid JSON: %v\n%s", err, raw)
	}
	if len(onDisk.AI.Containment.McpServers) != 2 {
		t.Fatalf("on-disk mcpServers = %+v, want exactly 2 (user additions only)", onDisk.AI.Containment.McpServers)
	}
}

// End-to-end over the REAL /api/settings save route: a typed tool grant (#41)
// parses verb + type + constraint into a ToolGrant whose Names table is keyed on
// the ACTIVE CLI, and renders through to the claude allow list. A file-type write
// grant becomes a scoped Edit rule; a network grant carries its domain constraint.
func TestSettingsSaveRoute_ParsesTypedToolGrants(t *testing.T) {
	h, dir := newTestSettingsHandler(t)
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	form := url.Values{
		"cli":              {"claude"},
		"cli_timeout_long": {"20"},
		// Two typed tool rows: a file write (claude verb Edit) and a network fetch
		// scoped to a domain. The file row's constraint is empty (auto-scoped).
		"containment_tool_name":       {"Edit", "Curl"},
		"containment_tool_type":       {"file", "network"},
		"containment_tool_constraint": {"", "api.example.com, docs.rs"},
		"last_settings_panel":         {"aiaccess"},
	}

	resp, err := http.PostForm(srv.URL+"/api/settings", form)
	if err != nil {
		t.Fatalf("POST /api/settings: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	saved := h.ServiceProvider.State.LoadSettings()
	var edit, curl domain.ToolGrant
	var foundEdit, foundCurl bool
	for _, g := range saved.AI.Containment.Tools {
		switch g.Label {
		case "Edit":
			edit, foundEdit = g, true
		case "Curl":
			curl, foundCurl = g, true
		}
	}
	if !foundEdit || !foundCurl {
		t.Fatalf("Tools = %+v, want Edit+Curl user grants", saved.AI.Containment.Tools)
	}
	if edit.Type != "file" || edit.Names["claude"] != "Edit" {
		t.Errorf("edit grant = %+v, want type=file names[claude]=Edit", edit)
	}
	if edit.Constraint != "" {
		t.Errorf("file grant constraint = %q, want empty (auto-scoped)", edit.Constraint)
	}
	if curl.Type != "network" || curl.Names["claude"] != "Curl" {
		t.Errorf("curl grant = %+v, want type=network names[claude]=Curl", curl)
	}
	if !strings.Contains(curl.Constraint, "api.example.com") {
		t.Errorf("network grant constraint = %q, want the domains", curl.Constraint)
	}

	// The persisted form holds only the user additions (baselines stripped).
	raw := readSettingsJSON(t, dir)
	if !strings.Contains(raw, `"Edit"`) || !strings.Contains(raw, "api.example.com") {
		t.Errorf("settings.json missing typed tool grants: %s", raw)
	}
}

// End-to-end over the REAL /api/settings save route: the diagram settings
// family (PlantUML server URL + default diagram language) persists like any
// other flat field — no containment-style overlay/rebuild needed.
func TestSettingsSaveRoute_PersistsDiagramSettings(t *testing.T) {
	h, dir := newTestSettingsHandler(t)
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	form := url.Values{
		"cli":                     {"claude"},
		"cli_timeout_long":        {"20"},
		"diagram_plantuml_server": {"https://plantuml.example.com"},
		"diagram_default_type":    {"plantuml"},
		"last_settings_panel":     {"diagrams"},
	}

	resp, err := http.PostForm(srv.URL+"/api/settings", form)
	if err != nil {
		t.Fatalf("POST /api/settings: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	saved := h.ServiceProvider.State.LoadSettings()
	if saved.Diagram.PlantumlServer != "https://plantuml.example.com" {
		t.Errorf("Diagram.PlantumlServer = %q, want https://plantuml.example.com", saved.Diagram.PlantumlServer)
	}
	if saved.Diagram.DefaultType != "plantuml" {
		t.Errorf("Diagram.DefaultType = %q, want plantuml", saved.Diagram.DefaultType)
	}

	raw := readSettingsJSON(t, dir)
	if !strings.Contains(raw, "plantuml.example.com") {
		t.Errorf("settings.json missing persisted diagram server: %s", raw)
	}
}

// End-to-end over the REAL /api/settings save route: cli_path persists (trimmed)
// as a flat field alongside the provider enum, so a custom wrapper path survives
// to disk while the cli dropdown keeps driving the dialect.
func TestSettingsSaveRoute_PersistsCLIPath(t *testing.T) {
	h, dir := newTestSettingsHandler(t)
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)

	form := url.Values{
		"cli":                 {"claude"},
		"cli_path":            {"  /opt/bin/claude-query.sh  "},
		"cli_timeout_long":    {"20"},
		"last_settings_panel": {"ai"},
	}

	resp, err := http.PostForm(srv.URL+"/api/settings", form)
	if err != nil {
		t.Fatalf("POST /api/settings: %v", err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	saved := h.ServiceProvider.State.LoadSettings()
	if saved.CLIPath != "/opt/bin/claude-query.sh" {
		t.Errorf("CLIPath = %q, want trimmed /opt/bin/claude-query.sh", saved.CLIPath)
	}
	if saved.CLI != "claude" {
		t.Errorf("CLI = %q, want claude (dropdown still drives the dialect)", saved.CLI)
	}
	// The resolved pair proves the wrapper is the executable while claude stays the dialect.
	binary, dialect := saved.ResolveCLI()
	if binary != "/opt/bin/claude-query.sh" || dialect != "claude" {
		t.Errorf("ResolveCLI = %q/%q, want /opt/bin/claude-query.sh/claude", binary, dialect)
	}

	raw := readSettingsJSON(t, dir)
	if !strings.Contains(raw, "claude-query.sh") {
		t.Errorf("settings.json missing persisted cli_path: %s", raw)
	}
}

// withLearnedWords wires a spell inspector into h whose dictionary persists
// through h's own StateService, and teaches it words.
func withLearnedWords(t *testing.T, h *SettingsHandler, words ...string) {
	t.Helper()
	sp := h.ServiceProvider
	ds, err := services.NewDocumentService(sp.Store)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	sp.Editor = editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), time.Hour)
	sp.Inspection = editor.NewInspectionEngine(sp.Editor)
	sp.RegisterInspectors(services.NewSpellService(sp.State))
	for _, word := range words {
		sp.Spell.Learn(word)
	}
}

// The Spelling tab lists the learned words as form rows, and Save unlearns the
// rows the user removed — only when the tab was rendered, and never learning a
// posted word.
func TestSettingsSaveRoute_UnlearnsRemovedSpellingRows(t *testing.T) {
	cases := []struct {
		name string
		form url.Values
		want []string
	}{
		{name: "an omitted row is unlearned", form: url.Values{"spell_learned_listed": {"1"}, "spell_learned": {"zzquux"}}, want: []string{"zzquux"}},
		{name: "removing every row unlearns all", form: url.Values{"spell_learned_listed": {"1"}}, want: []string{}},
		{name: "no sentinel leaves the dictionary alone", form: url.Values{}, want: []string{"zzblorp", "zzquux"}},
		{name: "a posted unknown word is not learned", form: url.Values{"spell_learned_listed": {"1"}, "spell_learned": {"zzblorp", "zzquux", "zznew"}}, want: []string{"zzblorp", "zzquux"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newTestSettingsHandler(t)
			withLearnedWords(t, h, "zzblorp", "zzquux")
			r := chi.NewRouter()
			h.RegisterPaths(r)
			srv := httptest.NewServer(r)
			t.Cleanup(srv.Close)

			before, err := http.Get(srv.URL + "/ui/views/settings")
			if err != nil {
				t.Fatalf("GET settings: %v", err)
			}
			page, _ := io.ReadAll(before.Body)
			before.Body.Close()
			for _, word := range []string{"zzblorp", "zzquux"} {
				if !strings.Contains(string(page), `name="spell_learned" value="`+word+`"`) {
					t.Errorf("dialog does not list learned word %q", word)
				}
			}

			form := tc.form
			form.Set("cli", "claude")
			form.Set("cli_timeout_long", "20")
			resp, err := http.PostForm(srv.URL+"/api/settings", form)
			if err != nil {
				t.Fatalf("POST /api/settings: %v", err)
			}
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d, want 200", resp.StatusCode)
			}

			if got := h.ServiceProvider.Spell.Learned(); !slices.Equal(got, tc.want) {
				t.Errorf("Learned() = %v, want %v", got, tc.want)
			}
			if got := services.NewSpellService(h.ServiceProvider.State).Learned(); !slices.Equal(got, tc.want) {
				t.Errorf("persisted dictionary = %v, want %v", got, tc.want)
			}
		})
	}
}

// readSettingsJSON locates and reads the state category's settings.json under
// the FileStore root created by newTestSettingsHandler.
func readSettingsJSON(t *testing.T, root string) string {
	t.Helper()
	var found string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && d.Name() == "settings.json" {
			found = path
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if found == "" {
		t.Fatalf("settings.json not found under %s", root)
	}
	b, err := os.ReadFile(found)
	if err != nil {
		t.Fatalf("read %s: %v", found, err)
	}
	return string(b)
}

// holdingRadio is a radio whose every scan finds nothing until it is cancelled.
type holdingRadio struct{}

func (holdingRadio) Dial(ctx context.Context) (radio.Link, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

// newInkServer serves the settings and Ink handlers over one store, with Ink built over a radio
// that never finds a companion.
func newInkServer(t *testing.T) (*httptest.Server, *sieve.ServiceProvider) {
	t.Helper()
	h, _ := newTestSettingsHandler(t)
	sp := h.ServiceProvider
	block.RegisterProcessor(ink.NewDigitalNoteKind())
	containers, err := services.NewBlockContainerService(sp.Store, block.GlobalRegistry())
	if err != nil {
		t.Fatal(err)
	}
	sp.Containers = containers
	if sp.Documents, err = services.NewDocumentService(sp.Store); err != nil {
		t.Fatal(err)
	}
	sp.Ink = ink.NewInkService(sp.State, containers, holdingRadio{}, nil)
	t.Cleanup(sp.Ink.Stop)
	r := chi.NewRouter()
	h.RegisterPaths(r)
	(&InkHandler{ServiceProvider: sp, Tmpl: h.Tmpl}).RegisterPaths(r)
	(&SideBarHandler{ServiceProvider: sp, Tmpl: h.Tmpl}).RegisterPaths(r)
	(&SearchHandler{ServiceProvider: sp, Tmpl: h.Tmpl}).RegisterPaths(r)
	(&ContextMenuHandler{ServiceProvider: sp, Tmpl: h.Tmpl}).RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv, sp
}

// postInk posts form to an Ink action and returns the fragment it answers with.
func postInk(t *testing.T, srv *httptest.Server, path string, form url.Values) string {
	t.Helper()
	resp, err := http.PostForm(srv.URL+path, form)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/html") {
		t.Fatalf("POST %s: %d %s", path, resp.StatusCode, body)
	}
	return string(body)
}

// Each state of the link reads as words, and an unsupported platform says so instead.
func TestInkFragment_RendersEachState(t *testing.T) {
	h, _ := newTestSettingsHandler(t)
	ih := &InkHandler{ServiceProvider: h.ServiceProvider, Tmpl: h.Tmpl}
	key := "MFRG GZDF MZTW Q2LK"
	notes := []ink.SyncedNote{{UUID: "u", Name: "Ideas", Title: "Untitled 05/11", Pages: 2, Seq: 9, Companion: "c"}}
	companions := []ink.Companion{{Identity: "c", Device: "Note Air 2", Notes: 1}}
	for _, tc := range []struct {
		name   string
		status ink.Status
		want   []string
		absent []string
	}{
		{"off", ink.Status{Supported: true, Link: ink.LinkState{Phase: ink.LinkOff}, Notes: notes, Companions: companions},
			[]string{`id="ink-enabled"`, "Ideas", "2 pages · seq 9", "Note Air 2", "1 note"},
			[]string{"checked", key, "New key", `id="ink-link"`, "Untitled 05/11"}},
		{"looking", ink.Status{Enabled: true, Supported: true, Key: key, SieveID: "0123abcd",
			Link: ink.LinkState{Phase: ink.LinkLooking}},
			[]string{"checked", key, "Type this key into SieveInk under Pair new", "0123abcd", "New key",
				"every tablet", "Looking for a companion", "No session yet", "No synced notes"},
			[]string{`id="ink-problem"`}},
		{"connected", ink.Status{Enabled: true, Supported: true, Key: key,
			Link: ink.LinkState{Phase: ink.LinkConnected, Companion: "boox-1"}, HasSession: true,
			Session: ink.SessionNumbers{Connect: 1500 * time.Millisecond, Records: 300, Bytes: 64000, CatchUp: time.Second}},
			[]string{"Connected to boox-1", "1.5 s", "300", "64.0 kB", "64.0 kB/s"},
			[]string{"No session yet"}},
		{"key rejected", ink.Status{Enabled: true, Supported: true, Key: key,
			Link: ink.LinkState{Phase: ink.LinkLooking, Problem: ink.ProblemKeyRejected}},
			[]string{"Looking for a companion", `id="ink-problem"`, "re-enter the key on the Boox"}, nil},
		{"unsupported", ink.Status{Enabled: true, Key: key, Link: ink.LinkState{Phase: ink.LinkLooking}},
			[]string{"Bluetooth ink is not supported on this computer"},
			[]string{"Looking for a companion"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out strings.Builder
			if err := h.Tmpl.ExecuteTemplate(&out, "ink_status.html", ih.view(tc.status)); err != nil {
				t.Fatal(err)
			}
			for _, want := range tc.want {
				if !strings.Contains(out.String(), want) {
					t.Errorf("no %q in\n%s", want, out.String())
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(out.String(), absent) {
					t.Errorf("%q in\n%s", absent, out.String())
				}
			}
		})
	}
}

// The tree's Ink item is nothing while Ink is disabled. Enabled, it is a row that expands and
// collapses as a folder's does, through the folder patch under its own id; collapsed it shows a
// live dot while the tablet writes, and expanded it holds the Live view while it exists and the
// synced notes by name, or says there are none, indented as a folder's children, each named in
// full in its tooltip, the active tab's row marked, and every row opening its container through
// the workspace's open.
func TestInkSidebar_RendersEachState(t *testing.T) {
	h, _ := newTestSettingsHandler(t)
	notes := []ink.SyncedNote{{UUID: "n-ideas", Name: "Ideas", Title: "Untitled 05/11", Pages: 2}, {UUID: "n-board", Pages: 1}}
	live := ink.LiveStatus{Present: true, UUID: "v-live", Device: "Note Air 2", Note: "n-ideas", NoteTitle: "Ideas"}
	waiting := ink.LiveStatus{Present: true, UUID: "v-live", Waiting: true}
	collapsed := domain.Session{Tabs: []domain.Tab{{ID: "n-board", Kind: ink.KindDigitalNote}}}
	expanded := collapsed
	expanded.OpenFolders = []string{"a-folder", inkTreeID}
	row := []string{">Ink<", `hx-patch="/api/folder/ink"`, `hx-target="#htmx-sidebar"`}
	for _, tc := range []struct {
		name    string
		status  ink.Status
		session domain.Session
		want    []string
		absent  []string
	}{
		{"disabled", ink.Status{Notes: notes, Live: live}, expanded, nil, nil},
		{"collapsed", ink.Status{Enabled: true, Notes: notes}, collapsed,
			append([]string{`aria-expanded="false"`, `{"open": true}`}, row...),
			[]string{"data-ink-note", "data-ink-live", "data-ink-live-dot", "No synced notes yet"}},
		{"collapsed while live", ink.Status{Enabled: true, Notes: notes, Live: live}, collapsed,
			append([]string{"data-ink-live-dot"}, row...), []string{`data-ink-live="live"`, "data-ink-note"}},
		{"collapsed while waiting", ink.Status{Enabled: true, Notes: notes, Live: waiting}, collapsed,
			row, []string{"data-ink-live-dot", "data-ink-live"}},
		{"no notes", ink.Status{Enabled: true}, expanded,
			append([]string{`aria-expanded="true"`, `{"open": false}`, "No synced notes yet"}, row...),
			[]string{"data-ink-live", "data-ink-note"}},
		{"notes", ink.Status{Enabled: true, Notes: notes}, expanded, []string{
			`data-ink-note="n-ideas"`, `title="Ideas"`, "2 pages", `data-ink-note="n-board"`, `title="Untitled note"`, "1 page",
			`window.sieveWorkspace.open('n-ideas')`, `data-ink-note="n-board"
  data-active`, `padding-left:2.50rem;`,
		}, []string{"data-ink-live", "No synced notes yet", "Untitled 05/11"}},
		{"live", ink.Status{Enabled: true, Notes: notes, Live: live}, expanded, []string{
			`data-ink-live="live"`, `ink-tree__label">Live · Note Air 2<`, `ink-tree__meta">Ideas<`,
			`window.sieveWorkspace.open('v-live')`, "ink-icon--live",
		}, []string{"waiting", "data-ink-live-dot"}},
		{"waiting", ink.Status{Enabled: true, Notes: notes, Live: waiting}, expanded,
			[]string{`data-ink-live="waiting"`, ">Live<", "Waiting for the tablet"}, []string{"data-ink-live-dot"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var v inkSidebarView
			v.show(tc.status, tc.session)
			var out strings.Builder
			if err := h.Tmpl.ExecuteTemplate(&out, "ink_sidebar.html", v); err != nil {
				t.Fatal(err)
			}
			if tc.want == nil && out.String() != "" {
				t.Errorf("disabled Ink renders %q, want nothing", out.String())
			}
			for _, want := range tc.want {
				if !strings.Contains(out.String(), want) {
					t.Errorf("no %q in\n%s", want, out.String())
				}
			}
			for _, absent := range tc.absent {
				if strings.Contains(out.String(), absent) {
					t.Errorf("%q in\n%s", absent, out.String())
				}
			}
		})
	}
}

// The Ink item is the tree's first, above the library's folders and above an empty library's
// line, and only while Ink is enabled; the tree holds it in a mount of its own that refreshes on
// the ink invalidation, which is also where the item is served. Expanding it is remembered as a
// folder's expansion is. The sidebar's search view does not show it.
func TestInkSidebar_IsTheFirstItemOfTheTreeWhileInkIsEnabled(t *testing.T) {
	srv, sp := newInkServer(t)
	get := func(path string) string {
		t.Helper()
		status, body := do(t, http.MethodGet, srv.URL+path, "", "")
		if status != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, status, body)
		}
		return body
	}
	mount := `<div id="sidebar-ink" class="ink-tree" hx-get="/ui/views/sidebar/ink" hx-trigger="sieve:invalidate-ink from:document" hx-swap="innerHTML">`
	tree := get("/ui/views/sidebar")
	if !strings.Contains(tree, mount+"</div>") || !strings.Contains(tree, "No filed documents yet") || get("/ui/views/sidebar/ink") != "" {
		t.Errorf("Ink off: the tree is\n%s", tree)
	}

	settings := sp.State.LoadSettings()
	settings.Ink.Enabled = true
	if err := sp.State.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	tree = get("/ui/views/sidebar")
	if at, empty := strings.Index(tree, "ink-tree__row"), strings.Index(tree, "No filed documents yet"); at < 0 || empty < at || !strings.Contains(tree, mount) {
		t.Errorf("an empty library's tree is\n%s", tree)
	}
	if err := sp.Documents.NewFolder("Work"); err != nil {
		t.Fatal(err)
	}
	tree = get("/ui/views/sidebar")
	if at, folder := strings.Index(tree, "ink-tree__row"), strings.Index(tree, ">Work<"); at < 0 || folder < at {
		t.Errorf("the Ink item is not above the folders:\n%s", tree)
	}
	if strings.Contains(get("/ui/views/sidebar/ink"), "No synced notes yet") {
		t.Error("the Ink item starts expanded")
	}

	if status, body := do(t, http.MethodPatch, srv.URL+"/api/folder/ink", "application/x-www-form-urlencoded", "open=true"); status != http.StatusOK ||
		!strings.Contains(body, "No synced notes yet") || !strings.Contains(body, ">Work<") {
		t.Fatalf("expanding Ink: %d\n%s", status, body)
	}
	if !strings.Contains(get("/ui/views/sidebar/ink"), "No synced notes yet") || !strings.Contains(get("/ui/views/sidebar"), "No synced notes yet") {
		t.Error("Ink's expansion is not remembered")
	}
	if search := get("/ui/views/sidebar/search?q="); strings.Contains(search, "ink-tree") || strings.Contains(search, "sidebar-ink") {
		t.Errorf("the search view shows Ink:\n%s", search)
	}
}

// A session's numbers read in units that fit them, and a rate is shown only over a catch-up long
// enough for one to mean anything.
func TestInkSessionView_ShowsDurationsInFittingUnitsAndRatesOnlyWhenMeaningful(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		numbers                      ink.SessionNumbers
		connect, catchUp, throughput string
	}{
		{"nothing to catch up", ink.SessionNumbers{Connect: 1500 * time.Millisecond}, "1.5 s", "0 ms", ""},
		{"under a millisecond", ink.SessionNumbers{Connect: 400 * time.Microsecond, Bytes: 1800, CatchUp: 400 * time.Microsecond},
			"under 1 ms", "under 1 ms", ""},
		{"under the rate floor", ink.SessionNumbers{Connect: 820 * time.Millisecond, Bytes: 9000, CatchUp: 49 * time.Millisecond},
			"820 ms", "49 ms", ""},
		{"at the rate floor", ink.SessionNumbers{Bytes: 5000, CatchUp: 50 * time.Millisecond}, "0 ms", "50 ms", "100.0 kB/s"},
		{"just under a second", ink.SessionNumbers{Bytes: 1000, CatchUp: 999*time.Millisecond + 600*time.Microsecond},
			"0 ms", "1.0 s", "1.0 kB/s"},
		{"seconds", ink.SessionNumbers{Bytes: 64000, CatchUp: 12340 * time.Millisecond}, "0 ms", "12.3 s", "5.2 kB/s"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var v inkSessionView
			v.show(tc.numbers)
			if v.Connect != tc.connect || v.CatchUp != tc.catchUp || v.Throughput != tc.throughput {
				t.Errorf("connect %q catch-up %q throughput %q, want %q %q %q",
					v.Connect, v.CatchUp, v.Throughput, tc.connect, tc.catchUp, tc.throughput)
			}
		})
	}
}

// The toggle and the new key take effect at once and answer with the fragment, and the big
// settings Save leaves what they wrote alone.
func TestInkActions_TakeEffectAndSurviveTheSettingsSave(t *testing.T) {
	srv, sp := newInkServer(t)
	on := postInk(t, srv, "/api/ink/enabled", url.Values{"ink_enabled": {"on"}})
	first := sp.Ink.Status()
	if !first.Enabled || first.Key == "" || !strings.Contains(on, first.Key) || !strings.Contains(on, "checked") {
		t.Fatalf("enabling: %+v\n%s", first, on)
	}
	renewed := postInk(t, srv, "/api/ink/key", nil)
	second := sp.Ink.Status()
	if second.Key == first.Key || !strings.Contains(renewed, second.Key) {
		t.Errorf("new key %q after %q", second.Key, first.Key)
	}

	resp, err := http.PostForm(srv.URL+"/api/settings", url.Values{"cli": {"claude"}, "theme": {"nord"}})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if got := sp.State.LoadSettings().Ink; !got.Enabled || got.Key != second.Key {
		t.Errorf("the settings save left ink as %+v", got)
	}

	off := postInk(t, srv, "/api/ink/enabled", url.Values{})
	if st := sp.Ink.Status(); st.Enabled || st.Link.Phase != ink.LinkOff || strings.Contains(off, "checked") {
		t.Errorf("disabling: %+v", st)
	}
	if got := sp.State.LoadSettings().Ink.Key; got != second.Key {
		t.Errorf("disabling dropped the key: %q", got)
	}
}

// htmx hands a form's hx-target down to every element inside it, so an element in the settings
// form that makes its own request and names no target replaces the whole dialog with its answer.
// Every such element — in the settings page and in each fragment swapped into it — names its own.
func TestSettingsForm_EveryRequestInsideItNamesItsOwnTarget(t *testing.T) {
	srv, _ := newInkServer(t)
	postInk(t, srv, "/api/ink/enabled", url.Values{"ink_enabled": {"on"}})
	get := func(path string) string {
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
	attr := func(n *html.Node, key string) (string, bool) {
		for _, a := range n.Attr {
			if a.Key == key {
				return a.Val, true
			}
		}
		return "", false
	}
	doc, err := html.Parse(strings.NewReader(get("/ui/views/settings")))
	if err != nil {
		t.Fatal(err)
	}
	var form *html.Node
	for n := range doc.Descendants() {
		if id, _ := attr(n, "id"); n.Type == html.ElementNode && n.Data == "form" && id == "settings-form" {
			form = n
		}
	}
	if form == nil {
		t.Fatal("no settings form")
	}
	if _, ok := attr(form, "hx-target"); !ok {
		t.Fatal("the settings form names no target, so nothing inherits one")
	}
	checked := 0
	var check func(root *html.Node, where string)
	check = func(root *html.Node, where string) {
		for n := range root.Descendants() {
			if n.Type != html.ElementNode {
				continue
			}
			for _, verb := range []string{"hx-get", "hx-post", "hx-put", "hx-patch", "hx-delete"} {
				path, ok := attr(n, verb)
				if !ok {
					continue
				}
				checked++
				if _, ok := attr(n, "hx-target"); !ok {
					t.Errorf("%s: <%s %s=%q> names no hx-target, so it inherits the form's", where, n.Data, verb, path)
				}
				if verb != "hx-get" {
					continue
				}
				fragment, err := html.ParseFragment(strings.NewReader(get(path)), &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div})
				if err != nil {
					t.Fatal(err)
				}
				for _, f := range fragment {
					holder := &html.Node{Type: html.ElementNode, Data: "div"}
					holder.AppendChild(f)
					check(holder, path)
				}
			}
		}
	}
	check(form, "settings form")
	if checked < 3 {
		t.Errorf("checked %d requesting elements; the Ink mount, toggle and New key make three", checked)
	}
}
