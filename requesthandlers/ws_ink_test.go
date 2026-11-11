package requesthandlers

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/ink"
	"sieve/sieve/ink/link"
	"sieve/sieve/ink/radio"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
	"sieve/store"
)

// The companion's ids in these tests.
var (
	inkKey    = link.Key{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'}
	inkNoteID = inkID(0xa0)
	inkPage1  = inkID(0x11)
	inkPage2  = inkID(0x12)
)

func inkID(n byte) link.ID     { return link.ID{0x01, 0x9a, 6: 0x70, 8: 0x80, 15: n} }
func inkStroke(n byte) link.ID { return inkID(0x40 + n) }

// inkLog is a note's log: a header, page 1, and then ops, numbered from seq 1.
func inkLog(ops ...link.Record) []link.Record {
	records := append([]link.Record{
		{Op: link.OpNoteHeader, Note: inkNoteID, CreatedMillis: 1_700_000_000_000, Title: "Ideas", PageAspect: 0.75,
			Device: link.Device{ID: "d", Name: "Note Air 2", Model: "ONYX"}},
		{Op: link.OpPageAdd, Page: inkPage1, Bounds: link.BoundsFixed},
	}, ops...)
	for i := range records {
		records[i].Seq = uint32(i + 1)
	}
	return records
}

func inkStrokeAdd(page, stroke link.ID) link.Record {
	return link.Record{Op: link.OpStrokeAdd, Page: page, Stroke: stroke, Tool: link.ToolPen, WidthClass: 2, StartMillis: 5,
		Points: []link.Point{{X: 0.25, Y: 0.5, Pressure: 0.75}}}
}

// inkWhiteboardLog is a note whose one page, inkPage1, is a whiteboard.
func inkWhiteboardLog() []link.Record {
	return []link.Record{
		{Seq: 1, Op: link.OpNoteHeader, Note: inkNoteID, CreatedMillis: 1_700_000_000_000, Title: "Board", PageAspect: 0.75,
			Device: link.Device{ID: "d", Name: "Note Air 2", Model: "ONYX"}},
		{Seq: 2, Op: link.OpPageAdd, Page: inkPage1, Bounds: link.BoundsUnbounded},
	}
}

// liveBegin is a live BEGIN of stroke n whose origin is (x, y) in page units.
func liveBegin(n uint32, x, y float64) []byte {
	le := binary.LittleEndian
	b := le.AppendUint32([]byte{byte(link.LiveBegin)}, n)
	b = append(b, byte(link.ToolPen), 2)
	b = le.AppendUint32(b, 100)
	b = le.AppendUint32(b, uint32(int32(x*32768)))
	return le.AppendUint32(b, uint32(int32(y*32768)))
}

// liveView is a live VIEW whose top-left is (x, y) in page units.
func liveView(x, y float64) []byte {
	le := binary.LittleEndian
	b := le.AppendUint32([]byte{byte(link.LiveView)}, uint32(int32(x*32768)))
	return le.AppendUint32(b, uint32(int32(y*32768)))
}

// nextInk reads c until n ink frames have come, and returns them.
func nextInk(t *testing.T, c *websocket.Conn, n int) []map[string]interface{} {
	t.Helper()
	var out []map[string]interface{}
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	for len(out) < n {
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read after %v: %v", out, err)
		}
		var f map[string]interface{}
		if json.Unmarshal(raw, &f) == nil && strings.HasPrefix(fmt.Sprint(f["type"]), "ink-") {
			out = append(out, f)
		}
	}
	return out
}

// inkWire is the document wire's harness with Ink enabled over a scripted companion reached
// through the TCP radio on a loopback socket.
type inkWire struct {
	t         *testing.T
	srv       *httptest.Server
	sp        *sieve.ServiceProvider
	h         *WsHandler
	companion *link.ScriptedCompanion
	// addr is where the companion listens.
	addr string
}

func newInkWire(t *testing.T, records []link.Record) *inkWire {
	t.Helper()
	return newInkWireOver(t, records, newTestFileStore(t))
}

// newInkWireOver is newInkWire over the store st.
func newInkWireOver(t *testing.T, records []link.Record, st store.Store) *inkWire {
	t.Helper()
	srv, sp, h, _ := newWsTestServerOver(t, 0, nil, st)
	block.RegisterProcessor(ink.NewDigitalNoteKind())
	w := &inkWire{t: t, srv: srv, sp: sp, h: h, companion: link.NewScriptedCompanion(inkKey, inkNoteID, inkPage1, records)}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	w.addr = listener.Addr().String()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_ = w.companion.Serve(conn)
				conn.Close()
			}()
		}
	}()
	settings := sp.State.LoadSettings()
	settings.Ink = domain.InkSettings{Enabled: true, Key: inkKey.Text()}
	if err := sp.State.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	sp.Ink = ink.NewInkService(sp.State, sp.Containers, radio.NewTCP(listener.Addr().String(), "companion"), nil)
	t.Cleanup(sp.Ink.Stop)
	sp.Nodes = editor.NewRouter(editor.NewBlockSource(sp.Containers), sp.Ink.LiveView())
	sp.Editor.SetNodes(sp.Nodes)
	sp.Ink.SetChangeListener(sp.Editor)
	return w
}

// routes serves the Ink handler's routes over the wire's services.
func (w *inkWire) routes() *httptest.Server {
	w.t.Helper()
	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		w.t.Fatal(err)
	}
	r := chi.NewRouter()
	(&InkHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	srv := httptest.NewServer(r)
	w.t.Cleanup(srv.Close)
	return srv
}

// untilNotLive reads c until a live-page frame says nothing is live.
func untilNotLive(t *testing.T, c *websocket.Conn) {
	t.Helper()
	for {
		if live := readUntil(t, c, protocol.TypeInkLivePage, 5*time.Second); live["live"] != true {
			return
		}
	}
}

// session runs the companion's log to its head over one session, then stops the service.
func (w *inkWire) session(records []link.Record) {
	w.t.Helper()
	w.companion.SetRecords(records)
	if err := w.sp.Ink.Start(); err != nil {
		w.t.Fatal(err)
	}
	waitFor(w.t, func() bool {
		st := w.sp.Ink.Status()
		return st.Link.Phase == ink.LinkConnected && len(st.Notes) == 1 && st.Notes[0].Seq == uint32(len(records))
	}, "the session to catch up")
	w.sp.Ink.Stop()
}

// container is the uuid of the container holding the note.
func (w *inkWire) container() string {
	w.t.Helper()
	notes := w.sp.Ink.Status().Notes
	if len(notes) != 1 {
		w.t.Fatalf("notes %+v", notes)
	}
	return notes[0].UUID
}

// askPage sends an ink-page on c and returns its answer.
func (w *inkWire) askPage(c *websocket.Conn, pageID string) map[string]interface{} {
	w.t.Helper()
	send(w.t, c, `{"type":"ink-page","opId":"op-page","pageId":"`+pageID+`"}`)
	return readUntil(w.t, c, protocol.TypeInkPageContent, 2*time.Second)
}

// holds reports whether the wire holds container uuid's note open.
func (w *inkWire) holds(uuid string) bool {
	stream := w.h.inkStream()
	return stream != nil && stream.notes.Holds(uuid)
}

// inkFrames reads c until the page stops being live, returning every ink frame read in one line
// each, in order, and how many pages the last block attrs frame read lists.
func inkFrames(t *testing.T, c *websocket.Conn) ([]string, int) {
	t.Helper()
	var out []string
	pages := 0
	deadline := time.Now().Add(5 * time.Second)
	for {
		_ = c.SetReadDeadline(deadline)
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read ink frames after %v: %v", out, err)
		}
		var f struct {
			Type, PageID, StrokeID string
			Seq                    uint32
			Live                   bool
			Stroke                 json.RawMessage
			Records                []protocol.InkLiveRecord
			Attrs                  struct {
				Note struct{ Pages []interface{} }
			}
		}
		if json.Unmarshal(raw, &f) != nil {
			continue
		}
		if f.Type == protocol.TypeBlockAttrsUpdated {
			pages = len(f.Attrs.Note.Pages)
		}
		if !strings.HasPrefix(f.Type, "ink-") {
			continue
		}
		switch f.Type {
		case protocol.TypeInkLivePage:
			out = append(out, fmt.Sprintf("live %t %s", f.Live, f.PageID))
			if !f.Live {
				return out, pages
			}
		case protocol.TypeInkLive:
			for _, r := range f.Records {
				out = append(out, fmt.Sprintf("%s %d %s %d (%g, %g) %g %d", r.Record, r.Stroke, r.Tool, r.WidthClass, r.X, r.Y, r.Pressure, r.TMillis))
			}
		case protocol.TypeInkStrokeAdded:
			var stroke protocol.InkExportStroke
			_ = json.Unmarshal(f.Stroke, &stroke)
			out = append(out, fmt.Sprintf("added %d %s %s", f.Seq, f.PageID, stroke.ID))
		case protocol.TypeInkStrokeRemoved:
			out = append(out, fmt.Sprintf("removed %d %s %s", f.Seq, f.PageID, f.StrokeID))
		default:
			out = append(out, f.Type)
		}
	}
}

// The page asked for is answered in the export shape at the seq its log reaches; a page the note
// does not have, a page that is no id, and a container that is no Digital Note are refused with an
// error and no page.
func TestWS_InkPage_AnswersAPageAndRefusesWhatIsNone(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)), inkStrokeAdd(inkPage1, inkStroke(2)))
	w := newInkWire(t, records)
	w.session(records)
	uuid := w.container()

	c := dialWS(t, w.srv, uuid)
	answer := w.askPage(c, inkPage1.String())
	raw, _ := json.Marshal(answer["page"])
	var page protocol.InkPageExport
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	if answer["opId"] != "op-page" || answer["pageId"] != inkPage1.String() || answer["seq"] != float64(len(records)) ||
		answer["error"] != nil || page.Note.Title != "Ideas" || len(page.Strokes) != 2 || page.Strokes[1].ID != inkStroke(2).String() {
		t.Errorf("answer %v", answer)
	}
	for _, pageID := range []string{inkPage2.String(), "first"} {
		refused := w.askPage(c, pageID)
		if msg, _ := refused["error"].(string); msg == "" || refused["page"] != nil || refused["pageId"] != pageID {
			t.Errorf("page %q answered %v", pageID, refused)
		}
	}
	closeAndSettle(c)

	other := newContainerOnWire(t, w.sp)
	c = dialWS(t, w.srv, other.UUID())
	if refused := w.askPage(c, inkPage1.String()); !strings.Contains(refused["error"].(string), "code") || refused["page"] != nil {
		t.Errorf("a code container answered %v", refused)
	}
	closeAndSettle(c)
}

// End to end from the companion: while a note's page is held, the strokes a session commits reach
// its socket as stroke frames above the page's seq, the live page and the live records — a view
// among them — arrive in the tablet's order, a page added reaches it as the block's attrs frame and
// as no ink frame, the page stops being live when the session ends, and another container's socket
// hears none of it. Closing the socket releases the note, and a session with no socket open holds
// nothing.
func TestWS_Ink_ASessionReachesTheSocketHoldingTheNote(t *testing.T) {
	first := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	all := append(append([]link.Record(nil), first...),
		inkStrokeAdd(inkPage1, inkStroke(2)),
		link.Record{Op: link.OpStrokeRemove, Page: inkPage1, Stroke: inkStroke(1)},
		inkStrokeAdd(inkPage1, inkStroke(2)),
		link.Record{Op: link.OpPageAdd, Page: inkPage2, Index: 1, Bounds: link.BoundsFixed})
	for i := range all {
		all[i].Seq = uint32(i + 1)
	}
	w := newInkWire(t, first)
	w.session(first)
	uuid := w.container()

	c := dialWS(t, w.srv, uuid)
	if answer := w.askPage(c, inkPage1.String()); answer["seq"] != float64(len(first)) {
		t.Fatalf("answer %v", answer)
	}
	elsewhere := dialWS(t, w.srv, newContainerOnWire(t, w.sp).UUID())

	le := binary.LittleEndian
	feed := []byte{byte(link.LiveBegin)}
	feed = le.AppendUint32(feed, 7)
	feed = append(feed, byte(link.ToolPencil), 1)
	feed = le.AppendUint32(feed, 100)
	feed = le.AppendUint32(feed, uint32(16384))
	feed = le.AppendUint32(feed, uint32(8192))
	feed = append(feed, byte(link.LivePoint))
	feed = le.AppendUint32(feed, 7)
	feed = le.AppendUint16(feed, 8192)
	feed = le.AppendUint16(feed, 16384)
	feed = le.AppendUint16(feed, 65535)
	feed = append(feed, 0, 0)
	feed = le.AppendUint32(feed, 125)
	feed = append(feed, byte(link.LiveView))
	viewLeft := int32(-32768)
	feed = le.AppendUint32(feed, uint32(viewLeft))
	feed = le.AppendUint32(feed, uint32(65536))
	w.companion.Live, w.companion.Ink = true, feed
	w.session(all)

	p1 := inkPage1.String()
	want := []string{
		"live true " + p1,
		"begin 7 pencil 1 (0.5, 0.25) 0 0",
		"point 7  0 (0.75, 0.75) 1 25",
		"view 0  0 (-1, 2) 0 0",
		"added 4 " + p1 + " " + inkStroke(2).String(),
		"removed 5 " + p1 + " " + inkStroke(1).String(),
		"live false ",
	}
	got, pages := inkFrames(t, c)
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("ink frames\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if pages != 2 {
		t.Errorf("the block's attrs frame lists %d pages, want the page the session added", pages)
	}
	expectNoMessage(t, elsewhere, `"type":"ink-`, 300*time.Millisecond)

	closeAndSettle(c)
	if w.holds(uuid) {
		t.Error("the closed socket's note is still held")
	}
	w.companion.Live = false
	w.session(append(all, link.Record{Seq: uint32(len(all) + 1), Op: link.OpStrokeAdd, Page: inkPage1, Stroke: inkStroke(3),
		Tool: link.ToolPen, WidthClass: 1, Points: []link.Point{{X: 0.5, Y: 0.5}}}))
	if w.holds(uuid) {
		t.Error("a session with no socket open held the note")
	}
	closeAndSettle(elsewhere)
}

// A socket that opens a note while the tablet is writing in it hears the live page, and the Live
// view mirroring it, after every page answer, and hears the page stop being live when the session
// ends.
func TestWS_Ink_ANoteOpenedWhileLiveIsToldItsLivePage(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	w.session(records)
	uuid := w.container()
	w.companion.Live = true
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return w.sp.Ink.Live().Container == uuid }, "the note to be live")

	c := dialWS(t, w.srv, uuid)
	if answer := w.askPage(c, inkPage1.String()); answer["seq"] != float64(len(records)) {
		t.Fatalf("answer %v", answer)
	}
	view := w.sp.Ink.LiveView().UUID()
	for _, answer := range []string{"the first answer", "a later answer"} {
		if answer != "the first answer" {
			w.askPage(c, inkPage1.String())
		}
		if live := readUntil(t, c, protocol.TypeInkLivePage, 2*time.Second); live["live"] != true || live["pageId"] != inkPage1.String() || live["view"] != view {
			t.Errorf("after %s: %v", answer, live)
		}
	}

	w.sp.Ink.Stop()
	if next := readUntil(t, c, protocol.TypeInkLivePage, 2*time.Second); next["live"] != false {
		t.Errorf("the next live page: %v, want the session's end", next)
	}
	closeAndSettle(c)
}

// A note whose replica is set aside while its socket holds a page restarts from the new log: the
// socket hears the log restart, and a page asked for again is answered from the new log at its head.
func TestWS_Ink_ARestartedLogReachesTheSocketHoldingTheNote(t *testing.T) {
	first := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	all := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)), inkStrokeAdd(inkPage1, inkStroke(2)), inkStrokeAdd(inkPage1, inkStroke(3)))
	w := newInkWire(t, first)
	w.session(first)
	uuid := w.container()

	c := dialWS(t, w.srv, uuid)
	if answer := w.askPage(c, inkPage1.String()); answer["seq"] != float64(len(first)) {
		t.Fatalf("answer %v", answer)
	}
	w.companion.SetRecords(all)
	w.companion.CorruptHead = true
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	readUntil(t, c, protocol.TypeInkLogRestarted, 5*time.Second)
	waitFor(t, func() bool {
		notes := w.sp.Ink.Status().Notes
		return len(notes) == 1 && notes[0].Seq == uint32(len(all))
	}, "the new log to reach its head")
	w.sp.Ink.Stop()

	answer := w.askPage(c, inkPage1.String())
	raw, _ := json.Marshal(answer["page"])
	var page protocol.InkPageExport
	if err := json.Unmarshal(raw, &page); err != nil {
		t.Fatal(err)
	}
	if answer["seq"] != float64(len(all)) || len(page.Strokes) != 3 {
		t.Errorf("answered at seq %v with %d strokes, want seq %d with 3", answer["seq"], len(page.Strokes), len(all))
	}
	closeAndSettle(c)
}

// While a note is live, the Live view's socket loads a block of the Live kind naming that note,
// is answered its pages from the note's own replay, and hears exactly what the note's own socket
// hears, each once and in the tablet's order: the live page, the live records with a view among
// them, the strokes committed above the seq each was answered at, the page added as the block's
// attrs frame, and the page no longer live.
func TestWS_Ink_TheLiveViewMirrorsTheLiveNoteBesideItsOwnSocket(t *testing.T) {
	first := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	all := append(append([]link.Record(nil), first...),
		inkStrokeAdd(inkPage1, inkStroke(2)),
		link.Record{Op: link.OpStrokeRemove, Page: inkPage1, Stroke: inkStroke(1)},
		link.Record{Op: link.OpPageAdd, Page: inkPage2, Index: 1, Bounds: link.BoundsFixed})
	for i := range all {
		all[i].Seq = uint32(i + 1)
	}
	w := newInkWire(t, first)
	w.session(first)
	uuid := w.container()
	view := w.sp.Ink.LiveView().UUID()
	w.companion.Live = true
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { mirrored, _ := w.sp.Ink.LiveView().Mirrors(); return mirrored == uuid }, "the Live view to mirror the note")
	if status, body := do(t, http.MethodGet, w.routes().URL+"/api/ink/live/note", "", ""); status != http.StatusOK || body != `{"note":"`+uuid+`"}`+"\n" {
		t.Errorf("the Live view's note is answered %d %s", status, body)
	}

	own, live := dialWS(t, w.srv, uuid), dialWS(t, w.srv, view)
	send(t, live, `{"type":"load","opId":"op-load"}`)
	reply := readUntil(t, live, protocol.TypeLoadContent, 2*time.Second)
	blocks, _ := reply["blocks"].([]interface{})
	first0, _ := blocks[0].(map[string]interface{})
	attrs, _ := first0["attrs"].(map[string]interface{})
	mirror, _ := attrs["live"].(map[string]interface{})
	if reply["kind"] != ink.KindLive || len(blocks) != 1 || first0["id"] != view || mirror["container"] != uuid ||
		mirror["page"] != inkPage1.String() || mirror["waiting"] != false {
		t.Fatalf("the Live view loads %v", reply)
	}
	for _, c := range []*websocket.Conn{own, live} {
		if answer := w.askPage(c, inkPage1.String()); answer["seq"] != float64(len(first)) || answer["error"] != nil {
			t.Fatalf("answer %v", answer)
		}
	}
	w.sp.Ink.Stop()
	for _, c := range []*websocket.Conn{own, live} {
		untilNotLive(t, c)
	}

	le := binary.LittleEndian
	feed := []byte{byte(link.LiveBegin)}
	feed = le.AppendUint32(feed, 7)
	feed = append(feed, byte(link.ToolPen), 2)
	feed = le.AppendUint32(feed, 100)
	feed = le.AppendUint32(feed, uint32(16384))
	feed = le.AppendUint32(feed, uint32(8192))
	feed = append(feed, byte(link.LiveView))
	feed = le.AppendUint32(feed, uint32(65536))
	feed = le.AppendUint32(feed, uint32(65536))
	w.companion.Ink = feed
	w.session(all)

	p1 := inkPage1.String()
	want := []string{
		"live true " + p1,
		"begin 7 pen 2 (0.5, 0.25) 0 0",
		"view 0  0 (2, 2) 0 0",
		"added 4 " + p1 + " " + inkStroke(2).String(),
		"removed 5 " + p1 + " " + inkStroke(1).String(),
		"live false ",
	}
	for name, c := range map[string]*websocket.Conn{"the note's socket": own, "the Live view's socket": live} {
		got, pages := inkFrames(t, c)
		if strings.Join(got, "\n") != strings.Join(want, "\n") {
			t.Errorf("%s heard\n%s\nwant\n%s", name, strings.Join(got, "\n"), strings.Join(want, "\n"))
		}
		if pages != 2 {
			t.Errorf("%s: the last attrs frame lists %d pages, want the page the session added", name, pages)
		}
	}
	closeAndSettle(own)
	if !w.holds(uuid) {
		t.Error("the note was let go while the Live view's socket still held it")
	}
	closeAndSettle(live)
	if w.holds(uuid) {
		t.Error("the note is still held with both sockets closed")
	}
}

// When the tablet moves from one note to another, the Live view's attrs name the new note, the
// old note's strokes stop reaching the Live view's socket, and its pages are answered from the new
// note alone.
func TestWS_Ink_TheLiveViewFollowsTheTabletFromNoteToNote(t *testing.T) {
	board, boardPage := inkID(0xb0), inkID(0x21)
	boardLog := []link.Record{
		{Seq: 1, Op: link.OpNoteHeader, Note: board, CreatedMillis: 1_700_000_000_000, Title: "Board", PageAspect: 0.75,
			Device: link.Device{ID: "d", Name: "Note Air 2", Model: "ONYX"}},
		{Seq: 2, Op: link.OpPageAdd, Page: boardPage, Bounds: link.BoundsUnbounded},
	}
	first := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	more := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)), inkStrokeAdd(inkPage1, inkStroke(5)))
	w := newInkWire(t, first)
	w.companion.SetNote(board, boardLog)
	synced := func(seqs ...uint32) func() bool {
		return func() bool {
			notes := w.sp.Ink.Status().Notes
			if len(notes) != len(seqs) {
				return false
			}
			for i, n := range notes {
				if n.Seq != seqs[i] {
					return false
				}
			}
			return true
		}
	}
	run := func(until func() bool, why string) {
		t.Helper()
		if err := w.sp.Ink.Start(); err != nil {
			t.Fatal(err)
		}
		waitFor(t, until, why)
		w.sp.Ink.Stop()
	}
	run(synced(uint32(len(boardLog)), uint32(len(first))), "both notes to land")
	notes := w.sp.Ink.Status().Notes
	boardUUID, ideasUUID := notes[0].UUID, notes[1].UUID
	view := w.sp.Ink.LiveView()

	w.companion.Live = true
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { mirrored, _ := view.Mirrors(); return mirrored == ideasUUID }, "the Live view to mirror Ideas")
	live := dialWS(t, w.srv, view.UUID())
	if answer := w.askPage(live, inkPage1.String()); answer["error"] != nil {
		t.Fatalf("answer %v", answer)
	}
	w.sp.Ink.Stop()
	untilNotLive(t, live)

	w.companion.LiveOf, w.companion.Page = board, boardPage
	w.companion.SetRecords(more)
	run(func() bool {
		mirrored, _ := view.Mirrors()
		return mirrored == boardUUID && synced(uint32(len(boardLog)), uint32(len(more)))()
	}, "Ideas to take a stroke while the Board is live")

	mirrored := ""
	deadline := time.Now().Add(5 * time.Second)
	for {
		_ = live.SetReadDeadline(deadline)
		_, raw, err := live.ReadMessage()
		if err != nil {
			t.Fatalf("reading the Live view's socket: %v", err)
		}
		var f struct {
			Type   string
			Live   bool
			Stroke struct{ ID string }
			Attrs  struct {
				Live struct{ Container string }
			}
		}
		_ = json.Unmarshal(raw, &f)
		if f.Type == protocol.TypeBlockAttrsUpdated {
			mirrored = f.Attrs.Live.Container
		}
		if f.Type == protocol.TypeInkStrokeAdded {
			t.Errorf("the Live view's socket heard a stroke of a note it no longer mirrors: %s", f.Stroke.ID)
		}
		if f.Type == protocol.TypeInkLivePage && !f.Live {
			break
		}
	}
	if mirrored != boardUUID {
		t.Errorf("the Live view's attrs mirror %q, want the Board %q", mirrored, boardUUID)
	}
	if answer := w.askPage(live, boardPage.String()); answer["error"] != nil || answer["page"] == nil {
		t.Errorf("the Board's page: %v", answer)
	}
	if refused := w.askPage(live, inkPage1.String()); refused["error"] == nil {
		t.Errorf("a page of the note no longer live was answered: %v", refused)
	}
	if w.holds(ideasUUID) {
		t.Error("the note no longer live is still held for the Live view")
	}
	closeAndSettle(live)
}

// On the Live view's socket an answer for the live page is followed by its live page and then by
// the tablet's window — the last VIEW's top-left, or before any VIEW the last BEGIN's origin —
// every time it is asked, so a mirror mounted after the tablet last moved is put where the tablet
// is. A note's own socket is never told it, and the window is forgotten once the page stops being
// live.
func TestWS_Ink_TheLiveViewIsToldTheTabletsWindowAfterAnAnswer(t *testing.T) {
	for _, c := range []struct {
		name string
		feed []byte
		x, y float64
	}{
		{"a view", liveView(-3, -1.75), -3, -1.75},
		{"a begin's origin, before any view", liveBegin(7, 2, 1.5), 2, 1.5},
		{"the view, over a later begin", append(liveView(-3, -1.75), liveBegin(7, 2, 1.5)...), -3, -1.75},
	} {
		t.Run(c.name, func(t *testing.T) {
			records := inkWhiteboardLog()
			w := newInkWire(t, records)
			w.session(records)
			uuid := w.container()
			own := dialWS(t, w.srv, uuid)
			w.askPage(own, inkPage1.String())
			w.companion.Live, w.companion.Ink = true, c.feed
			if err := w.sp.Ink.Start(); err != nil {
				t.Fatal(err)
			}
			readUntil(t, own, protocol.TypeInkLive, 5*time.Second)

			live := dialWS(t, w.srv, w.sp.Ink.LiveView().UUID())
			for _, ask := range []string{"the first answer", "a later answer"} {
				w.askPage(live, inkPage1.String())
				got := nextInk(t, live, 2)
				records, _ := got[1]["records"].([]interface{})
				view, _ := records[0].(map[string]interface{})
				if got[0]["type"] != protocol.TypeInkLivePage || got[0]["pageId"] != inkPage1.String() ||
					got[1]["type"] != protocol.TypeInkLive || len(records) != 1 ||
					view["record"] != protocol.InkLiveView || view["x"] != c.x || view["y"] != c.y {
					t.Errorf("after %s the Live view's socket heard %v", ask, got)
				}
			}
			w.askPage(own, inkPage1.String())
			readUntil(t, own, protocol.TypeInkLivePage, 2*time.Second)
			expectNoMessage(t, own, `"type":"ink-live"`, 300*time.Millisecond)

			w.sp.Ink.Stop()
			untilNotLive(t, live)
			w.askPage(live, inkPage1.String())
			expectNoMessage(t, live, `"type":"ink-live`, 300*time.Millisecond)
			closeAndSettle(own)
			closeAndSettle(live)
		})
	}
}

// The tablet's window is the live page's: once the tablet has gone to another note and back,
// the window it had is not replayed until it says again where it is.
func TestWS_Ink_TheTabletsWindowIsForgottenWhenAnotherNoteIsLive(t *testing.T) {
	other := inkID(0xb0)
	otherLog := []link.Record{
		{Seq: 1, Op: link.OpNoteHeader, Note: other, CreatedMillis: 1_700_000_000_000, Title: "Other", PageAspect: 0.75,
			Device: link.Device{ID: "d", Name: "Note Air 2", Model: "ONYX"}},
		{Seq: 2, Op: link.OpPageAdd, Page: inkPage2, Bounds: link.BoundsFixed},
	}
	records := inkWhiteboardLog()
	w := newInkWire(t, records)
	w.companion.SetNote(other, otherLog)
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(w.sp.Ink.Status().Notes) == 2 }, "both notes to land")
	w.sp.Ink.Stop()
	var board, elsewhere string
	for _, n := range w.sp.Ink.Status().Notes {
		if n.Title == "Board" {
			board = n.UUID
		} else {
			elsewhere = n.UUID
		}
	}

	own := dialWS(t, w.srv, board)
	w.askPage(own, inkPage1.String())
	w.companion.Live, w.companion.Ink = true, liveView(-3, -1.75)
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.sp.Ink.Stop()
	readUntil(t, own, protocol.TypeInkLive, 5*time.Second)
	live := dialWS(t, w.srv, w.sp.Ink.LiveView().UUID())
	w.askPage(live, inkPage1.String())
	if got := nextInk(t, live, 2); got[1]["type"] != protocol.TypeInkLive {
		t.Fatalf("the window was not replayed: %v", got)
	}
	for _, uuid := range []string{elsewhere, board} {
		if result, err := w.sp.Ink.OpenOnTablet(uuid, ""); err != nil || result.Outcome != ink.OpenOpened {
			t.Fatalf("open %s on the tablet: %v %v", uuid, result, err)
		}
		readUntil(t, live, protocol.TypeInkLivePage, 5*time.Second)
	}
	waitFor(t, func() bool { return w.sp.Ink.Live().Container == board }, "the Board to be live again")
	w.askPage(live, inkPage1.String())
	if got := nextInk(t, live, 1); got[0]["type"] != protocol.TypeInkLivePage {
		t.Errorf("after the answer: %v", got)
	}
	expectNoMessage(t, live, `"type":"ink-live"`, 300*time.Millisecond)
	closeAndSettle(own)
	closeAndSettle(live)
}

// uuidGuardStore is a store that records every call naming the uuid it guards, which is a uuid no
// store holds: each such call is a lookup a file store answers by scanning the disk.
type uuidGuardStore struct {
	store.Store
	mu      sync.Mutex
	guarded string
	asked   []string
}

func (g *uuidGuardStore) guard(uuid string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.guarded = uuid
}

func (g *uuidGuardStore) note(call, uuid string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if uuid != "" && uuid == g.guarded {
		g.asked = append(g.asked, call)
	}
}

func (g *uuidGuardStore) calls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return append([]string(nil), g.asked...)
}

func (g *uuidGuardStore) LoadByUUID(uuid string) (store.Storable, error) {
	g.note("LoadByUUID", uuid)
	return g.Store.LoadByUUID(uuid)
}

func (g *uuidGuardStore) Load(cat store.Category, key string) (store.Storable, error) {
	g.note("Load", key)
	return g.Store.Load(cat, key)
}

func (g *uuidGuardStore) LoadAsset(cat store.Category, uuid, key string) (store.AssetStorable, error) {
	g.note("LoadAsset", uuid)
	return g.Store.LoadAsset(cat, uuid, key)
}

func (g *uuidGuardStore) AppendAsset(cat store.Category, uuid, key string, data []byte) (store.AssetStorable, error) {
	g.note("AppendAsset", uuid)
	return g.Store.AppendAsset(cat, uuid, key, data)
}

func (g *uuidGuardStore) CreateAsset(cat store.Category, parent, id string, body []byte) (store.AssetStorable, error) {
	g.note("CreateAsset", parent)
	return g.Store.CreateAsset(cat, parent, id, body)
}

func (g *uuidGuardStore) DeleteAsset(cat store.Category, uuid, key string) error {
	g.note("DeleteAsset", uuid)
	return g.Store.DeleteAsset(cat, uuid, key)
}

func (g *uuidGuardStore) LoadFolder(cat store.Category, key string) (store.FolderStorable, error) {
	g.note("LoadFolder", key)
	return g.Store.LoadFolder(cat, key)
}

// No path a Live tab takes asks the store for the Live view's uuid, which no store holds: opening
// it, its channel's open and load, switching to another tab and back, its meta panel by uuid and
// as the active tab, the tab strip's status refresh, the dwell ping, the Ink and Library sidebars
// and the view's own refresh each decide by what the tab or node is first.
func TestWS_Ink_NoPathOfALiveTabAsksTheStoreForIt(t *testing.T) {
	guard := &uuidGuardStore{Store: newTestFileStore(t)}
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWireOver(t, records, guard)
	w.session(records)
	note := w.container()
	view := w.sp.Ink.LiveView().UUID()
	guard.guard(view)
	w.companion.Live = true
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.sp.Ink.Stop()
	waitFor(t, func() bool { _, present := w.sp.Ink.LiveView().Mirrors(); return present }, "the Live view")

	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	(&NoteHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	(&MetaHandler{ServiceProvider: w.sp, Tmpl: tmpl, EmitNotesChanged: func() {}}).RegisterPaths(r)
	(&TabHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	(&SideBarHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	(&InkHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	views := httptest.NewServer(r)
	defer views.Close()
	get := func(path string) {
		t.Helper()
		if status, body := do(t, http.MethodGet, views.URL+path, "", ""); status != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, status, body)
		}
	}
	open := func(uuid string) {
		t.Helper()
		if status, body := do(t, http.MethodPost, views.URL+"/api/container/open/"+uuid, "", ""); status != http.StatusOK {
			t.Fatalf("open %s: %d %s", uuid, status, body)
		}
	}

	for i := 0; i < 3; i++ {
		open(view)
		c := dialWS(t, w.srv, view)
		send(t, c, `{"type":"load","opId":"op-load"}`)
		if loaded := readUntil(t, c, protocol.TypeLoadContent, 2*time.Second); loaded["kind"] != ink.KindLive {
			t.Fatalf("the Live view loads %v", loaded)
		}
		w.askPage(c, inkPage1.String())
		send(t, c, `{"type":"focus"}`)
		get("/ui/views/meta?uuid=" + view)
		get("/ui/views/meta")
		get("/ui/views/tabs")
		get("/ui/views/sidebar/ink")
		get("/ui/views/sidebar")
		if err := w.sp.Editor.Refresh(view); err != nil {
			t.Fatal(err)
		}
		closeAndSettle(c)
		open(note)
	}
	if asked := guard.calls(); len(asked) != 0 {
		t.Errorf("the store was asked for the Live view's uuid by %v", asked)
	}
}

// An ink-open-on-tablet carries the page to the tablet and is answered, by opId, with what came of
// it: the tablet going live on the note, its refusal and reason, a tablet connected that the note
// did not come from, or none connected; a channel holding no Digital Note is answered with an
// error and no outcome.
func TestWS_InkOpenOnTablet_AnswersWithWhatCameOfIt(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)), link.Record{Op: link.OpPageAdd, Page: inkPage2, Index: 1, Bounds: link.BoundsFixed})
	w := newInkWire(t, records)
	w.session(records)
	uuid := w.container()
	ours := w.sp.Ink
	routes := w.routes()
	for _, c := range []struct {
		name    string
		answer  link.OpenNoteAnswer
		connect string
		outcome string
		reason  string
		message string
	}{
		{"live", link.OpenNoteAnswer{}, "companion", protocol.InkOpenOpened, "", "Opened on "},
		{"not in front", link.OpenNoteAnswer{Refuse: link.RefuseNotForeground}, "companion", protocol.InkOpenRefused, link.RefuseNotForeground, "SieveInk is not open on the tablet"},
		{"not offered", link.OpenNoteAnswer{Refuse: link.RefuseNotOffered}, "companion", protocol.InkOpenRefused, link.RefuseNotOffered, "not shared with this Sieve"},
		{"another tablet", link.OpenNoteAnswer{}, "another-companion", protocol.InkOpenOtherTablet, "", "Connected to another tablet"},
		{"no tablet", link.OpenNoteAnswer{}, "", protocol.InkOpenNoTablet, "", "No tablet connected"},
	} {
		t.Run(c.name, func(t *testing.T) {
			w.companion.SetOpenNoteAnswer(c.answer)
			w.sp.Ink = ours
			if c.connect != "" && c.connect != "companion" {
				w.sp.Ink = ink.NewInkService(w.sp.State, w.sp.Containers, radio.NewTCP(w.addr, c.connect), nil)
			}
			if c.connect != "" {
				if err := w.sp.Ink.Start(); err != nil {
					t.Fatal(err)
				}
				waitFor(t, func() bool { return w.sp.Ink.Status().Link.Phase == ink.LinkConnected }, "the tablet to connect")
			}
			defer w.sp.Ink.Stop()
			sock := dialWS(t, w.srv, uuid)
			defer closeAndSettle(sock)
			send(t, sock, `{"type":"ink-open-on-tablet","opId":"op-open","pageId":"`+inkPage2.String()+`"}`)
			got := readUntil(t, sock, protocol.TypeInkOpenOnTabletResult, 5*time.Second)
			reason, _ := got["reason"].(string)
			if got["opId"] != "op-open" || got["outcome"] != c.outcome || reason != c.reason || got["error"] != nil {
				t.Errorf("answered %v, want %s %q", got, c.outcome, c.reason)
			}
			if c.connect == "companion" {
				if asked := <-w.companion.OpenNotes; asked != (link.OpenNoteRequest{Note: inkNoteID, Page: inkPage2}) {
					t.Errorf("the tablet was asked for %+v", asked)
				}
			}

			status, body := do(t, http.MethodPost, routes.URL+"/api/ink/notes/"+uuid+"/open-on-tablet", "", "")
			var answer protocol.InkOpenOnTabletResponse
			if err := json.Unmarshal([]byte(body), &answer); status != http.StatusOK || err != nil || answer.Outcome != c.outcome ||
				answer.Reason != c.reason || !strings.Contains(answer.Message, c.message) {
				t.Errorf("the route answered %d %s, want %s %q saying %q", status, body, c.outcome, c.reason, c.message)
			}
			if c.connect == "companion" {
				if asked := <-w.companion.OpenNotes; asked != (link.OpenNoteRequest{Note: inkNoteID}) {
					t.Errorf("the route asked the tablet for %+v, want the page left to it", asked)
				}
			}
		})
	}

	other := newContainerOnWire(t, w.sp).UUID()
	sock := dialWS(t, w.srv, other)
	send(t, sock, `{"type":"ink-open-on-tablet","opId":"op-open"}`)
	if got := readUntil(t, sock, protocol.TypeInkOpenOnTabletResult, 2*time.Second); got["error"] == nil || got["outcome"] != nil {
		t.Errorf("a code container answered %v", got)
	}
	closeAndSettle(sock)
	if status, body := do(t, http.MethodPost, routes.URL+"/api/ink/notes/"+other+"/open-on-tablet", "", ""); status != http.StatusNotFound {
		t.Errorf("the route answered a code container %d %s", status, body)
	}
}

// namingImages answers every page of a note with an image address beside its log.
type namingImages struct{}

func (namingImages) Image(_ context.Context, uuid string, page int) (ink.PageImage, error) {
	return ink.PageImage{Address: domain.NewLeafAddress(uuid, fmt.Sprintf("page-%d.png", page))}, nil
}

// namingDescriber names every note the same.
type namingDescriber struct{}

func (namingDescriber) Tier() domain.Tier { return domain.TierSmart }
func (namingDescriber) DescribeNote(string, []domain.Address) (domain.NoteMetadata, error) {
	return domain.NoteMetadata{Title: "Kitchen extension planning", Keywords: []string{"budget, rough"}}, nil
}

// A note is shown by its tablet's title until Sieve names it, and by that name after: in the
// sidebar's Ink section, in Settings → Ink's list, in the tab strip, where a tab already open
// takes the name, in a tab opened afresh, and on the note's own socket, which loads it under its
// tablet's title and is told the name once it is given.
func TestWS_Ink_ANoteIsShownByTheNameSieveGaveIt(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	w.session(records)
	note := w.container()
	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	(&NoteHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	(&TabHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	(&InkHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	views := httptest.NewServer(r)
	defer views.Close()
	shown := func(path string) string {
		t.Helper()
		status, body := do(t, http.MethodGet, views.URL+path, "", "")
		if status != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, status, body)
		}
		return body
	}
	open := func() domain.Tab {
		t.Helper()
		if status, body := do(t, http.MethodPost, views.URL+"/api/container/open/"+note, "", ""); status != http.StatusOK {
			t.Fatalf("open: %d %s", status, body)
		}
		for _, tab := range w.sp.State.LoadSession().Tabs {
			if tab.ID == note {
				return tab
			}
		}
		t.Fatal("no tab of the note")
		return domain.Tab{}
	}
	if tab := open(); tab.DisplayName != "Ideas" {
		t.Errorf("an unnamed note's tab is %q", tab.DisplayName)
	}
	expanded := w.sp.State.LoadSession()
	expanded.SetFolderOpen(inkTreeID, true)
	if err := w.sp.State.SaveSession(expanded); err != nil {
		t.Fatal(err)
	}
	c := dialWS(t, w.srv, note)
	defer closeAndSettle(c)
	send(t, c, `{"type":"load","opId":"op-load"}`)
	if loaded := readUntil(t, c, protocol.TypeLoadContent, 2*time.Second); loaded["name"] != "Ideas" {
		t.Errorf("an unnamed note loads as %v", loaded["name"])
	}
	for _, path := range []string{"/ui/views/sidebar/ink", "/ui/views/settings/ink", "/ui/views/tabs"} {
		if body := shown(path); !strings.Contains(body, "Ideas") {
			t.Errorf("%s does not show the tablet's title:\n%s", path, body)
		}
	}

	settings := w.sp.State.LoadSettings()
	settings.Ink.SettleSeconds = 1
	if err := w.sp.State.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	ink.NewNoteNamer(w.sp.Ink, namingImages{}, namingDescriber{}, services.NewJobEngine(nil, 1, nil))
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.sp.Ink.Stop()
	waitFor(t, func() bool {
		notes := w.sp.Ink.Status().Notes
		return len(notes) == 1 && notes[0].Name == "Kitchen extension planning"
	}, "the note to be named")
	if named := readUntil(t, c, protocol.TypeContainerNamed, 2*time.Second); named["name"] != "Kitchen extension planning" {
		t.Errorf("the open note was told it is called %v", named["name"])
	}
	for _, path := range []string{"/ui/views/sidebar/ink", "/ui/views/settings/ink", "/ui/views/tabs"} {
		if body := shown(path); !strings.Contains(body, "Kitchen extension planning") || strings.Contains(body, ">Ideas<") {
			t.Errorf("%s does not show the note's name:\n%s", path, body)
		}
	}
	if tab := open(); tab.DisplayName != "Kitchen extension planning" {
		t.Errorf("a named note's tab is %q", tab.DisplayName)
	}
	if err := w.sp.State.SaveSession(domain.Session{}); err != nil {
		t.Fatal(err)
	}
	if tab := open(); tab.DisplayName != "Kitchen extension planning" {
		t.Errorf("a named note's tab opened afresh is %q", tab.DisplayName)
	}
}

// switchedImages answers every page as namingImages does, or fails with err while it is set.
type switchedImages struct {
	mu  sync.Mutex
	err error
}

func (i *switchedImages) Image(ctx context.Context, uuid string, page int) (ink.PageImage, error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.err != nil {
		return ink.PageImage{}, i.err
	}
	return namingImages{}.Image(ctx, uuid, page)
}

// countingDescriber names every note as namingDescriber does at its tier, counting the notes it
// describes.
type countingDescriber struct {
	mu    sync.Mutex
	tier  domain.Tier
	calls int
}

func (d *countingDescriber) Tier() domain.Tier {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.tier
}

func (d *countingDescriber) DescribeNote(uuid string, pages []domain.Address) (domain.NoteMetadata, error) {
	d.mu.Lock()
	d.calls++
	d.mu.Unlock()
	return namingDescriber{}.DescribeNote(uuid, pages)
}

func (d *countingDescriber) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

// A note is named on demand through its socket's ink-describe and through its describe route,
// named or not: each answers once the naming is submitted, and with why not, in words, when no AI
// is configured or nothing can draw its pages, submitting nothing. A container that is not a note
// is refused by both.
func TestInkDescribe_NamesANoteOnDemandThroughItsSocketAndItsRoute(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	w.session(records)
	note := w.container()
	images, describer := &switchedImages{}, &countingDescriber{tier: domain.TierSmart}
	w.sp.InkNamer = ink.NewNoteNamer(w.sp.Ink, images, describer, services.NewJobEngine(nil, 1, nil))
	routes := w.routes()
	c := dialWS(t, w.srv, note)
	defer closeAndSettle(c)

	// ask names the note through door and answers its refusal, "" when it was submitted.
	ask := func(door, uuid string, sock *websocket.Conn) string {
		t.Helper()
		if door == "socket" {
			send(t, sock, `{"type":"ink-describe","opId":"op-describe"}`)
			got := readUntil(t, sock, protocol.TypeInkDescribeResult, 5*time.Second)
			if got["opId"] != "op-describe" {
				t.Errorf("answered %v", got)
			}
			refusal, _ := got["error"].(string)
			return refusal
		}
		status, body := do(t, http.MethodPost, routes.URL+"/api/ink/notes/"+uuid+"/describe", "", "")
		if status == http.StatusNoContent {
			return ""
		}
		return fmt.Sprintf("%d %s", status, strings.TrimSpace(body))
	}
	for _, door := range []string{"socket", "route"} {
		for _, tc := range []struct {
			name  string
			block func()
			says  string
		}{
			{"no AI", func() { describer.mu.Lock(); describer.tier = domain.TierDumb; describer.mu.Unlock() }, "No AI is configured"},
			{"no window", func() { images.mu.Lock(); images.err = fmt.Errorf("%w: none", ink.ErrNoDrawer); images.mu.Unlock() }, "Open Sieve's window"},
			{"named", func() {}, ""},
		} {
			t.Run(door+"/"+tc.name, func(t *testing.T) {
				describer.mu.Lock()
				describer.tier = domain.TierSmart
				describer.mu.Unlock()
				images.mu.Lock()
				images.err = nil
				images.mu.Unlock()
				tc.block()
				before := describer.count()
				refusal := ask(door, note, c)
				if tc.says == "" {
					if refusal != "" {
						t.Fatalf("refused: %s", refusal)
					}
					waitFor(t, func() bool { return describer.count() == before+1 }, "the note to be described")
					waitFor(t, func() bool {
						notes := w.sp.Ink.Status().Notes
						return len(notes) == 1 && notes[0].Name == "Kitchen extension planning"
					}, "the note to be named")
					return
				}
				if !strings.Contains(refusal, tc.says) || (door == "route" && !strings.HasPrefix(refusal, "409 ")) {
					t.Errorf("refused %q, want it to say %q", refusal, tc.says)
				}
				if got := describer.count(); got != before {
					t.Errorf("described %d times", got-before)
				}
			})
		}
	}

	other := newContainerOnWire(t, w.sp).UUID()
	sock := dialWS(t, w.srv, other)
	defer closeAndSettle(sock)
	if refusal := ask("socket", other, sock); !strings.Contains(refusal, "not a notebook") {
		t.Errorf("a code container's socket was answered %q", refusal)
	}
	if refusal := ask("route", other, nil); !strings.HasPrefix(refusal, "404 ") {
		t.Errorf("a code container's route answered %q", refusal)
	}
}

// A notebook's Meta tab shows, read-only, its name and its tablet's title where they differ, its
// summary, keywords and categories, device, pages, the seq it is synced to and the seq it is
// described as of, or that it is not yet named, and its uuid, with a button that names it now
// through its describe route and says what came of that beside itself; it refreshes on the ink
// invalidation, and History and Assets are not offered. The Live view's tab shows no meta.
func TestMetaPanel_ShowsANotebooksMetadata(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	w.session(records)
	note := w.container()
	view := w.sp.Ink.LiveView().UUID()
	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	(&MetaHandler{ServiceProvider: w.sp, Tmpl: tmpl, EmitNotesChanged: func() {}}).RegisterPaths(r)
	views := httptest.NewServer(r)
	defer views.Close()
	if err := w.sp.State.SaveSession(domain.Session{Tabs: []domain.Tab{
		{ID: note, Kind: ink.KindDigitalNote, DisplayName: "Ideas"}, {ID: view, Kind: ink.KindLive, DisplayName: "Live"},
	}}); err != nil {
		t.Fatal(err)
	}
	panel := func(uuid, tab string) string {
		t.Helper()
		status, body := do(t, http.MethodGet, views.URL+"/ui/views/meta?uuid="+uuid+"&tab="+tab, "", "")
		if status != http.StatusOK {
			t.Fatalf("GET meta: %d %s", status, body)
		}
		return body
	}
	row := func(label, value string) string {
		return label + `</span>
  <span class="text-tn-text text-base break-words flex-1">` + value + `</span>`
	}
	button := `hx-post="/api/ink/notes/` + note + `/describe"
      hx-target="this"
      hx-swap="none"`
	refresh := `hx-get="/ui/views/meta?uuid=` + note + `&tab=meta" hx-trigger="sieve:invalidate-ink from:document" hx-target="#htmx-meta-panel"`
	unnamed := panel(note, "history")
	for _, want := range []string{row("Name", "Ideas"), row("Keywords", "—"), row("Categories", "—"), row("Pages", "1"),
		row("Synced to", fmt.Sprintf("seq %d", len(records))), row("Described as of", "not yet named"), note, button,
		">Refresh name and summary<", "data-notebook-describe-status", refresh, `data-active-tab="meta"`} {
		if !strings.Contains(unnamed, want) {
			t.Errorf("an unnamed notebook's panel lacks %q:\n%s", want, unnamed)
		}
	}
	for _, absent := range []string{"Tablet title", ">History<", ">Assets<", "Focus count"} {
		if strings.Contains(unnamed, absent) {
			t.Errorf("an unnamed notebook's panel shows %q", absent)
		}
	}

	if _, err := w.sp.Containers.SaveMeta(note, func(m domain.DocumentMeta) {
		ink.NewDigitalNoteKind().Describe(m, domain.NoteMetadata{Title: "Kitchen extension planning", Summary: "Plans.",
			Keywords: []string{"extension", "budget"}, Categories: []string{"Home"}}, 1)
	}); err != nil {
		t.Fatal(err)
	}
	named := panel(note, "meta")
	for _, want := range []string{row("Name", "Kitchen extension planning"), row("Tablet title", "Ideas"), "Plans.",
		">extension<", ">budget<", "data-notebook-categories", ">Home<", row("Described as of", "seq 1")} {
		if !strings.Contains(named, want) {
			t.Errorf("a named notebook's panel lacks %q:\n%s", want, named)
		}
	}
	if live := panel(view, "meta"); !strings.Contains(live, "No meta") || strings.Contains(live, "Refresh name and summary") {
		t.Errorf("the Live view's panel is\n%s", live)
	}
}

// pngDrawer draws every page as the PNG signature and its key.
type pngDrawer struct{}

func (pngDrawer) DrawPage(_ context.Context, page ink.PageDrawing) ([]byte, error) {
	return append([]byte("\x89PNG\r\n\x1a\n"), page.Key...), nil
}

// cannedTranscriber transcribes every page as the same heading and Mermaid diagram, and counts its transcripts.
type cannedTranscriber struct {
	mu    sync.Mutex
	calls int
}

func (r *cannedTranscriber) Tier() domain.Tier { return domain.TierSmart }
func (r *cannedTranscriber) TranscribePage(string, domain.Address) (domain.PageTranscript, error) {
	r.mu.Lock()
	r.calls++
	r.mu.Unlock()
	return domain.PageTranscript{Parts: []domain.TranscriptPart{
		{Type: domain.TranscriptPartText, Markdown: "# Kitchen\n\nTiles [?] by Friday."},
		{Type: domain.TranscriptPartDiagram, Language: "mermaid", Source: "flowchart TD\n  A --> B"},
	}}, nil
}

func (r *cannedTranscriber) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

// transcriptOf is the transcript an ink-transcript-content or ink-transcript-changed carries, as "{state}
// running={bool} {kinds}".
func transcriptOf(t *testing.T, frame map[string]interface{}) string {
	t.Helper()
	transcript, _ := frame["transcript"].(map[string]interface{})
	if transcript == nil {
		t.Fatalf("no transcript in %v", frame)
	}
	var kinds []string
	blocks, _ := transcript["blocks"].([]interface{})
	for _, b := range blocks {
		kinds = append(kinds, fmt.Sprint(b.(map[string]interface{})["kind"]))
	}
	return fmt.Sprintf("%v running=%v %s", transcript["state"], transcript["running"], strings.Join(kinds, ","))
}

// Over the note's own socket a page's transcript is asked, started and heard: none before, the
// transcript's start and end pushed with the answer to the transcribe request between, ready with its blocks when
// asked again, and stale once a stroke lands on the page. New document answers a document of its
// own, named for the note and the page, holding the transcript's blocks, and leaves the note's
// transcript as it was. A page that is no id, and a channel holding no note, are refused.
func TestWS_InkTranscript_IsAskedTranscribedHeardAndCopied(t *testing.T) {
	block.RegisterProcessor(&processors.ProseProcessor{})
	block.RegisterProcessor(processors.NewDiagramProcessor(block.BlockServices{}))
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	w.session(records)
	note := w.container()
	transcriber := &cannedTranscriber{}
	w.sp.InkTranscripts = ink.NewPageTranscripts(w.sp.Ink, ink.NewPageImages(w.sp.Ink, pngDrawer{}), transcriber, nil,
		block.NewDocumentCodec(block.GlobalRegistry()), services.NewJobEngine(nil, 1, nil))
	c := dialWS(t, w.srv, note)
	ask := func(frameType string) map[string]interface{} {
		t.Helper()
		send(t, c, `{"type":"`+frameType+`","opId":"op-r","pageId":"`+inkPage1.String()+`"}`)
		return readUntil(t, c, protocol.TypeInkTranscriptContent, 2*time.Second)
	}

	if got := ask(protocol.TypeInkTranscript); transcriptOf(t, got) != "none running=false " || got["opId"] != "op-r" ||
		got["pageId"] != inkPage1.String() || got["transcript"].(map[string]interface{})["available"] != true {
		t.Errorf("before transcript: %v", got)
	}
	send(t, c, `{"type":"ink-transcribe-page","opId":"op-transcribe","pageId":"`+inkPage1.String()+`"}`)
	var heard []string
	for len(heard) < 3 {
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("after %v: %v", heard, err)
		}
		var f map[string]interface{}
		if json.Unmarshal(raw, &f) != nil {
			continue
		}
		switch f["type"] {
		case protocol.TypeInkTranscriptChanged:
			heard = append(heard, "pushed "+transcriptOf(t, f))
		case protocol.TypeInkTranscriptContent:
			heard = append(heard, "answered "+transcriptOf(t, f))
		}
	}
	if want := []string{"pushed none running=true ", "answered none running=true ", "pushed ready running=false prose,diagram"}; strings.Join(heard, "|") != strings.Join(want, "|") {
		t.Errorf("heard\n%v\nwant\n%v", heard, want)
	}
	if got := ask(protocol.TypeInkTranscript); transcriptOf(t, got) != "ready running=false prose,diagram" {
		t.Errorf("asked again: %v", got)
	}
	if got := ask(protocol.TypeInkTranscribePage); transcriptOf(t, got) != "ready running=false prose,diagram" || transcriber.count() != 1 {
		t.Errorf("transcribe again: %v, %d transcripts", got, transcriber.count())
	}

	more := append(records, inkStrokeAdd(inkPage1, inkStroke(2)))
	more[len(more)-1].Seq = uint32(len(more))
	w.session(more)
	if got := ask(protocol.TypeInkTranscript); transcriptOf(t, got) != "stale running=false prose,diagram" {
		t.Errorf("after a stroke: %v", got)
	}

	send(t, c, `{"type":"ink-transcript-document","opId":"op-doc","pageId":"`+inkPage1.String()+`"}`)
	made := readUntil(t, c, protocol.TypeInkTranscriptDocumentResult, 2*time.Second)
	uuid, _ := made["uuid"].(string)
	if made["opId"] != "op-doc" || made["error"] != nil || uuid == "" || uuid == note {
		t.Fatalf("new document: %v", made)
	}
	doc, err := w.sp.Documents.LoadByUUID(uuid)
	if err != nil || doc.Meta().DisplayName() != "Ideas — page 1" {
		t.Fatalf("the new document: %v, %v", doc, err)
	}
	d := dialWS(t, w.srv, uuid)
	send(t, d, `{"type":"load","opId":"op-load"}`)
	loaded := readUntil(t, d, protocol.TypeLoadContent, 2*time.Second)
	blocks, _ := loaded["blocks"].([]interface{})
	if loaded["name"] != "Ideas — page 1" || len(blocks) != 2 ||
		blocks[0].(map[string]interface{})["attrs"].(map[string]interface{})["content"] != "# Kitchen\n\nTiles [?] by Friday." {
		t.Errorf("the new document loads as %v", loaded)
	}
	closeAndSettle(d)
	if got := ask(protocol.TypeInkTranscript); transcriptOf(t, got) != "stale running=false prose,diagram" {
		t.Errorf("the note's transcript after New document: %v", got)
	}

	send(t, c, `{"type":"ink-transcript","opId":"op-x","pageId":"first"}`)
	if got := readUntil(t, c, protocol.TypeInkTranscriptContent, 2*time.Second); got["error"] == nil || got["transcript"] != nil {
		t.Errorf("a page that is no id: %v", got)
	}
	closeAndSettle(c)
	other := newContainerOnWire(t, w.sp)
	o := dialWS(t, w.srv, other.UUID())
	send(t, o, `{"type":"ink-transcript-document","opId":"op-o","pageId":"`+inkPage1.String()+`"}`)
	if got := readUntil(t, o, protocol.TypeInkTranscriptDocumentResult, 2*time.Second); got["error"] == nil || got["uuid"] != nil {
		t.Errorf("a code container answered %v", got)
	}
	closeAndSettle(o)
}

// While its tablet is connected and offers it, a notebook's Delete is refused everywhere: its row
// says why, the dialog says why and offers no Delete, and the route answers 409 with the same
// words, leaving the container held.
func TestInkDelete_IsRefusedWhileTheTabletOffersTheNotebook(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	tmpl, err := NewTemplates(os.DirFS(".."))
	if err != nil {
		t.Fatal(err)
	}
	r := chi.NewRouter()
	(&InkHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	(&ContextMenuHandler{ServiceProvider: w.sp, Tmpl: tmpl}).RegisterPaths(r)
	routes := httptest.NewServer(r)
	t.Cleanup(routes.Close)
	if err := w.sp.Ink.Start(); err != nil {
		t.Fatal(err)
	}
	defer w.sp.Ink.Stop()
	waitFor(t, func() bool {
		st := w.sp.Ink.Status()
		return st.Link.Phase == ink.LinkConnected && len(st.Notes) == 1 && st.Notes[0].Seq == uint32(len(records))
	}, "the session to catch up")
	uuid := w.container()
	session := w.sp.State.LoadSession()
	session.OpenFolders = append(session.OpenFolders, inkTreeID)
	if err := w.sp.State.SaveSession(session); err != nil {
		t.Fatal(err)
	}

	refused := strings.ReplaceAll(inkDeleteRefused, "'", "&#39;")
	if _, row := do(t, http.MethodGet, routes.URL+"/ui/views/sidebar/ink", "", ""); !strings.Contains(row, `data-ctx-delete-refused="`+refused+`"`) {
		t.Errorf("the row does not say Delete is refused:\n%s", row)
	}
	status, body := do(t, http.MethodGet, routes.URL+"/ui/views/sidebar/dialog/delete?id="+uuid+"&name=Strokes&type=notebook", "", "")
	if status != http.StatusOK || !strings.Contains(body, refused) || strings.Contains(body, `type="submit"`) {
		t.Errorf("the dialog: %d\n%s", status, body)
	}
	status, body = do(t, http.MethodDelete, routes.URL+"/api/ink/notes/"+uuid, "", "")
	if status != http.StatusConflict || strings.TrimSpace(body) != inkDeleteRefused {
		t.Errorf("the route answered %d %q", status, body)
	}
	if _, err := w.sp.Containers.Load(uuid); err != nil {
		t.Errorf("a refused delete removed the container: %v", err)
	}
}

// A page asked by a view that names its renderer is answered with the drawing that renderer kept
// of it while the note stands as it did when the drawing was made, and with the page otherwise.
func TestWS_InkPage_AnswersWithTheDrawingKeptWhileTheNoteStands(t *testing.T) {
	records := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)))
	w := newInkWire(t, records)
	w.session(records)
	c := dialWS(t, w.srv, w.container())

	ask := func(renderer string) map[string]interface{} {
		t.Helper()
		send(t, c, `{"type":"ink-page","opId":"op-page","pageId":"`+inkPage1.String()+`","renderer":"`+renderer+`"}`)
		return readUntil(t, c, protocol.TypeInkPageContent, 2*time.Second)
	}
	drawing := func(key, renderer string) string {
		return `<svg xmlns="http://www.w3.org/2000/svg" data-ink-key="` + key + `" data-ink-renderer="` + renderer + `"><g/></svg>`
	}
	keep := func(key, svg string) {
		t.Helper()
		frame, _ := json.Marshal(map[string]string{"type": protocol.TypeInkKeepDrawing, "pageId": inkPage1.String(), "key": key, "drawing": svg})
		send(t, c, string(frame))
	}

	first := ask("2")
	key, _ := first["key"].(string)
	if key == "" || first["page"] == nil || first["drawing"] != nil {
		t.Fatalf("with nothing kept: key %q, page %v, drawing %v", key, first["page"] != nil, first["drawing"])
	}

	keep("00ff-1-1", drawing("00ff-1-1", "2"))
	keep(key, drawing("00ff-1-1", "2"))
	keep(key, `<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>`)
	if a := ask("2"); a["drawing"] != nil || a["page"] == nil {
		t.Fatalf("a drawing of another key, or one that does not say its key, was kept: %v", a["drawing"])
	}

	keep(key, drawing(key, "2"))
	for _, tc := range []struct {
		name, renderer string
		kept           bool
	}{
		{"the renderer that kept it", "2", true},
		{"another renderer", "3", false},
		{"a view that names no renderer", "", false},
	} {
		a := ask(tc.renderer)
		if a["key"] != key || a["seq"] != first["seq"] {
			t.Errorf("%s: key %v seq %v, want %v %v", tc.name, a["key"], a["seq"], key, first["seq"])
		}
		if tc.kept && (a["drawing"] != drawing(key, "2") || a["page"] != nil) {
			t.Errorf("%s: drawing %v, page %v", tc.name, a["drawing"], a["page"])
		}
		if !tc.kept && (a["drawing"] != nil || a["page"] == nil) {
			t.Errorf("%s: drawing %v, page %v", tc.name, a["drawing"], a["page"] != nil)
		}
	}

	all := inkLog(inkStrokeAdd(inkPage1, inkStroke(1)), inkStrokeAdd(inkPage1, inkStroke(2)))
	w.session(all)
	moved := ask("2")
	if moved["key"] == key || moved["key"] == "" || moved["drawing"] != nil || moved["page"] == nil || moved["seq"] != float64(len(all)) {
		t.Errorf("after the note changed: key %v (was %v), seq %v, drawing %v, page %v", moved["key"], key, moved["seq"], moved["drawing"], moved["page"] != nil)
	}

	// A note nobody holds is opened afresh: it has the key its records gave it one at a time, and
	// is answered with the drawing kept at that key.
	movedKey, _ := moved["key"].(string)
	keep(movedKey, drawing(movedKey, "2"))
	if a := ask("2"); a["drawing"] != drawing(movedKey, "2") {
		t.Fatalf("the drawing kept after the note changed: %v", a["drawing"])
	}
	c.Close()
	waitFor(t, func() bool { return !w.holds(w.container()) }, "the note to be released")
	c = dialWS(t, w.srv, w.container())
	if again := ask("2"); again["key"] != movedKey || again["drawing"] != drawing(movedKey, "2") || again["seq"] != float64(len(all)) {
		t.Errorf("opened afresh: key %v (want %v), seq %v, drawing %v", again["key"], movedKey, again["seq"], again["drawing"])
	}
	if full := ask(""); full["key"] != movedKey || full["page"] == nil || full["seq"] != float64(len(all)) {
		t.Errorf("the page asked in full of a note answered from its drawing: key %v, seq %v, page %v", full["key"], full["seq"], full["page"] != nil)
	}
}
