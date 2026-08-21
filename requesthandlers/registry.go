package requesthandlers

import (
	"html/template"
	"io/fs"
	"net/http"

	"sieve/sieve"
	"sieve/sieve/protocol"

	"github.com/go-chi/chi/v5"
)

// Registry constructs the full set of RequestHandlers and registers their
// routes. It owns which handlers exist and which topic each one's invalidation
// closure pushes, keeping that assembly cohesive within the requesthandlers
// package rather than in the composition root.
//
// Mount is the ONLY place the app's route table is assembled, which is what lets
// tools/protocolgen walk the real surface: a route mounted anywhere else would
// be missing from the generated inventory. The three handlers this package
// cannot construct — they close over live *App state or a root-owned embed —
// are injected instead, so their PATHS still live here.
type Registry struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	Broadcast       *WorkspaceBroadcast
	Version         string       // release version (main.version, ldflags-injected)
	Credits         []byte       // embedded third-party-licenses.json (tools/gencredits)
	Themes          fs.FS        // embedded builtin themes, for /ui/theme.css
	MCP             http.Handler // the internal Sieve MCP transport
	Static          http.Handler // the embedded static tree, prefix already stripped
	Index           http.Handler // the app shell
}

// Mount builds each RequestHandler and registers its paths on r.
func (reg Registry) Mount(r chi.Router) {
	reg.requireInjected()
	sp := reg.ServiceProvider
	tmpl := reg.Tmpl
	broadcast := reg.Broadcast

	handlers := []RequestHandler{
		&SideBarHandler{ServiceProvider: sp, Tmpl: tmpl},
		&TabHandler{ServiceProvider: sp, Tmpl: tmpl},
		&ContextMenuHandler{
			ServiceProvider:      sp,
			Tmpl:                 tmpl,
			EmitContainerDeleted: broadcast.ContainerDeleted,
			EmitSessionChanged: func() {
				broadcast.Invalidate(protocol.TopicSession)
			},
			EmitNotesChanged: func() {
				broadcast.Invalidate(protocol.TopicNotes)
			},
			EmitPromptsChanged: func() {
				broadcast.Invalidate(protocol.TopicPrompts)
			},
			EmitIntentChanged: func() {
				broadcast.Invalidate(protocol.TopicIntent)
			},
		},
		&MetaHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitNotesChanged: func() {
				broadcast.Invalidate(protocol.TopicNotes)
			},
		},
		&EditorHandler{
			ServiceProvider:    sp,
			Tmpl:               tmpl,
			EmitContainerSaved: broadcast.ContainerSaved,
			EmitPromptsChanged: func() {
				broadcast.Invalidate(protocol.TopicPrompts)
			},
		},
		&SettingsHandler{ServiceProvider: sp, Tmpl: tmpl},
		&HelpHandler{Tmpl: tmpl, Version: reg.Version, Credits: reg.Credits},
		&SearchHandler{ServiceProvider: sp, Tmpl: tmpl},
		NewAssetHandler(sp, reg.Themes),
		&PromptsHandler{ServiceProvider: sp, Tmpl: tmpl},
		&SessionHandler{
			ServiceProvider: sp,
			EmitPromptsChanged: func() {
				broadcast.Invalidate(protocol.TopicPrompts)
			},
		},
		&NoteHandler{
			ServiceProvider:      sp,
			Tmpl:                 tmpl,
			EmitContainerDeleted: broadcast.ContainerDeleted,
			EmitSessionChanged: func() {
				broadcast.Invalidate(protocol.TopicSession)
			},
			EmitNotesChanged: func() {
				broadcast.Invalidate(protocol.TopicNotes)
			},
		},
		NewWsHandler(sp, broadcast),
		&LibraryHandler{
			Tmpl:            tmpl,
			ServiceProvider: sp,
		},
	}
	for _, h := range handlers {
		h.RegisterPaths(r)
	}

	// The three verbs the MCP streamable-HTTP transport speaks: POST carries
	// messages, GET opens the SSE stream, DELETE ends a session.
	r.Method(http.MethodGet, "/mcp", reg.MCP)
	r.Method(http.MethodPost, "/mcp", reg.MCP)
	r.Method(http.MethodDelete, "/mcp", reg.MCP)
	r.Method(http.MethodGet, "/ui/static/*", reg.Static)
	r.Method(http.MethodGet, "/", reg.Index)
}

// requireInjected refuses to mount when one of the three handlers this package
// cannot construct was left out. chi accepts a nil handler happily and the miss
// then surfaces as a nil dereference on the route's first request, from a stack
// that names neither the field nor the caller that forgot it — so the failure is
// pulled forward to construction, where it can say which one is missing.
func (reg Registry) requireInjected() {
	for _, injected := range []struct {
		field   string
		handler http.Handler
	}{
		{"MCP", reg.MCP},
		{"Static", reg.Static},
		{"Index", reg.Index},
	} {
		if injected.handler == nil {
			panic("requesthandlers: Registry." + injected.field +
				" is nil — Mount would register a route that nil-derefs on its first request")
		}
	}
}
