package requesthandlers

import (
	"html/template"
	"net/http"

	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

// LibraryHandler serves the status-bar library chip fragment.
type LibraryHandler struct {
	Tmpl            *template.Template
	ServiceProvider *sieve.ServiceProvider
}

func (h *LibraryHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/library/current", h.handleLibraryCurrent)
}

func (h *LibraryHandler) handleLibraryCurrent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	name := "Library"
	if h.ServiceProvider != nil && h.ServiceProvider.Library != nil {
		name = h.ServiceProvider.Library.Current().Name
	}

	data := struct{ Name string }{Name: name}
	if err := h.Tmpl.ExecuteTemplate(w, "library_chip.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
