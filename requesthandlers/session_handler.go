package requesthandlers

import (
	"fmt"
	"net/http"
	"sieve/sieve"
	"sieve/sieve/domain"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type SessionHandler struct {
	ServiceProvider    *sieve.ServiceProvider
	EmitPromptsChanged func()
}

func (h *SessionHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/session/toggle/{panel}", h.handlePanelToggle)
	r.Post("/api/session/layout", h.handleSessionLayout)
	r.Get("/ui/views/session/layout", h.handleSwitchLayout)
}

// handlePanelToggle flips one panel's visibility and answers with the OOB
// <style> that shows or hides it. Which panel is a PARAMETER: the six panels
// differ only in the flag they flip and the rules they emit, and six routes
// doing that is six copies of one operation.
func (h *SessionHandler) handlePanelToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()

	var style string
	switch panel := chi.URLParam(r, "panel"); panel {
	case "sidebar":
		session.ShowSidebar = !session.ShowSidebar
		style = h.sidebarStyle(session)
	case "meta":
		session.ShowMeta = !session.ShowMeta
		style = h.metaStyle(session)
	case "prompts":
		session.ShowPrompts = !session.ShowPrompts
		style = h.promptsStyle(session)
		if h.EmitPromptsChanged != nil {
			h.EmitPromptsChanged()
		}
	case "toolbar":
		session.ShowToolbar = !session.ShowToolbar
		style = h.toolbarStyle(session)
	case "linenumbers":
		session.ShowLineNumbers = !session.ShowLineNumbers
		style = h.lineNumbersStyle(session)
	case "askpanel":
		session.ShowAskPanel = !session.ShowAskPanel
		style = h.askPanelStyle(session)
	default:
		http.Error(w, "unknown panel: "+panel, http.StatusNotFound)
		return
	}
	_ = h.ServiceProvider.State.SaveSession(session)

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, style)
}

func (h *SessionHandler) sidebarStyle(session domain.Session) string {
	return fmt.Sprintf(`<style id="layout-overrides-sidebar" hx-swap-oob="true">
		#app-root { --sidebar-w: %dpx !important; }
		#htmx-sidebar { display: %s !important; }
		.sidebar-handle { display: %s !important; }
	</style>`, map[bool]int{true: session.SidebarWidth, false: 0}[session.ShowSidebar],
		map[bool]string{true: "flex", false: "none"}[session.ShowSidebar],
		map[bool]string{true: "block", false: "none"}[session.ShowSidebar])
}

func (h *SessionHandler) metaStyle(session domain.Session) string {
	return fmt.Sprintf(`<style id="layout-overrides-meta" hx-swap-oob="true">
		#app-root { --meta-w: %dpx !important; }
		#htmx-meta-panel { display: %s !important; }
		.meta-handle { display: %s !important; }
	</style>`, map[bool]int{true: session.MetaWidth, false: 0}[session.ShowMeta],
		map[bool]string{true: "flex", false: "none"}[session.ShowMeta],
		map[bool]string{true: "block", false: "none"}[session.ShowMeta])
}

func (h *SessionHandler) promptsStyle(session domain.Session) string {
	display := map[bool]string{true: "block", false: "none"}[session.ShowPrompts]
	return fmt.Sprintf(`<style id="layout-overrides-prompts" hx-swap-oob="true">
		#prompts-panel { display: %s; }
		.prompts-handle { display: %s; }
	</style>`, display, display)
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

// toolbarStyle carries the toolbar's visibility AND the CSS variable that
// offsets the gutter separator, which moves with it.
func (h *SessionHandler) toolbarStyle(session domain.Session) string {
	display, toolbarH := "none", "0px"
	if session.ShowToolbar {
		display, toolbarH = "flex", "36px"
	}
	return fmt.Sprintf(`<style id="layout-overrides-toolbar" hx-swap-oob="true">#editor-toolbar { display: %s; } #app-root { --toolbar-h: %s; }</style>`, display, toolbarH)
}

func (h *SessionHandler) lineNumbersStyle(session domain.Session) string {
	return fmt.Sprintf(`<style id="layout-overrides-linenumbers" hx-swap-oob="true">%s</style>`,
		lineNumberOverrideCSS(session.ShowLineNumbers))
}

// askPanelStyle also dispatches the panel's state to JS: the panel's own
// controller needs to know it opened, and a <style> cannot say so.
func (h *SessionHandler) askPanelStyle(session domain.Session) string {
	styleRule := ""
	if session.ShowAskPanel {
		styleRule = `#ask-panel { display: flex !important; position: relative; z-index: 20; border-top: 1px solid var(--theme-border2); }`
	}
	return fmt.Sprintf(`<style id="layout-overrides-askpanel" hx-swap-oob="true">%s</style>
<script id="askpanel-state-sync" hx-swap-oob="true">document.dispatchEvent(new CustomEvent('sieve:ask-panel-toggled', { detail: %t }))</script>`,
		styleRule, session.ShowAskPanel)
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
	if settings.Tier() == domain.TierSmart {
		tierStr = "smart"
	}

	askPanelStyle := ""
	if session.ShowAskPanel {
		askPanelStyle = `#ask-panel { display: flex !important; position: relative; z-index: 20; border-top: 1px solid var(--theme-border2); }`
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w,
		`<style id="layout-overrides-sidebar" hx-swap-oob="true">#app-root { --sidebar-w: %dpx !important; } #htmx-sidebar { display: %s !important; } .sidebar-handle { display: %s !important; }</style>`+
			`<style id="layout-overrides-meta" hx-swap-oob="true">#app-root { --meta-w: %dpx !important; } #htmx-meta-panel { display: %s !important; } .meta-handle { display: %s !important; }</style>`+
			`<style id="layout-overrides-prompts" hx-swap-oob="true">#prompts-panel { display: %s; } .prompts-handle { display: %s; }</style>`+
			`<style id="layout-overrides-toolbar" hx-swap-oob="true">#editor-toolbar { display: %s; } #app-root { --toolbar-h: %s; }</style>`+
			`<style id="layout-overrides-linenumbers" hx-swap-oob="true">%s</style>`+
			`<style id="layout-overrides-askpanel" hx-swap-oob="true">%s</style>`+
			`<script id="askpanel-state-sync" hx-swap-oob="true">var r=document.getElementById('app-root');if(r)r.className=r.className.replace(/tier-\S+/,'tier-%s'); document.dispatchEvent(new CustomEvent('sieve:ask-panel-toggled', { detail: %t }));</script>`,
		sidebarW, sidebarDisp, handleDisp,
		metaW, metaDisp, metaHandleDisp,
		promptsDisp, promptsDisp,
		toolbarDisp, toolbarH,
		lineNumberOverrideCSS(session.ShowLineNumbers),
		askPanelStyle,
		tierStr, session.ShowAskPanel,
	)
}
