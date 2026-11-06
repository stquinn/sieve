package requesthandlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"sieve/sieve"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
	"sieve/sieve/ink"
	"sieve/sieve/protocol"
	"sieve/store/filestore"
)

// pageDrawing is the workspace wire's harness holding a synced note of one fixed page, its page
// images drawn over the wire, and the Ink routes served beside the wires.
type pageDrawing struct {
	t      *testing.T
	wires  *httptest.Server
	routes *httptest.Server
	sp     *sieve.ServiceProvider
	h      *WsHandler
	note   string
	jsonl  []byte
	// clock fires a waiting request's timeout when sent to.
	clock chan time.Time
}

func newPageDrawing(t *testing.T) *pageDrawing {
	t.Helper()
	wires, sp, h, _ := newWsTestServer(t)
	block.RegisterProcessor(ink.NewDigitalNoteKind())
	sp.Ink = ink.NewInkService(sp.State, sp.Containers, holdingRadio{}, nil)
	sp.InkImages = ink.NewPageImages(sp.Ink, NewInkPageDrawer(h.broadcast.Requests()))
	sp.Nodes = editor.NewRouter(editor.NewBlockSource(sp.Containers))
	p := &pageDrawing{t: t, wires: wires, sp: sp, h: h, clock: make(chan time.Time, 1)}
	h.broadcast.requests.after = func(time.Duration) <-chan time.Time { return p.clock }
	for _, rec := range inkLog(inkStrokeAdd(inkPage1, inkStroke(1))) {
		line, err := rec.JSONLine()
		if err != nil {
			t.Fatal(err)
		}
		p.jsonl = append(p.jsonl, line...)
	}
	c, err := sp.Containers.Create(ink.KindDigitalNote, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sp.Containers.SaveAsset(c, ink.StrokesKey, p.jsonl); err != nil {
		t.Fatal(err)
	}
	p.note = c.UUID()
	r := chi.NewRouter()
	(&InkHandler{ServiceProvider: sp}).RegisterPaths(r)
	p.routes = httptest.NewServer(r)
	t.Cleanup(p.routes.Close)
	return p
}

// key is the page key of the note's page.
func (p *pageDrawing) key() string {
	p.t.Helper()
	key, err := ink.ReadStrokeBasedNote(p.note, p.jsonl).PageKey(0)
	if err != nil {
		p.t.Fatal(err)
	}
	return key
}

// get asks the image endpoint for path below the note and returns its answer.
func (p *pageDrawing) get(path string) (*http.Response, []byte) {
	p.t.Helper()
	resp, err := http.Get(p.routes.URL + "/api/ink/notes/" + path)
	if err != nil {
		p.t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

// image asks for the note's first page.
func (p *pageDrawing) image() (*http.Response, []byte) { return p.get(p.note + "/pages/0/image") }

// pageImages are the page images in the note's directory.
func (p *pageDrawing) pageImages() []string {
	p.t.Helper()
	c, err := p.sp.Containers.Load(p.note)
	if err != nil {
		p.t.Fatal(err)
	}
	var out []string
	for _, a := range c.Assets() {
		if strings.HasPrefix(a.Key(), "page-") {
			out = append(out, a.Key())
		}
	}
	return out
}

// drawingClient is a workspace client that answers every ink-draw-page it reads with answer,
// and reports each request it answered.
type drawingClient struct {
	conn  *websocket.Conn
	asked chan protocol.InkDrawPageFrame
}

// dialDrawing connects a workspace client that answers with answer; nil answers nothing.
func (p *pageDrawing) dialDrawing(answer func(protocol.InkDrawPageFrame) protocol.InkPageDrawnFrame) *drawingClient {
	p.t.Helper()
	d := &drawingClient{conn: dialWorkspaceWS(p.t, p.wires), asked: make(chan protocol.InkDrawPageFrame, 8)}
	p.t.Cleanup(func() { d.conn.Close() })
	go func() {
		for {
			_, raw, err := d.conn.ReadMessage()
			if err != nil {
				return
			}
			var frame protocol.InkDrawPageFrame
			if json.Unmarshal(raw, &frame) != nil || frame.Type != protocol.TypeInkDrawPage {
				continue
			}
			d.asked <- frame
			if answer != nil {
				reply := answer(frame)
				reply.Type, reply.CorrelationID = protocol.TypeInkPageDrawn, frame.CorrelationID
				if d.conn.WriteJSON(reply) != nil {
					return
				}
			}
		}
	}()
	return d
}

// request is the next request d was asked, failing after two seconds.
func (d *drawingClient) request(t *testing.T) protocol.InkDrawPageFrame {
	t.Helper()
	select {
	case f := <-d.asked:
		return f
	case <-time.After(2 * time.Second):
		t.Fatal("the client was asked nothing")
		return protocol.InkDrawPageFrame{}
	}
}

// askedNothing fails when d is asked anything within a moment.
func (d *drawingClient) askedNothing(t *testing.T) {
	t.Helper()
	select {
	case f := <-d.asked:
		t.Errorf("asked %+v", f)
	case <-time.After(300 * time.Millisecond):
	}
}

// aPNG is a small real PNG.
func aPNG(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewGray(image.Rect(0, 0, 4, 3))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func drawnAs(img []byte) func(protocol.InkDrawPageFrame) protocol.InkPageDrawnFrame {
	return func(protocol.InkDrawPageFrame) protocol.InkPageDrawnFrame {
		return protocol.InkPageDrawnFrame{PNG: base64.StdEncoding.EncodeToString(img)}
	}
}

// The image endpoint asks the client that connected last, and only it, to draw the page, sending
// it the page whole; the PNG it answers with is the endpoint's answer and is kept, so asking again
// draws nothing. The kept image resolves through the Router to a file on disk.
func TestWorkspaceRequests_TheNewestClientDrawsThePageAndItIsKept(t *testing.T) {
	p := newPageDrawing(t)
	img := aPNG(t)
	earlier := p.dialDrawing(drawnAs([]byte("not this one")))
	newest := p.dialDrawing(drawnAs(img))

	resp, body := p.image()
	if resp.StatusCode != http.StatusOK || resp.Header.Get("Content-Type") != "image/png" || !bytes.Equal(body, img) {
		t.Fatalf("%d %s: %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	if got := resp.Header.Get(protocol.InkPageKeyHeader); got != p.key() {
		t.Errorf("key header %q, want %q", got, p.key())
	}
	asked := newest.request(t)
	if asked.CorrelationID == "" || asked.Container != p.note || asked.PageID != inkPage1.String() || asked.PageKey != p.key() ||
		asked.Bounds != "fixed" || asked.Page.Note.PageAspect != 0.75 || len(asked.Page.Strokes) != 1 {
		t.Errorf("asked %+v", asked)
	}
	earlier.askedNothing(t)

	if resp, again := p.image(); resp.StatusCode != http.StatusOK || !bytes.Equal(again, img) {
		t.Errorf("asked again: %d", resp.StatusCode)
	}
	newest.askedNothing(t)

	kept := p.pageImages()
	if len(kept) != 1 || kept[0] != "page-"+inkPage1.String()+"-"+p.key()+".png" {
		t.Fatalf("kept %v", kept)
	}
	node, err := p.sp.Nodes.Resolve(domain.NewLeafAddress(p.note, kept[0]))
	if err != nil || node.Path == "" {
		t.Fatalf("resolve: %+v, %v", node, err)
	}
	onDisk, err := os.ReadFile(filepath.Join(p.sp.Store.(*filestore.FileStore).Root(), node.Path))
	if err != nil || !bytes.Equal(onDisk, img) {
		t.Errorf("%s on disk: %v", node.Path, err)
	}
}

// An answer counts only from the client that was asked.
func TestWorkspaceRequests_AnAnswerCountsOnlyFromTheClientAsked(t *testing.T) {
	p := newPageDrawing(t)
	other := p.dialDrawing(nil)
	asked := p.dialDrawing(nil)
	got := make(chan interface{}, 1)
	go func() {
		answer, err := p.h.broadcast.Requests().Ask(context.Background(), func(id string) interface{} {
			return protocol.NewInkDrawPageFrame(id, p.note, "p", "k", "fixed", protocol.InkPageExport{})
		})
		if err != nil {
			answer = err
		}
		got <- answer
	}()
	id := asked.request(t).CorrelationID
	other.askedNothing(t)
	forged := protocol.InkPageDrawnFrame{Type: protocol.TypeInkPageDrawn, CorrelationID: id, PNG: "Zm9yZ2Vk"}
	if err := other.conn.WriteJSON(forged); err != nil {
		t.Fatal(err)
	}
	select {
	case answer := <-got:
		t.Fatalf("answered by the client not asked: %+v", answer)
	case <-time.After(300 * time.Millisecond):
	}
	if err := asked.conn.WriteJSON(protocol.InkPageDrawnFrame{Type: protocol.TypeInkPageDrawn, CorrelationID: id, PNG: "aGVsbG8="}); err != nil {
		t.Fatal(err)
	}
	if answer := <-got; answer != (protocol.InkPageDrawnFrame{Type: protocol.TypeInkPageDrawn, CorrelationID: id, PNG: "aGVsbG8="}) {
		t.Errorf("answer %+v", answer)
	}
}

// A page nobody draws is an error the endpoint names, and nothing is kept: with no client the
// answer comes at once, a client that stays silent or leaves runs the request out, and a client
// that could not draw says why.
func TestWorkspaceRequests_APageNobodyDrawsIsAnError(t *testing.T) {
	for _, tc := range []struct {
		name   string
		client func(p *pageDrawing)
		status int
		says   string
	}{
		{"no client connected", func(*pageDrawing) {}, http.StatusServiceUnavailable, "no window"},
		{"a client that stays silent", func(p *pageDrawing) {
			c := p.dialDrawing(nil)
			go func() {
				<-c.asked
				p.clock <- time.Now()
			}()
		}, http.StatusGatewayTimeout, ErrNoWorkspaceAnswer.Error()},
		{"a client that leaves unanswered", func(p *pageDrawing) {
			c := p.dialDrawing(nil)
			go func() {
				<-c.asked
				c.conn.Close()
			}()
		}, http.StatusGatewayTimeout, ErrNoWorkspaceAnswer.Error()},
		{"a client that could not draw", func(p *pageDrawing) {
			p.dialDrawing(func(protocol.InkDrawPageFrame) protocol.InkPageDrawnFrame {
				return protocol.InkPageDrawnFrame{Error: "no 2d canvas context"}
			})
		}, http.StatusInternalServerError, "no 2d canvas context"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := newPageDrawing(t)
			tc.client(p)
			started := time.Now()
			resp, body := p.image()
			if resp.StatusCode != tc.status || !strings.Contains(string(body), tc.says) {
				t.Errorf("%d %s, want %d saying %q", resp.StatusCode, body, tc.status, tc.says)
			}
			if elapsed := time.Since(started); elapsed > 2*time.Second {
				t.Errorf("answered after %s", elapsed)
			}
			if kept := p.pageImages(); len(kept) != 0 {
				t.Errorf("kept %v", kept)
			}
		})
	}
	t.Run("asked directly with no client", func(t *testing.T) {
		p := newPageDrawing(t)
		if _, err := p.h.broadcast.Requests().Ask(context.Background(), func(string) interface{} { return nil }); !errors.Is(err, ErrNoWorkspaceClient) {
			t.Errorf("Ask: %v", err)
		}
	})
}

// A page the note does not have is 404, and asks no client anything.
func TestInkPageImage_AnUnknownPageIs404(t *testing.T) {
	p := newPageDrawing(t)
	c := p.dialDrawing(drawnAs(aPNG(t)))
	for _, path := range []string{
		"0199aaaa-0000-7000-8000-000000000000/pages/0/image",
		p.note + "/pages/1/image",
		p.note + "/pages/first/image",
	} {
		if resp, body := p.get(path); resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d %s", path, resp.StatusCode, body)
		}
	}
	c.askedNothing(t)
}
