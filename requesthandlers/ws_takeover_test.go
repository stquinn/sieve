package requesthandlers

import (
	"strings"
	"sync"
	"testing"
	"time"

	"net/http/httptest"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"sieve/sieve"
	"sieve/sieve/block"
	_ "sieve/sieve/block/processors" // ProseProcessor self-registers via init
	"sieve/sieve/editor"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
	"sieve/store/filestore"
)

// newWsTestServer boots the REAL WS handler + EditorService over a temp store
// and returns the server plus a seeded document uuid. No wails devserver in
// the middle (its nil wsHandler panics on external WS upgrades — see
// TECH-DEBT), so this exercises exactly what the app's webview exercises.
func newWsTestServer(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *WsHandler, string) {
	t.Helper()
	return newWsTestServerWithDebounce(t, 0)
}

// newWsTestServerWithDebounce is newWsTestServer with the autosave delay chosen
// by the caller (0 = the 30s production default). A test that must observe the
// BACKGROUND flush — not one it asked for — needs the timer to fire inside its
// own patience.
func newWsTestServerWithDebounce(t *testing.T, debounce time.Duration) (*httptest.Server, *sieve.ServiceProvider, *WsHandler, string) {
	t.Helper()
	return newWsTestServerWithJobs(t, debounce, nil)
}

// testSpellService parses the 80,000-word dictionary ONCE per test binary. Every
// harness server shares it, so wiring spelling into the harness costs one parse
// rather than one per test.
var testSpellService = sync.OnceValue(func() *services.SpellService {
	// No user dictionary: the harness has no state store to persist one into, and
	// nothing here teaches the checker a word.
	return services.NewSpellService(nil)
})

// newWsTestServerWithJobs is newWsTestServerWithDebounce for a test that needs
// the workspace broadcast wired to a real JobsSource (jobs-changed frames) —
// jobs is now a constructor argument on WorkspaceBroadcast, not a settable
// field, so a caller who needs one must supply it here rather than poking
// h.broadcast after the fact.
func newWsTestServerWithJobs(t *testing.T, debounce time.Duration, jobs JobsSource) (*httptest.Server, *sieve.ServiceProvider, *WsHandler, string) {
	t.Helper()
	fs, err := filestore.NewFileStore(t.TempDir(), "testhost")
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ds, err := services.NewDocumentService(fs)
	if err != nil {
		t.Fatalf("NewDocumentService: %v", err)
	}
	es := editor.NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), debounce)
	st, err := services.NewStateService(fs, "", nil)
	if err != nil {
		t.Fatalf("NewStateService: %v", err)
	}
	sp := &sieve.ServiceProvider{Store: fs, Documents: ds, Editor: es, State: st}
	// The composition root's own wiring, minus the settings read: every producer
	// the app registers, spelling switched on, and the editor observing the engine
	// back. Registration goes through the root's own method so a producer added
	// there is a producer this harness serves.
	sp.Inspection = editor.NewInspectionEngine(es)
	sp.RegisterInspectors(testSpellService())
	if err := sp.Inspection.SetWorkspaceFeature(sp.Spell.Feature(), true, nil); err != nil {
		t.Fatalf("enable spelling: %v", err)
	}
	es.SetInspectionEngine(sp.Inspection)
	es.SetFocusListener(sp.Inspection)
	h := NewWsHandler(sp, NewWorkspaceBroadcast(jobs), testWSToken)
	// The same edge the composition root wires: a save announces itself to the
	// workspace fan-out. Without it a test watching for container-saved would be
	// watching a wire nothing publishes on.
	es.SetSavedNotifier(h.broadcast)
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
	c, _, err := wsDialer().Dial(wsAddr(srv, "/api/ws/document/"+uuid), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return c
}

func createProseOp(uuid, token string) string {
	return `{"type":"block-op","uuid":"` + uuid + `","op":{"type":"create-block","kind":"prose","attrs":{"content":"probe"},"token":"` + token + `"}}`
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

	// The save barrier: a flush answers nothing on the document wire, so the
	// workspace fact is how this test knows the write finished before it reads
	// the store.
	workspace := dialWorkspaceWS(t, srv)
	defer workspace.Close()

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
	expectMessage(t, workspace, `"`+protocol.TypeContainerSaved+`"`, 2*time.Second)

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
// LATER registrant (A) owns the channel, but a mutating frame arrives on the
// OTHER live socket (B). B must re-claim ownership so the frame's synchronous
// render-back lands on B — the acting window — not on the co-claimant A. B is
// dialled FIRST so A is the registered owner at the moment B writes; that is the
// exact race.
//
// A feature-control frame is one of them. Most change nothing, but a feature's
// parameters can carry an imperative it obeys against the document, and the
// render-backs that follow are as synchronous as any op's — so the frame claims
// like an op rather than being read as the switch it usually is.
func TestWS_MutatingFrameClaimsListener(t *testing.T) {
	const replaceAll = `{"type":"feature-control","feature":"find","enabled":true,` +
		`"parameters":{"term":"the","replacement":"a","replaceAll":true}}`

	cases := []struct {
		name, body, echo string
		frame            func(uuid string) string
	}{
		{
			name:  "a granular op",
			frame: func(uuid string) string { return createProseOp(uuid, "tok-claim") },
			echo:  protocol.TypeInsertBlock,
		},
		{
			name:  "a feature-control carrying an imperative",
			body:  "the cat sat on the mat",
			frame: func(string) string { return replaceAll },
			echo:  protocol.TypeReplaceBlock,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, sp, h, uuid := newWsTestServer(t)
			if tc.body != "" {
				seedBody(t, sp, uuid, tc.body)
			}

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
			if err := b.WriteMessage(websocket.TextMessage, []byte(tc.frame(uuid))); err != nil {
				t.Fatalf("write %s: %v", tc.name, err)
			}
			// B must receive its own render-back (proves the claim); A must not.
			expectMessage(t, b, `"`+tc.echo+`"`, 2*time.Second)
			expectNoMessage(t, a, `"`+tc.echo+`"`, 500*time.Millisecond)

			// And subsequent unsolicited sendTo(uuid) render-backs now route to B.
			h.sendTo(uuid, map[string]string{"type": "probe-owner-b"})
			expectMessage(t, b, "probe-owner-b", 2*time.Second)
			expectNoMessage(t, a, "probe-owner-b", 500*time.Millisecond)

			closeAndSettle(a)
		})
	}
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

	// The save barrier — see TestWS_StaleTeardownMustNotCloseSuccessorShadow.
	workspace := dialWorkspaceWS(t, srv)
	defer workspace.Close()

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
	expectMessage(t, workspace, `"`+protocol.TypeContainerSaved+`"`, 2*time.Second)

	sp.Editor.Close(uuid)

	doc, err := sp.Documents.LoadByUUID(uuid)
	if err != nil {
		t.Fatalf("load after flush: %v", err)
	}
	if !strings.Contains(string(doc.Body()), "claimed-and-survived") {
		t.Fatalf("update lost — deposed teardown closed the claimant's shadow; body: %q", string(doc.Body()))
	}
}
