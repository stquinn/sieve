package requesthandlers

import (
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/ink"

	"github.com/go-chi/chi/v5"
)

// InkHandler serves Settings → Ink: the status fragment, its two actions, which take effect at
// once and answer with the fragment, and the export of a synced note's page.
type InkHandler struct {
	ServiceProvider *sieve.ServiceProvider
	Tmpl            *template.Template
}

// inkView is the payload of ink_status.html.
type inkView struct {
	Enabled    bool
	Supported  bool
	Key        string
	SieveID    string
	Link       string
	Problem    string
	Session    *inkSessionView
	Companions []ink.Companion
	Notes      []ink.SyncedNote
	// Error is an action that failed, in words.
	Error string
}

// inkSessionView is a session's numbers as they are shown.
type inkSessionView struct {
	Connect    string
	Records    int
	Received   string
	CatchUp    string
	Throughput string
}

func (h *InkHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/settings/ink", h.handleStatus)
	r.Post("/api/ink/enabled", h.handleEnabled)
	r.Post("/api/ink/key", h.handleNewKey)
	r.Get("/api/ink/notes/{uuid}/pages/{page}/export", h.handleExport)
}

func (h *InkHandler) handleStatus(w http.ResponseWriter, r *http.Request) {
	h.render(w, "")
}

// handleEnabled turns Ink on when the form carries ink_enabled, and off when it does not.
func (h *InkHandler) handleEnabled(w http.ResponseWriter, r *http.Request) {
	if h.ServiceProvider.Ink == nil {
		http.Error(w, "ink unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	failure := ""
	if err := h.ServiceProvider.Ink.SetEnabled(r.PostForm.Get("ink_enabled") != ""); err != nil {
		logger.Error("ink: switching failed", "err", err.Error())
		failure = "Could not switch Ink: " + err.Error()
	}
	h.render(w, failure)
}

func (h *InkHandler) handleNewKey(w http.ResponseWriter, r *http.Request) {
	if h.ServiceProvider.Ink == nil {
		http.Error(w, "ink unavailable", http.StatusServiceUnavailable)
		return
	}
	failure := ""
	if err := h.ServiceProvider.Ink.NewKey(); err != nil {
		logger.Error("ink: minting a key failed", "err", err.Error())
		failure = "Could not make a new key: " + err.Error()
	}
	h.render(w, failure)
}

func (h *InkHandler) handleExport(w http.ResponseWriter, r *http.Request) {
	if h.ServiceProvider.Ink == nil {
		http.Error(w, "ink unavailable", http.StatusServiceUnavailable)
		return
	}
	page, err := strconv.Atoi(chi.URLParam(r, "page"))
	if err != nil {
		http.Error(w, "a page is its index", http.StatusNotFound)
		return
	}
	exported, err := h.ServiceProvider.Ink.ExportPage(chi.URLParam(r, "uuid"), page)
	if errors.Is(err, ink.ErrNoSuchPage) {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(exported)
}

// render writes the status fragment, with failure shown when an action failed.
func (h *InkHandler) render(w http.ResponseWriter, failure string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if h.ServiceProvider.Ink == nil {
		return
	}
	view := h.view(h.ServiceProvider.Ink.Status())
	view.Error = failure
	if err := h.Tmpl.ExecuteTemplate(w, "ink_status.html", view); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// view is st as the fragment shows it.
func (h *InkHandler) view(st ink.Status) inkView {
	v := inkView{
		Enabled: st.Enabled, Supported: st.Supported, Key: st.Key, SieveID: st.SieveID,
		Link: h.linkText(st.Link), Problem: st.Link.Problem, Companions: st.Companions, Notes: st.Notes,
	}
	if st.HasSession {
		n := st.Session
		v.Session = &inkSessionView{
			Connect:    h.duration(n.Connect),
			Records:    n.Records,
			Received:   fmt.Sprintf("%.1f kB", float64(n.Bytes)/1000),
			CatchUp:    h.duration(n.CatchUp),
			Throughput: fmt.Sprintf("%.1f kB/s", n.KBps()),
		}
	}
	return v
}

// linkText is the link's state in words.
func (h *InkHandler) linkText(state ink.LinkState) string {
	switch state.Phase {
	case ink.LinkConnected:
		return "Connected to " + state.Companion
	case ink.LinkLooking:
		return "Looking for a companion"
	default:
		return "Off"
	}
}

// duration is d to the millisecond.
func (h *InkHandler) duration(d time.Duration) string {
	return d.Round(time.Millisecond).String()
}
