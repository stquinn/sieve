package requesthandlers

import (
	"html/template"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/services"

	"github.com/go-chi/chi/v5"
)

// Registry constructs the full set of RequestHandlers and registers their
// routes. It owns which handlers exist and how their SSE-emit closures are
// wired, keeping that assembly cohesive within the requesthandlers package
// rather than in the composition root.
type Registry struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
	Broadcast       func(event, data string)
	Jobs            *services.JobTracker
}

// Mount builds each RequestHandler and registers its paths on r.
func (reg Registry) Mount(r chi.Router) {
	sp := reg.ServiceProvider
	tmpl := reg.Tmpl
	broadcast := reg.Broadcast

	handlers := []RequestHandler{
		&SideBarHandler{ServiceProvider: sp, Tmpl: tmpl},
		&TabHandler{ServiceProvider: sp, Tmpl: tmpl},
		&ContextMenuHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitNotesChanged: func() {
				broadcast("notes:changed", "{}")
			},
			EmitPromptsChanged: func() {
				broadcast("prompts:changed", "{}")
			},
		},
		&MetaHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitNotesChanged: func() {
				logger.Info("MetaHandler: notes changed event")
				broadcast("notes:changed", "{}")
			},
		},
		&EditorHandler{ServiceProvider: sp, Tmpl: tmpl, Broadcast: broadcast},
		&SettingsHandler{ServiceProvider: sp, Tmpl: tmpl},
		&HelpHandler{Tmpl: tmpl},
		&SearchHandler{ServiceProvider: sp, Tmpl: tmpl},
		&AssetHandler{ServiceProvider: sp},
		&PromptsHandler{ServiceProvider: sp, Tmpl: tmpl},
		&SessionHandler{
			ServiceProvider: sp,
			Broadcast:       broadcast,
		},
		&NoteHandler{
			ServiceProvider: sp,
			Tmpl:            tmpl,
			EmitSessionChanged: func() {
				broadcast("session:changed", "{}")
			},
		},
		&AiHandler{
			ServiceProvider: sp,
			JobTracker:      reg.Jobs,
			EmitNotesChanged: func() {
				logger.Info("AI: notes changed event")
				broadcast("notes:changed", "{}")
			},
			Broadcast: broadcast,
		},
		NewWsHandler(sp),
		&LibraryHandler{
			Tmpl:            tmpl,
			ServiceProvider: sp,
		},
	}
	for _, h := range handlers {
		h.RegisterPaths(r)
	}
}
