package requesthandlers

import (
	"fmt"
	"net/http"
	"sieve/sieve"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type SessionHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Broadcast       func(event, data string)
}

func (h *SessionHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/session/sidebar/toggle", h.handleSidebarToggle)
	r.Post("/api/session/meta/toggle", h.handleMetaToggle)
	r.Post("/api/session/prompts/toggle", h.handlePromptsToggle)
	r.Post("/api/session/layout", h.handleSessionLayout)
	r.Post("/api/session/refresh", h.handleSessionRefresh)
}

func (h *SessionHandler) handleSidebarToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowSidebar = !session.ShowSidebar
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#app-root {
			--sidebar-w: %dpx;
		}
		#htmx-sidebar {
			display: %s;
		}
	</style>`, map[bool]int{true: session.SidebarWidth, false: 0}[session.ShowSidebar],
		map[bool]string{true: "block", false: "none"}[session.ShowSidebar])
}

func (h *SessionHandler) handleMetaToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowMeta = !session.ShowMeta
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#app-root {
			--meta-w: %dpx;
		}
		#htmx-meta-panel {
			display: %s;
		}
	</style>`, map[bool]int{true: session.MetaWidth, false: 0}[session.ShowMeta],
		map[bool]string{true: "flex", false: "none"}[session.ShowMeta])
}

func (h *SessionHandler) handlePromptsToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowPrompts = !session.ShowPrompts
	_ = h.ServiceProvider.State.SaveSession(session)

	if h.Broadcast != nil {
		h.Broadcast("prompts:changed", "{}")
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides" hx-swap-oob="true">
		#prompts-panel {
			display: %s;
		}
	</style>`, map[bool]string{true: "block", false: "none"}[session.ShowPrompts])
}

func (h *SessionHandler) handleSessionLayout(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()

	if wStr := r.FormValue("sidebarWidth"); wStr != "" {
		if wInt, err := strconv.Atoi(wStr); err == nil {
			session.SidebarWidth = wInt
		}
	}
	if wStr := r.FormValue("metaWidth"); wStr != "" {
		if wInt, err := strconv.Atoi(wStr); err == nil {
			session.MetaWidth = wInt
		}
	}
	if hStr := r.FormValue("promptsHeight"); hStr != "" {
		if hInt, err := strconv.Atoi(hStr); err == nil {
			session.PromptsHeight = hInt
		}
	}

	_ = h.ServiceProvider.State.SaveSession(session)
	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) handleSessionRefresh(w http.ResponseWriter, r *http.Request) {
	themeName := h.ServiceProvider.State.LoadSettings().Theme

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<script hx-swap-oob="true">
		var root = document.documentElement;
		var themeName = "%s";
		root.className = root.className.replace(/theme-\S+/, 'theme-' + themeName);
	</script>`, themeName)
}
