package requesthandlers

import (
	"html/template"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type HelpHandler struct {
	Tmpl *template.Template
}

func (h *HelpHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/help", h.handleHelp)
}

func (h *HelpHandler) handleHelp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "help.html", nil); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
