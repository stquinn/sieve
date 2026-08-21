package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"
	"sieve/sieve/ai"

	"github.com/go-chi/chi/v5"
)

type PromptsHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

// PromptVarDef documents one template variable available to a prompt type.
type PromptVarDef struct {
	Name string
	Desc string
}

// PromptVarDocs owns the per-prompt-type table of template variables surfaced
// to the prompt editor via the `promptVars` template func. It sits with the
// prompts concern because that is where the documentation is consumed.
type PromptVarDocs struct{}

// For returns the documented template variables for prompt type t.
func (PromptVarDocs) For(t string) []PromptVarDef {
	m := map[string][]PromptVarDef{
		"file": {
			{"{content}", "Note body text"},
			{"{folder_list}", "Existing store folders"},
			{"{version}", "Doc version number"},
			{"{focus_count}", "Open frequency"},
			{"{created}", "Creation timestamp"},
			{"{modified}", "Last modified timestamp"},
			{"{now}", "Current timestamp"},
		},
		"explain": {
			{"{type}", "Detected content type"},
			{"{history}", "Relevant conversation context"},
			{"{content}", "Target text to explain"},
			{"{images}", "List of relevant asset names"},
		},
		"ask": {
			{"{type}", "Detected content type"},
			{"{content}", "Context document text"},
			{"{history}", "Conversation history"},
			{"{question}", "User question"},
			{"{images}", "List of relevant asset names"},
		},
		"refine": {
			{"{content}", "The code block text to identify"},
			{"{current_language}", "The language currently detected by heuristics"},
			{"{detection_method}", "The method used to detect the current language"},
		},
		"image": {
			{"{image_filename}", "The original filename of the image"},
		},
		"web-clip-fetch": {
			{"{source}", "URL to retrieve"},
		},
		"web-clip-summarise": {
			{"{source}", "URL to summarise"},
			{"{document}", "Current document content (sent automatically — not manually editable)"},
		},
	}
	return m[t]
}

func (p *PromptsHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/prompts", p.handlePrompts)
}

func (p *PromptsHandler) handlePrompts(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if p.ServiceProvider.Prompts == nil || p.ServiceProvider.State == nil {
		return
	}

	prompts := p.ServiceProvider.Prompts.ListPrompts()
	session := p.ServiceProvider.State.LoadSession()
	activeID := ""
	if len(session.Tabs) > 0 && session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		activeID = session.Tabs[session.ActiveIdx].ID
	}

	data := struct {
		Prompts  []ai.PromptEntry
		ActiveID string
	}{
		Prompts:  prompts,
		ActiveID: activeID,
	}

	if err := p.Tmpl.ExecuteTemplate(w, "prompts.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
