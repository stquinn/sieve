package main

import (
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"sieve/requesthandlers"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

// walkRoutes returns every mounted route as "METHOD /path", sorted.
func walkRoutes(t *testing.T) []string {
	t.Helper()
	broadcast := requesthandlers.NewWorkspaceBroadcast(nil)
	sp := &sieve.ServiceProvider{}
	app := NewApp(t.TempDir(), themes, broadcast, sp, nil)
	api, err := newAPIHandler(app, broadcast, sp)
	if err != nil {
		t.Fatalf("newAPIHandler: %v", err)
	}

	var got []string
	err = chi.Walk(api.routes, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		got = append(got, method+" "+route)
		return nil
	})
	if err != nil {
		t.Fatalf("chi.Walk: %v", err)
	}
	sort.Strings(got)
	return got
}

// TestRouteTable pins the HTTP surface. It is the target-state contract for
// issue #19: /ui/* is GET-only views and bytes, /api/* is operations and
// protocols. A route added, removed, or renamed without updating this list is a
// change to a published contract, and the failure is the point.
func TestRouteTable(t *testing.T) {
	want := []string{
		"DELETE /api/folder/{id}",
		"DELETE /api/note/{id}",
		"DELETE /mcp",
		"GET /",
		"GET /api/document/load",
		"GET /api/ws/document/{uuid}",
		"GET /api/ws/workspace",
		"GET /mcp",
		"GET /ui/assets/{uuid}/{filename}",
		"GET /ui/files/*",
		"GET /ui/image-proxy",
		"GET /ui/static/*",
		"GET /ui/theme.css",
		"GET /ui/views/editor",
		"GET /ui/views/help",
		"GET /ui/views/library/current",
		"GET /ui/views/licenses",
		"GET /ui/views/meta",
		"GET /ui/views/meta/dialog/restore",
		"GET /ui/views/prompts",
		"GET /ui/views/search",
		"GET /ui/views/search/dialog",
		"GET /ui/views/session/layout",
		"GET /ui/views/settings",
		"GET /ui/views/sidebar",
		"GET /ui/views/sidebar/dialog/{kind}",
		"GET /ui/views/sidebar/search",
		"GET /ui/views/tabs",
		"PATCH /api/folder/{id}",
		"PATCH /api/note/{id}",
		"POST /api/document/save",
		"POST /api/folder",
		"POST /api/meta/restore",
		"POST /api/note",
		"POST /api/note/open/{id}",
		"POST /api/session/layout",
		"POST /api/session/toggle/{panel}",
		"POST /api/settings",
		"POST /api/settings/editor-scale/step",
		"POST /api/settings/panel",
		"POST /api/sidebar/intent",
		"POST /api/sidebar/move",
		"POST /api/sidebar/revert-prompt",
		"POST /api/tabs/close",
		"POST /api/tabs/reorder",
		"POST /mcp",
	}
	sort.Strings(want)

	got := walkRoutes(t)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("route table drifted\n--- want ---\n%s\n--- got ---\n%s",
			strings.Join(want, "\n"), strings.Join(got, "\n"))
	}
}

// Nothing outside /ui, /api and the three fixed roots may be mounted: the split
// between safe views/bytes and operations is what makes "which of these may the
// contained CLI reach" a question with a readable answer.
func TestRouteTable_OnlyKnownRoots(t *testing.T) {
	for _, entry := range walkRoutes(t) {
		route := entry[strings.Index(entry, " ")+1:]
		switch {
		case route == "/", route == "/mcp":
		case strings.HasPrefix(route, "/ui/"), strings.HasPrefix(route, "/api/"):
		default:
			t.Errorf("route %q is outside the /ui and /api roots", route)
		}
	}
}

// The loopback listener is reachable by the contained AI CLI (#83). Only the
// MCP endpoint and the WebSocket wires may cross it; every other route the app
// serves must be unreachable there.
func TestLocalhostBridge_AllowList(t *testing.T) {
	var reached string
	bridge := localhostBridge{api: http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		reached = r.URL.Path
	})}

	allowed := []string{"/mcp", "/api/ws/workspace", "/api/ws/document/abc"}
	for _, path := range allowed {
		reached = ""
		bridge.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
		if reached != path {
			t.Errorf("%s: expected pass-through, request never reached the router", path)
		}
	}

	// The last four are the ones a prefix match would wave through: each is
	// already-normalised, routes to nothing, and so reaches chi's NotFound —
	// which is handleIndex, a 200 carrying the whole app shell.
	refused := []string{"/", "/ui/views/sidebar", "/ui/static/app.js", "/ui/files/x.png",
		"/api/note", "/api/settings", "/api/document/save", "/mcp/../api/settings",
		"/mcp/", "/mcp/../mcp", "//api/ws/workspace",
		"/api/ws/x", "/api/ws/", "/api/ws", "/api/ws/document", "/api/ws/document/"}
	for _, path := range refused {
		reached = ""
		rec := httptest.NewRecorder()
		bridge.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if reached != "" {
			t.Errorf("%s: reached the router — the CLI must not see it", path)
		}
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", path, rec.Code)
		}
	}
}

// Every /ui route is a GET: they are safe and idempotent by construction, so a
// caller may retry or prefetch one without asking what it does.
func TestRouteTable_UIIsReadOnly(t *testing.T) {
	for _, entry := range walkRoutes(t) {
		method, route, _ := strings.Cut(entry, " ")
		if strings.HasPrefix(route, "/ui/") && method != "GET" {
			t.Errorf("%s %s: /ui routes must be GET", method, route)
		}
	}
}
