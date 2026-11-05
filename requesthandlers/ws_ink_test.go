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
	return w
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
