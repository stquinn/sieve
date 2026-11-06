package requesthandlers

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/ink"
	"sieve/sieve/ink/link"
	"sieve/sieve/ink/radio"
	"sieve/sieve/protocol"
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

// inkWire is the document wire's harness with Ink enabled over a scripted companion reached
// through the TCP radio on a loopback socket.
type inkWire struct {
	t         *testing.T
	srv       *httptest.Server
	sp        *sieve.ServiceProvider
	h         *WsHandler
	companion *link.ScriptedCompanion
}

func newInkWire(t *testing.T, records []link.Record) *inkWire {
	t.Helper()
	srv, sp, h, _ := newWsTestServer(t)
	block.RegisterProcessor(ink.NewDigitalNoteKind())
	w := &inkWire{t: t, srv: srv, sp: sp, h: h, companion: link.NewScriptedCompanion(inkKey, inkNoteID, inkPage1, records)}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
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
