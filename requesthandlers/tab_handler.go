package requesthandlers

import (
	"fmt"
	"html/template"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type TabHandler struct {
	State **sieve.StateService
	Tmpl  *template.Template
}

func (h *TabHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/tabs", h.handleTabs)
}

func (h *TabHandler) handleTabs(w http.ResponseWriter, r *http.Request) {
	state := *h.State
	if state == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, "")
		return
	}
	session := state.LoadSession()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
