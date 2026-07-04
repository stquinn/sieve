package requesthandlers

import (
	"strings"
	"testing"
	"time"

	"net/http/httptest"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"sieve/sieve"
	"sieve/sieve/block"
	_ "sieve/sieve/block/processors" // ProseProcessor self-registers via init
	"sieve/sieve/editor"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// newWsTestServer boots the REAL WS handler + EditorService over a temp store
// and returns the server plus a seeded document uuid. No wails devserver in
// the middle (its nil wsHandler panics on external WS upgrades — see
// TECH-DEBT), so this exercises exactly what the app's webview exercises.
func newWsTestServer(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, string) {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	es := editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)
	sp := &sieve.ServiceProvider{Documents: ds, Editor: es}
	h := NewWsHandler(sp)
	r := chi.NewRouter()
	h.RegisterPaths(r)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	// LIFO: runs BEFORE srv.Close — flush every shadow while the store dir is
	// alive, so no handler-teardown write races the TempDir removal.
	t.Cleanup(es.CloseAll)

	doc, err := ds.New()
	if err != nil {
		t.Fatalf("New doc: %v", err)
	}
	doc, err = ds.Save(doc)
	if err != nil {
		t.Fatalf("Save doc: %v", err)
	}
	return srv, sp, doc.UUID()
}

// closeAndSettle closes a conn and waits for its server-side teardown
// (owner flush) to finish, so later store reads/removals don't race it.
func closeAndSettle(c *websocket.Conn) {
	_ = c.Close()
	time.Sleep(300 * time.Millisecond)
}

func dialWS(t *testing.T, srv *httptest.Server, uuid string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/ws?uuid=" + uuid
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func createProseOp(uuid, token string) string {
	return `{"type":"block-op","uuid":"` + uuid + `","op":{"type":"create-block","kind":"prose","attrs":{"content":"probe"},"index":0,"token":"` + token + `"}}`
}

func expectMessage(t *testing.T, c *websocket.Conn, needle string, timeout time.Duration) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(timeout))
	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("expected %q render-back, got read error: %v", needle, err)
		}
		if strings.Contains(string(raw), needle) {
			return
		}
	}
}

// Control: a single connection creating a block MUST receive the insert-block
// render-back. Validates the harness before the race assertion means anything.
func TestWS_SingleConnReceivesInsertBlock(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-ctl"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	expectMessage(t, c, `"insert-block"`, 2*time.Second)
	closeAndSettle(c)
}

// THE RACE (user-reported, wails dev): a stale connection's teardown runs
// AFTER its successor registered. The stale defer must NOT evict the
// successor's channel — render-backs must keep flowing to the live conn.
func TestWS_StaleTeardownMustNotEvictSuccessorChannel(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)

	a := dialWS(t, srv, uuid) // will become stale
	b := dialWS(t, srv, uuid) // takeover: the live connection

	closeAndSettle(a) // let A's server goroutine run its (stale) defers

	if err := b.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-race"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	expectMessage(t, b, `"insert-block"`, 2*time.Second)
	closeAndSettle(b)
}

// Same race, second blast radius: the stale defer must NOT close the shadow
// the successor is using — a doc-update + flush through the live conn must
// reach disk ("lost updates" in the user report).
func TestWS_StaleTeardownMustNotCloseSuccessorShadow(t *testing.T) {
	srv, sp, uuid := newWsTestServer(t)

	a := dialWS(t, srv, uuid)
	b := dialWS(t, srv, uuid)

	closeAndSettle(a)

	update := `{"type":"doc-update","uuid":"` + uuid + `","markdown":"survived-the-race"}`
	if err := b.WriteMessage(websocket.TextMessage, []byte(update)); err != nil {
		t.Fatalf("write doc-update: %v", err)
	}
	flush := `{"type":"flush","uuid":"` + uuid + `"}`
	if err := b.WriteMessage(websocket.TextMessage, []byte(flush)); err != nil {
		t.Fatalf("write flush: %v", err)
	}
	expectMessage(t, b, `"flush-ack"`, 2*time.Second)

	// Sequence teardown BEFORE reading the store: B's owner-close flush must
	// finish so the disk read below doesn't race it (shared storable buffer).
	closeAndSettle(b)

	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("load after flush: %v", err)
	}
	if !strings.Contains(string(doc.Body()), "survived-the-race") {
		t.Fatalf("update lost — stale teardown closed the successor's shadow; body: %q", string(doc.Body()))
	}
}
