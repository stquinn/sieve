package requesthandlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/ink"
	"sieve/sieve/ink/link"
	"sieve/sieve/protocol"

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
	Connect  string
	Records  int
	Received string
	CatchUp  string
	// Throughput is "" when the catch-up was too short for a rate to mean anything.
	Throughput string
}

// inkRateFloor is the shortest catch-up a throughput is shown for.
const inkRateFloor = 50 * time.Millisecond

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
		v.Session = &inkSessionView{}
		v.Session.show(st.Session)
	}
	return v
}

// show fills the view with n.
func (v *inkSessionView) show(n ink.SessionNumbers) {
	v.Connect, v.Records, v.CatchUp = v.duration(n.Connect), n.Records, v.duration(n.CatchUp)
	v.Received = fmt.Sprintf("%.1f kB", float64(n.Bytes)/1000)
	v.Throughput = ""
	if n.CatchUp >= inkRateFloor {
		v.Throughput = fmt.Sprintf("%.1f kB/s", n.KBps())
	}
}

// duration is d in whole milliseconds under a second, and in seconds to a tenth from one up.
func (v *inkSessionView) duration(d time.Duration) string {
	ms := d.Round(time.Millisecond)
	switch {
	case d <= 0:
		return "0 ms"
	case ms == 0:
		return "under 1 ms"
	case ms < time.Second:
		return fmt.Sprintf("%d ms", ms.Milliseconds())
	default:
		return fmt.Sprintf("%.1f s", d.Seconds())
	}
}

// inkStream carries one InkService's events to the document socket of the container each concerns,
// and answers that socket's page requests from the notes it holds open for them. It is the
// service's Listener, so its listener methods run one at a time on the service's goroutine for
// it: a socket slow to take a frame holds back only this stream's queue, never the link.
type inkStream struct {
	svc   *ink.InkService
	send  func(uuid string, frame interface{})
	notes *ink.OpenNotes

	// pen and live are the listener's own, touched only by its methods.
	pen ink.LivePen
	// live is the container the service last named live, "" when none.
	live string
}

var _ ink.Listener = (*inkStream)(nil)

// newInkStream subscribes a stream to svc that sends through send, a container's uuid naming the
// socket that has it open.
func newInkStream(svc *ink.InkService, send func(uuid string, frame interface{})) *inkStream {
	s := &inkStream{svc: svc, send: send, notes: ink.NewOpenNotes(svc)}
	svc.Subscribe(s)
	return s
}

// close unsubscribes the stream.
func (s *inkStream) close() { s.svc.Unsubscribe(s) }

// answerPage answers an ink-page for container uuid through reply, holding the container's note
// open from now until release.
func (s *inkStream) answerPage(uuid string, msg protocol.InkPageFrame, reply func(interface{})) {
	refuse := func(err error) { reply(protocol.NewInkPageRefusedFrame(msg.OpID, msg.PageID, err)) }
	page, err := link.ParseID(msg.PageID)
	if err != nil {
		refuse(fmt.Errorf("%w: page %q: %v", ink.ErrNoSuchPage, msg.PageID, err))
		return
	}
	note, err := s.notes.Open(uuid)
	if err != nil {
		refuse(err)
		return
	}
	err = note.AnswerPage(page, func(export []byte, seq uint32) error {
		var decoded protocol.InkPageExport
		if err := json.Unmarshal(export, &decoded); err != nil {
			return err
		}
		reply(protocol.NewInkPageContentFrame(msg.OpID, msg.PageID, seq, decoded))
		return nil
	})
	if err != nil {
		refuse(err)
	}
}

// release stops holding container uuid's note open.
func (s *inkStream) release(uuid string) { s.notes.Release(uuid) }

func (s *inkStream) LinkChanged(ink.LinkState) {}

// RecordCommitted sends the stroke change rec made, if any, to the container's socket when its
// note is held open.
func (s *inkStream) RecordCommitted(container string, _ link.ID, rec link.Record) {
	s.notes.Commit(container, rec, func(c ink.StrokeChange) {
		if c.Added == nil {
			s.send(container, protocol.NewInkStrokeRemovedFrame(c.Page.String(), c.Seq, c.Removed.String()))
			return
		}
		raw, err := c.ExportStroke()
		var stroke protocol.InkExportStroke
		if err == nil {
			err = json.Unmarshal(raw, &stroke)
		}
		if err != nil {
			logger.Error("ink: exporting a committed stroke", "container", container, "seq", c.Seq, "err", err.Error())
			return
		}
		s.send(container, protocol.NewInkStrokeAddedFrame(c.Page.String(), c.Seq, stroke))
	})
}

// LiveInk sends records, as marks in page units, to the live container's socket.
func (s *inkStream) LiveInk(records []link.LiveRecord) {
	marks := s.pen.Marks(records)
	if s.live == "" || len(marks) == 0 {
		return
	}
	wire := make([]protocol.InkLiveRecord, len(marks))
	for i, m := range marks {
		wire[i] = protocol.InkLiveRecord{Record: s.recordWord(m.Type), Stroke: m.Stroke, X: m.X, Y: m.Y,
			Pressure: m.Pressure, TMillis: m.TMillis, TiltX: m.TiltX, TiltY: m.TiltY}
		if m.Type == link.LiveBegin {
			wire[i].Tool, wire[i].WidthClass = m.Tool.String(), m.WidthClass
		}
	}
	s.send(s.live, protocol.NewInkLiveFrame(wire))
}

// LiveChanged tells the container that stops being live that it has, and the live one which page.
func (s *inkStream) LiveChanged(live ink.LiveNote) {
	was := s.live
	s.live = live.Container
	if was != "" && was != live.Container {
		s.send(was, protocol.NewInkLivePageFrame(""))
	}
	if live.Container != "" {
		s.send(live.Container, protocol.NewInkLivePageFrame(live.Page.String()))
	}
}

// recordWord is a live mark's type as an ink-live record names it.
func (s *inkStream) recordWord(t link.LiveType) string {
	switch t {
	case link.LiveBegin:
		return protocol.InkLiveBegin
	case link.LivePoint:
		return protocol.InkLivePoint
	case link.LiveEnd:
		return protocol.InkLiveEnd
	case link.LiveRemove:
		return protocol.InkLiveRemove
	default:
		return protocol.InkLiveView
	}
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
