package requesthandlers

import (
	"html/template"
	"net/http"
	"sieve/sieve"
	"sieve/sieve/domain"
	"strconv"

	"github.com/go-chi/chi/v5"
)

type SessionHandler struct {
	ServiceProvider    *sieve.ServiceProvider
	Tmpl               *template.Template
	EmitPromptsChanged func()
	EmitSessionChanged func()
}

// SessionLayoutView is what session_layout.html renders: the session's panel
// flags and the AI tier. The stylesheets key on the element it produces.
type SessionLayoutView struct {
	ShowSidebar     bool
	ShowMeta        bool
	ShowPrompts     bool
	ShowToolbar     bool
	ShowLineNumbers bool
	ShowAskPanel    bool
	Smart           bool
}

// NewSessionLayoutView reads the view state out of a session and a tier.
func NewSessionLayoutView(session domain.Session, tier domain.Tier) SessionLayoutView {
	return SessionLayoutView{
		ShowSidebar:     session.ShowSidebar,
		ShowMeta:        session.ShowMeta,
		ShowPrompts:     session.ShowPrompts,
		ShowToolbar:     session.ShowToolbar,
		ShowLineNumbers: session.ShowLineNumbers,
		ShowAskPanel:    session.ShowAskPanel,
		Smart:           tier == domain.TierSmart,
	}
}

func (h *SessionHandler) RegisterPaths(r chi.Router) {
	r.Post("/api/session/toggle/{panel}", h.handlePanelToggle)
	r.Post("/api/session/layout", h.handleSessionLayout)
	r.Get("/ui/views/session/layout", h.handleLayoutView)
}

// handlePanelToggle flips one panel's visibility flag in the session, saves,
// broadcasts the session invalidation and answers 204. The page learns the new
// state by refetching the layout view on that broadcast.
func (h *SessionHandler) handlePanelToggle(w http.ResponseWriter, r *http.Request) {
	session := h.ServiceProvider.State.LoadSession()

	switch panel := chi.URLParam(r, "panel"); panel {
	case "sidebar":
		session.ShowSidebar = !session.ShowSidebar
	case "meta":
		session.ShowMeta = !session.ShowMeta
	case "prompts":
		session.ShowPrompts = !session.ShowPrompts
		if h.EmitPromptsChanged != nil {
			h.EmitPromptsChanged()
		}
	case "toolbar":
		session.ShowToolbar = !session.ShowToolbar
	case "linenumbers":
		session.ShowLineNumbers = !session.ShowLineNumbers
	case "askpanel":
		session.ShowAskPanel = !session.ShowAskPanel
	default:
		http.Error(w, "unknown panel: "+panel, http.StatusNotFound)
		return
	}
	_ = h.ServiceProvider.State.SaveSession(session)
	h.emitSessionChanged()
	w.WriteHeader(http.StatusNoContent)
}

func (h *SessionHandler) emitSessionChanged() {
	if h.EmitSessionChanged != nil {
		h.EmitSessionChanged()
	}
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
	h.emitSessionChanged()
	w.WriteHeader(http.StatusNoContent)
}

// handleLayoutView renders the session layout state element from the current
// session and tier.
func (h *SessionHandler) handleLayoutView(w http.ResponseWriter, r *http.Request) {
	view := NewSessionLayoutView(h.ServiceProvider.State.LoadSession(), h.ServiceProvider.State.LoadSettings().Tier())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := h.Tmpl.ExecuteTemplate(w, "session_layout.html", view); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
