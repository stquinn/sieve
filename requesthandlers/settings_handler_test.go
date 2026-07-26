package requesthandlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"sieve/sieve"
	"sieve/sieve/domain"
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
