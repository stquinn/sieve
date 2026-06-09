package requesthandlers

import (
	"html/template"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// LibraryHandler serves the status-bar library chip fragment.
type LibraryHandler struct {
	Tmpl           *template.Template
	GetLibraryInfo func() (path, name string)
}

func (h *LibraryHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/library/current", h.handleLibraryCurrent)
}

func (h *LibraryHandler) handleLibraryCurrent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	_, name := h.GetLibraryInfo()
	if name == "" {
		name = "Library"
	}

	data := struct{ Name string }{Name: name}
	if err := h.Tmpl.ExecuteTemplate(w, "library_chip.html", data); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
