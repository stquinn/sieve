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
func newWsTestServer(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *WsHandler, string) {
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
	return srv, sp, h, doc.UUID()
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

// expectNoMessage asserts needle does NOT arrive on c within the window. Other
// traffic (e.g. a correlated pong) is drained and ignored; only needle fails it.
func expectNoMessage(t *testing.T, c *websocket.Conn, needle string, within time.Duration) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(within))
	for {
		_, raw, err := c.ReadMessage()
		if err != nil {
			return // read deadline / close: needle never arrived — good
		}
		if strings.Contains(string(raw), needle) {
			t.Fatalf("expected NO %q on this conn, but it arrived: %s", needle, string(raw))
		}
	}
}

// Control: a single connection creating a block MUST receive the insert-block
// render-back. Validates the harness before the race assertion means anything.
func TestWS_SingleConnReceivesInsertBlock(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-ctl"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	expectMessage(t, c, `"insert-block"`, 2*time.Second)
}

// THE RACE (user-reported, wails dev): a stale connection's teardown runs
// AFTER its successor registered. The stale defer must NOT evict the
// successor's channel — render-backs must keep flowing to the live conn.
func TestWS_StaleTeardownMustNotEvictSuccessorChannel(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)

	a := dialWS(t, srv, uuid) // will become stale
	if err := a.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier A: %v", err)
	}
	expectMessage(t, a, `"pong"`, 5*time.Second)

	b := dialWS(t, srv, uuid) // takeover: the live connection
	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier B: %v", err)
	}
	expectMessage(t, b, `"pong"`, 5*time.Second)

	closeAndSettle(a) // let A's server goroutine run its (stale) defers

	if err := b.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-race"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	expectMessage(t, b, `"insert-block"`, 2*time.Second)
}

// Same race, second blast radius: the stale defer must NOT close the shadow
// the successor is using — a doc-update + flush through the live conn must
// reach disk ("lost updates" in the user report).
func TestWS_StaleTeardownMustNotCloseSuccessorShadow(t *testing.T) {
	srv, sp, _, uuid := newWsTestServer(t)

	a := dialWS(t, srv, uuid)
	if err := a.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier A: %v", err)
	}
	expectMessage(t, a, `"pong"`, 5*time.Second)

	b := dialWS(t, srv, uuid)
	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier B: %v", err)
	}
	expectMessage(t, b, `"pong"`, 5*time.Second)

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

	// Sequence teardown BEFORE reading the store: close the shadow explicitly
	// so the disk flush finishes synchronously and the read below doesn't race it.
	sp.Editor.Close(uuid)

	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("load after flush: %v", err)
	}
	if !strings.Contains(string(doc.Body()), "survived-the-race") {
		t.Fatalf("update lost — stale teardown closed the successor's shadow; body: %q", string(doc.Body()))
	}
}

// CLAIM-ON-WRITE (user-reported, dev-server tab + app window on one uuid): the
// LATER registrant (A) owns the channel, but a mutating op arrives on the OTHER
// live socket (B). B must re-claim ownership so the op's synchronous render-back
// lands on B — the acting window — not on the co-claimant A. B is dialled FIRST
// so A is the registered owner at the moment B writes; that is the exact race.
func TestWS_MutatingFrameClaimsListener(t *testing.T) {
	srv, _, h, uuid := newWsTestServer(t)

	b := dialWS(t, srv, uuid) // acting window (registers first)
	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier B: %v", err)
	}
	expectMessage(t, b, `"pong"`, 5*time.Second)

	a := dialWS(t, srv, uuid) // co-claimant, ends up the registered owner
	if err := a.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier A: %v", err)
	}
	expectMessage(t, a, `"pong"`, 5*time.Second)

	// Sanity: A is the registered owner before B writes.
	if err := b.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-claim"))); err != nil {
		t.Fatalf("write block-op: %v", err)
	}
	// B must receive its own render-back (proves the claim); A must not.
	expectMessage(t, b, `"insert-block"`, 2*time.Second)
	expectNoMessage(t, a, `"insert-block"`, 500*time.Millisecond)

	// And subsequent unsolicited sendTo(uuid) render-backs now route to B.
	h.sendTo(uuid, map[string]string{"type": "probe-owner-b"})
	expectMessage(t, b, "probe-owner-b", 2*time.Second)
	expectNoMessage(t, a, "probe-owner-b", 500*time.Millisecond)

	closeAndSettle(a)
}

// A NON-mutating frame (ping heartbeat) from the non-registered socket must NOT
// steal ownership — a backgrounded stale tab proving liveness is not a human
// edit. A stays the listener; its render-backs keep flowing to A, not B.
func TestWS_NonMutatingFrameDoesNotClaim(t *testing.T) {
	srv, _, h, uuid := newWsTestServer(t)

	b := dialWS(t, srv, uuid) // registers first
	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier B: %v", err)
	}
	expectMessage(t, b, `"pong"`, 5*time.Second)

	a := dialWS(t, srv, uuid) // registered owner
	if err := a.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier A: %v", err)
	}
	expectMessage(t, a, `"pong"`, 5*time.Second)

	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	expectMessage(t, b, `"pong"`, 5*time.Second) // correlated reply, not a claim

	// Ownership unchanged: an unsolicited render-back still routes to A.
	h.sendTo(uuid, map[string]string{"type": "probe-owner-a"})
	expectMessage(t, a, "probe-owner-a", 5*time.Second)
	expectNoMessage(t, b, "probe-owner-a", 500*time.Millisecond)

	closeAndSettle(a)
}

// Compose claim-on-write with the 6e2ccfc ownership guard: after B claims via a
// mutating frame, the DEPOSED A dying must NOT unregister B or close B's shadow.
// Mirrors TestWS_StaleTeardownMustNot* but with B taking ownership by WRITE
// rather than by being the later registrant.
func TestWS_ClaimComposesWithStaleTeardownGuard(t *testing.T) {
	srv, sp, h, uuid := newWsTestServer(t)

	b := dialWS(t, srv, uuid) // acting window (registers first)
	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier B: %v", err)
	}
	expectMessage(t, b, `"pong"`, 5*time.Second)

	a := dialWS(t, srv, uuid) // registered owner, about to be deposed
	if err := a.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write barrier A: %v", err)
	}
	expectMessage(t, a, `"pong"`, 5*time.Second)

	if err := b.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-compose"))); err != nil {
		t.Fatalf("write block-op: %v", err)
	}
	expectMessage(t, b, `"insert-block"`, 2*time.Second) // B claimed

	closeAndSettle(a) // deposed A's teardown must be a no-op for B's ownership

	// B is still the listener (channel not evicted).
	h.sendTo(uuid, map[string]string{"type": "probe-after-deposed-death"})
	expectMessage(t, b, "probe-after-deposed-death", 2*time.Second)

	// B's shadow is still open — a doc-update + flush through B reaches disk.
	update := `{"type":"doc-update","uuid":"` + uuid + `","markdown":"claimed-and-survived"}`
	if err := b.WriteMessage(websocket.TextMessage, []byte(update)); err != nil {
		t.Fatalf("write doc-update: %v", err)
	}
	if err := b.WriteMessage(websocket.TextMessage, []byte(`{"type":"flush","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write flush: %v", err)
	}
	expectMessage(t, b, `"flush-ack"`, 2*time.Second)

	sp.Editor.Close(uuid)

	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("load after flush: %v", err)
	}
	if !strings.Contains(string(doc.Body()), "claimed-and-survived") {
		t.Fatalf("update lost — deposed teardown closed the claimant's shadow; body: %q", string(doc.Body()))
	}
}
