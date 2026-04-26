package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type PromptsHandler struct {
	Prompts **sieve.PromptService
	Tmpl    *template.Template
}

func (p *PromptsHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/prompts", p.handlePrompts)
}

func (p *PromptsHandler) handlePrompts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	promptsService := *p.Prompts
	if promptsService == nil {
		http.Error(w, "prompts service not available", http.StatusInternalServerError)
		return
	}

	prompts := promptsService.ListPrompts()
	if err := p.Tmpl.ExecuteTemplate(w, "prompts.html", prompts); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
