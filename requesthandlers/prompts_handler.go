package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type PromptsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (p *PromptsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/prompts", p.handlePrompts)
}

func (p *PromptsHandler) handlePrompts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	prompts := p.ServiceProvider.Prompts.ListPrompts()
	session := p.ServiceProvider.State.LoadSession()
	activeID := ""
	if len(session.Tabs) > 0 && session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeID = session.Tabs[session.ActiveIdx].ID
	}

	data := struct {
		Prompts  []sieve.PromptEntry
		ActiveID string
	}{
		Prompts:  prompts,
		ActiveID: activeID,
	}

	if err := p.Tmpl.ExecuteTemplate(w, "prompts.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
