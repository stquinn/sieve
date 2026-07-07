package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"

	"github.com/go-chi/chi/v5"
)

type TabHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

func (h *TabHandler) RegisterPaths(r chi.Router) {
	r.Get("/api/tabs", h.handleTabs)
}

func (h *TabHandler) handleTabs(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")

	if h.ServiceProvider.State == nil {
		return
	}

	session := h.ServiceProvider.State.LoadSession()
	// Re-derive each tab's filed status / display name from the live document so a
	// buffer that was filed (buffer→note, asynchronously on close) shows the filed
	// icon on this render. The stored session Status is only a startup snapshot.
	if h.ServiceProvider.Documents != nil {
		session.Tabs = h.ServiceProvider.Documents.RefreshTabStatus(session.Tabs)
	}
	if err := h.Tmpl.ExecuteTemplate(w, "tabbar.html", session); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
