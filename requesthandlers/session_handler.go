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
	r.Post("/api/session/toolbar/toggle", h.handleToolbarToggle)
	r.Post("/api/session/linenumbers/toggle", h.handleLineNumbersToggle)
	r.Post("/api/session/askpanel/toggle", h.handleAskPanelToggle)
	r.Post("/api/session/layout", h.handleSessionLayout)
	r.Post("/api/session/refresh", h.handleSessionRefresh)
	r.Get("/api/library/switch-layout", h.handleSwitchLayout)
}

func (h *SessionHandler) handleSidebarToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowSidebar = !session.ShowSidebar
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides-sidebar" hx-swap-oob="true">
		#app-root { --sidebar-w: %dpx; }
		#htmx-sidebar { display: %s; }
		.sidebar-handle { display: %s; }
	</style>`, map[bool]int{true: session.SidebarWidth, false: 0}[session.ShowSidebar],
		map[bool]string{true: "block", false: "none"}[session.ShowSidebar],
		map[bool]string{true: "block", false: "none"}[session.ShowSidebar])
}

func (h *SessionHandler) handleMetaToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowMeta = !session.ShowMeta
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides-meta" hx-swap-oob="true">
		#app-root { --meta-w: %dpx; }
		#htmx-meta-panel { display: %s; }
		.meta-handle { display: %s; }
	</style>`, map[bool]int{true: session.MetaWidth, false: 0}[session.ShowMeta],
		map[bool]string{true: "flex", false: "none"}[session.ShowMeta],
		map[bool]string{true: "block", false: "none"}[session.ShowMeta])
}

func (h *SessionHandler) handlePromptsToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowPrompts = !session.ShowPrompts
	_ = h.ServiceProvider.State.SaveSession(session)

	if h.Broadcast != nil {
		h.Broadcast("prompts:changed", "{}")
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides-prompts" hx-swap-oob="true">
		#prompts-panel { display: %s; }
		.prompts-handle { display: %s; }
	</style>`, map[bool]string{true: "block", false: "none"}[session.ShowPrompts],
		map[bool]string{true: "block", false: "none"}[session.ShowPrompts])
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
	if hStr := r.FormValue("askPanelHeight"); hStr != "" {
		if hInt, err := strconv.Atoi(hStr); err == nil {
			session.AskPanelHeight = hInt
		}
	}

	_ = h.ServiceProvider.State.SaveSession(session)
	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) handleToolbarToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowToolbar = !session.ShowToolbar
	_ = h.ServiceProvider.State.SaveSession(session)

	display := "none"
	toolbarH := "0px"
	if session.ShowToolbar {
		display = "flex"
		toolbarH = "36px"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// Update toolbar visibility and the CSS variable that offsets the gutter separator.
	fmt.Fprintf(w, `<style id="layout-overrides-toolbar" hx-swap-oob="true">#editor-toolbar { display: %s; } #app-root { --toolbar-h: %s; }</style>`, display, toolbarH)
}

func (h *SessionHandler) handleAskPanelToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowAskPanel = !session.ShowAskPanel
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<script hx-swap-oob="true">document.dispatchEvent(new CustomEvent('sieve:ask-panel-toggled', { detail: %t }))</script>`, session.ShowAskPanel)
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

// lineNumberOverrideCSS returns the CSS that hides the editor line numbers and
// the gutter rule (and reclaims their left padding) when line numbers are toggled
// off. Empty when on, so the base editor.css rules apply. Shared by the toggle
// endpoint, the index template's initial render, and the library-switch layout so
// all three stay in lockstep.
func lineNumberOverrideCSS(show bool) string {
	if show {
		return ""
	}
	return `.tiptap > *::before, .tiptap::before { display: none !important; } .tiptap { padding-left: 1.25rem !important; }`
}

func (h *SessionHandler) handleLineNumbersToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	session.ShowLineNumbers = !session.ShowLineNumbers
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<style id="layout-overrides-linenumbers" hx-swap-oob="true">%s</style>`, lineNumberOverrideCSS(session.ShowLineNumbers))
}

// handleSwitchLayout returns OOB style-tag swaps for all layout CSS variables
// based on the new library's session. Called after SwitchLibrary to update the
// UI in-place without a page reload (avoids the WebKit signal-handler reinstall
// that location.reload() triggers on Linux/WebKit2GTK).
func (h *SessionHandler) handleSwitchLayout(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()
	settings := h.ServiceProvider.State.LoadSettings()

	sidebarW, sidebarDisp, handleDisp := 0, "none", "none"
	if session.ShowSidebar {
		sidebarW = session.SidebarWidth
		sidebarDisp = "block"
		handleDisp = "block"
	}
	metaW, metaDisp, metaHandleDisp := 0, "none", "none"
	if session.ShowMeta {
		metaW = session.MetaWidth
		metaDisp = "flex"
		metaHandleDisp = "block"
	}
	promptsDisp := "none"
	if session.ShowPrompts {
		promptsDisp = "block"
	}
	toolbarDisp, toolbarH := "none", "0px"
	if session.ShowToolbar {
		toolbarDisp = "flex"
		toolbarH = "36px"
	}

	tierStr := "dumb"
	if settings.Tier() == sieve.TierSmart {
		tierStr = "smart"
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w,
		`<style id="layout-overrides-sidebar" hx-swap-oob="true">#app-root { --sidebar-w: %dpx; } #htmx-sidebar { display: %s; } .sidebar-handle { display: %s; }</style>`+
			`<style id="layout-overrides-meta" hx-swap-oob="true">#app-root { --meta-w: %dpx; } #htmx-meta-panel { display: %s; } .meta-handle { display: %s; }</style>`+
			`<style id="layout-overrides-prompts" hx-swap-oob="true">#prompts-panel { display: %s; } .prompts-handle { display: %s; }</style>`+
			`<style id="layout-overrides-toolbar" hx-swap-oob="true">#editor-toolbar { display: %s; } #app-root { --toolbar-h: %s; }</style>`+
			`<style id="layout-overrides-linenumbers" hx-swap-oob="true">%s</style>`+
			`<script hx-swap-oob="true">var r=document.getElementById('app-root');if(r)r.className=r.className.replace(/tier-\S+/,'tier-%s'); document.dispatchEvent(new CustomEvent('sieve:ask-panel-toggled', { detail: %t }));</script>`,
		sidebarW, sidebarDisp, handleDisp,
		metaW, metaDisp, metaHandleDisp,
		promptsDisp, promptsDisp,
		toolbarDisp, toolbarH,
		lineNumberOverrideCSS(session.ShowLineNumbers),
		tierStr, session.ShowAskPanel,
	)
}
