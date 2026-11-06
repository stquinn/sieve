package requesthandlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"sync"
	"time"

	"sieve/logger"
	"sieve/sieve"
	"sieve/sieve/ink"
	"sieve/sieve/ink/link"
	"sieve/sieve/protocol"

	"github.com/go-chi/chi/v5"
)

// InkHandler serves Settings → Ink: the status fragment, its two actions, which take effect at
// once and answer with the fragment, and the export of a synced note's page; and the sidebar's Ink
// section.
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

// inkSidebarView is the payload of ink_sidebar.html, which shows nothing while Ink is disabled.
type inkSidebarView struct {
	Enabled bool
	// Live is the Live view while it exists, otherwise nil.
	Live  *inkLiveItem
	Notes []inkNoteItem
}

// inkLiveItem is the Live view as the sidebar lists it.
type inkLiveItem struct {
	UUID   string
	Device string
	// Note is the title of the note being written.
	Note    string
	Waiting bool
	// Active is the Live view being the active tab.
	Active bool
}

// inkNoteItem is a synced note as the sidebar lists it.
type inkNoteItem struct {
	UUID   string
	Title  string
	Pages  int
	Active bool
}

// inkRateFloor is the shortest catch-up a throughput is shown for.
const inkRateFloor = 50 * time.Millisecond

func (h *InkHandler) RegisterPaths(r chi.Router) {
	r.Get("/ui/views/settings/ink", h.handleStatus)
	r.Get("/ui/views/sidebar/ink", h.handleSidebar)
	r.Post("/api/ink/enabled", h.handleEnabled)
	r.Post("/api/ink/key", h.handleNewKey)
	r.Get("/api/ink/notes/{uuid}/pages/{page}/export", h.handleExport)
}

func (h *InkHandler) handleStatus(w http.ResponseWriter, r *http.Request) {
	h.render(w, "")
}

// handleSidebar writes the sidebar's Ink section.
func (h *InkHandler) handleSidebar(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if h.ServiceProvider.Ink == nil || h.ServiceProvider.State == nil {
		return
	}
	if err := h.Tmpl.ExecuteTemplate(w, "ink_sidebar.html", h.sidebarView(h.ServiceProvider.Ink.Status())); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// sidebarView is st as the sidebar's Ink section shows it, the active tab's item marked.
func (h *InkHandler) sidebarView(st ink.Status) inkSidebarView {
	if !st.Enabled {
		return inkSidebarView{}
	}
	active := ""
	if session := h.ServiceProvider.State.LoadSession(); session.ActiveIdx >= 0 && session.ActiveIdx < len(session.Tabs) {
		active = session.Tabs[session.ActiveIdx].ID
	}
	v := inkSidebarView{Enabled: true, Notes: make([]inkNoteItem, 0, len(st.Notes))}
	if live := st.Live; live.Present {
		v.Live = &inkLiveItem{UUID: live.UUID, Device: live.Device, Note: live.NoteTitle, Waiting: live.Waiting, Active: live.UUID == active}
	}
	for _, n := range st.Notes {
		title := n.Title
		if title == "" {
			title = "Untitled note"
		}
		v.Notes = append(v.Notes, inkNoteItem{UUID: n.UUID, Title: title, Pages: n.Pages, Active: n.UUID == active})
	}
	return v
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

// inkStream carries one InkService's events to the document sockets they concern, and answers
// those sockets' page requests from the notes it holds open for them. A note's events go to the
// socket that has its container open and, while the Live view mirrors it, to the Live view's
// socket; a page request on the Live view's socket is answered from the note it mirrors. Each
// socket holds the notes it asked pages of until it releases them, so the page answers and stroke
// frames each socket hears stay consistent by their seqs.
//
// It is the service's Listener, so its listener methods run one at a time on the service's
// goroutine for it: a socket slow to take a frame holds back only this stream's queue, never the
// link.
type inkStream struct {
	svc  *ink.InkService
	send func(uuid string, frame interface{})
	// notes are held by socket: a container's uuid, or the Live view's.
	notes *ink.OpenNotes
	// view is the Live view's uuid.
	view string

	// pen and live are the listener's own, touched only by its methods.
	pen ink.LivePen
	// live is the container the service last named live, "" when none.
	live string

	// mirrorMu guards mirrored, the container whose note the Live view's socket holds; "" when
	// it holds none.
	mirrorMu sync.Mutex
	mirrored string

	// window is the tablet's window on the live page, replayed to the Live view's socket.
	window tabletWindow
}

// tabletWindow is where the tablet's window lies on the live page while it is known: the
// top-left of the last VIEW, or before any VIEW the origin of the last BEGIN, which is the
// window's top-left when the pen landed. It is forgotten when another page, or none, becomes
// live. Its lock also orders the frames that carry it, so a replay never overtakes a newer
// window on the same socket. It is safe for concurrent use.
type tabletWindow struct {
	mu sync.Mutex
	// on is the live container and page the window is on; the zero LiveNote when none is live.
	on     ink.LiveNote
	known  bool
	viewed bool
	x, y   float64
}

// follow is live becoming the live note and page: a window on another page is forgotten.
func (w *tabletWindow) follow(live ink.LiveNote) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if live.Container != w.on.Container || live.Page != w.on.Page {
		w.on, w.known, w.viewed = live, false, false
	}
}

// hear takes the window marks tell of, then sends while still holding the lock.
func (w *tabletWindow) hear(marks []ink.LiveMark, send func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, m := range marks {
		switch {
		case m.Type == link.LiveView:
			w.known, w.viewed, w.x, w.y = true, true, m.X, m.Y
		case m.Type == link.LiveBegin && !w.viewed:
			w.known, w.x, w.y = true, m.X, m.Y
		}
	}
	send()
}

// replay sends through reply, as a view, the window on page of container while one is known.
func (w *tabletWindow) replay(container string, page link.ID, reply func(interface{})) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.known || w.on.Container != container || w.on.Page != page {
		return
	}
	reply(protocol.NewInkLiveFrame([]protocol.InkLiveRecord{{Record: protocol.InkLiveView, X: w.x, Y: w.y}}))
}

var _ ink.Listener = (*inkStream)(nil)

// newInkStream subscribes a stream to svc that sends through send, a uuid naming the socket that
// has it open.
func newInkStream(svc *ink.InkService, send func(uuid string, frame interface{})) *inkStream {
	s := &inkStream{svc: svc, send: send, notes: ink.NewOpenNotes(svc), view: svc.LiveView().UUID()}
	svc.Subscribe(s)
	return s
}

// close unsubscribes the stream.
func (s *inkStream) close() { s.svc.Unsubscribe(s) }

// answerPage answers an ink-page asked on socket through reply, from the note of the socket's
// container or, on the Live view's socket, of the note it mirrors. The socket holds that note open
// from now until it releases it. Every answer is followed by the live page while the note is the
// live one and, on the Live view's socket when the page answered is the live page, by the
// tablet's window while it is known.
func (s *inkStream) answerPage(socket string, msg protocol.InkPageFrame, reply func(interface{})) {
	refuse := func(err error) { reply(protocol.NewInkPageRefusedFrame(msg.OpID, msg.PageID, err)) }
	page, err := link.ParseID(msg.PageID)
	if err != nil {
		refuse(fmt.Errorf("%w: page %q: %v", ink.ErrNoSuchPage, msg.PageID, err))
		return
	}
	container := socket
	if socket == s.view {
		s.mirrorMu.Lock()
		defer s.mirrorMu.Unlock()
		mirrored, present := s.svc.LiveView().Mirrors()
		if !present || mirrored == "" {
			refuse(fmt.Errorf("%w: the Live view mirrors no note", ink.ErrNoSuchPage))
			return
		}
		if s.mirrored != "" && s.mirrored != mirrored {
			s.notes.Release(s.mirrored, socket)
		}
		s.mirrored, container = mirrored, mirrored
	}
	note, err := s.notes.Open(container, socket)
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
		return
	}
	if live := s.svc.Live(); live.Container == container {
		reply(protocol.NewInkLivePageFrame(live.Page.String(), s.view))
		if socket == s.view && live.Page == page {
			s.window.replay(container, page, reply)
		}
	}
}

// openOnTablet asks the tablet to open the Digital Note in container, and answers through reply
// with what came of it. It waits for the tablet, so it runs on a goroutine of its own.
func (s *inkStream) openOnTablet(container string, msg protocol.InkOpenOnTabletFrame, reply func(interface{})) {
	result, err := s.svc.OpenOnTablet(container)
	if err != nil {
		reply(protocol.NewInkOpenOnTabletFailedFrame(msg.OpID, err))
		return
	}
	reply(protocol.NewInkOpenOnTabletResultFrame(msg.OpID, s.outcomeWord(result.Outcome), result.Reason))
}

// outcomeWord is an outcome as an ink-open-on-tablet-result names it.
func (s *inkStream) outcomeWord(o ink.OpenOutcome) string {
	switch o {
	case ink.OpenOpened:
		return protocol.InkOpenOpened
	case ink.OpenOtherTablet:
		return protocol.InkOpenOtherTablet
	case ink.OpenRefused:
		return protocol.InkOpenRefused
	case ink.OpenNoAnswer:
		return protocol.InkOpenNoAnswer
	default:
		return protocol.InkOpenNoTablet
	}
}

// release stops socket holding any note open.
func (s *inkStream) release(socket string) {
	if socket == s.view {
		s.mirrorMu.Lock()
		s.mirrored = ""
		s.mirrorMu.Unlock()
	}
	s.notes.ReleaseAll(socket)
}

func (s *inkStream) LinkChanged(ink.LinkState) {}

// RecordCommitted sends the stroke change rec made, if any, to every socket holding the
// container's note open.
func (s *inkStream) RecordCommitted(container string, _ link.ID, rec link.Record) {
	s.notes.Commit(container, rec, func(holders []string, c ink.StrokeChange) {
		frame, err := s.strokeFrame(c)
		if err != nil {
			logger.Error("ink: exporting a committed stroke", "container", container, "seq", c.Seq, "err", err.Error())
			return
		}
		for _, socket := range holders {
			s.send(socket, frame)
		}
	})
}

// strokeFrame is the frame of a stroke change.
func (s *inkStream) strokeFrame(c ink.StrokeChange) (interface{}, error) {
	if c.Added == nil {
		return protocol.NewInkStrokeRemovedFrame(c.Page.String(), c.Seq, c.Removed.String()), nil
	}
	raw, err := c.ExportStroke()
	var stroke protocol.InkExportStroke
	if err == nil {
		err = json.Unmarshal(raw, &stroke)
	}
	if err != nil {
		return nil, err
	}
	return protocol.NewInkStrokeAddedFrame(c.Page.String(), c.Seq, stroke), nil
}

// LiveInk sends records, as marks in page units, to the live container's socket and the Live
// view's, and keeps the tablet's window they tell of.
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
	frame := protocol.NewInkLiveFrame(wire)
	s.window.hear(marks, func() {
		s.send(s.live, frame)
		s.send(s.view, frame)
	})
}

// LiveChanged tells the container that stops being live that it has, the live one which page,
// and the Live view's socket both; a Live view's socket that held another note stops holding it.
func (s *inkStream) LiveChanged(live ink.LiveNote) {
	was := s.live
	s.live = live.Container
	s.window.follow(live)
	page := ""
	if live.Container != "" {
		page = live.Page.String()
	}
	if was != "" && was != live.Container {
		s.send(was, protocol.NewInkLivePageFrame("", s.view))
	}
	if live.Container != "" {
		s.send(live.Container, protocol.NewInkLivePageFrame(page, s.view))
	}
	s.mirrorMu.Lock()
	if live.Container != "" && s.mirrored != "" && s.mirrored != live.Container {
		s.notes.Release(s.mirrored, s.view)
		s.mirrored = ""
	}
	s.mirrorMu.Unlock()
	s.send(s.view, protocol.NewInkLivePageFrame(page, s.view))
}

// LogRestarted starts the container's open note again from its restarted log and tells every
// socket holding it so, before any stroke frame of the new log.
func (s *inkStream) LogRestarted(container string, _ link.ID) {
	s.notes.Restart(container, func(holders []string) {
		for _, socket := range holders {
			s.send(socket, protocol.NewInkLogRestartedFrame())
		}
	})
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
