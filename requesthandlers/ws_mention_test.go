package requesthandlers

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"sieve/sieve"
	"sieve/sieve/domain"
	"sieve/sieve/editor"
)

// stubSource is a NodeSource double: it records what the Router asked for and
// answers from a fixed offer list. No store, no disk — a typeahead's contract is
// query in, candidates out. `nodes` is the dereference half (the resolve
// round-trip's input); it stays empty for the enumeration tests, where every
// address is dangling by design.
type stubSource struct {
	offers    []domain.Candidate
	nodes     map[string]domain.NodeDescriptor
	resolved  []string
	lastQuery string
	lastLimit int
}

func (s *stubSource) Name() string { return "stub" }

func (s *stubSource) Search(query string, limit int) []domain.Candidate {
	s.lastQuery, s.lastLimit = query, limit
	if limit < len(s.offers) {
		return s.offers[:limit]
	}
	return s.offers
}

func (s *stubSource) Resolve(uri string) (domain.NodeDescriptor, error) {
	s.resolved = append(s.resolved, uri)
	if node, ok := s.nodes[uri]; ok {
		return node, nil
	}
	return domain.NodeDescriptor{}, domain.ErrNodeNotFound
}

func newWsTestServerWithNodes(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *stubSource) {
	t.Helper()
	srv, sp, _, _ := newWsTestServer(t)
	src := &stubSource{offers: []domain.Candidate{
		{URI: "container:9f2b", Title: "Auth Design", Kind: "note", Detail: "design/ · #auth"},
		{URI: "container:7a1c", Title: "Auth Retry RFC", Kind: "note", Detail: "rfc/"},
	}}
	sp.Nodes = editor.NewRouter(src)
	return srv, sp, src
}

// The typeahead round-trip: a mention-query frame on the WORKSPACE wire comes back
// as a correlated mention-result. Not a Command — no JobEngine job, no result
// block, no PENDING/COMPLETE pair; a sibling frame type on the same socket.
func TestWS_MentionQuery_RoundTripsCandidates(t *testing.T) {
	srv, _, src := newWsTestServerWithNodes(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "mention-query", "q": "auth", "limit": 8, "correlationId": "c-m1",
	}); err != nil {
		t.Fatal(err)
	}

	frame := readFrame(t, conn, 2*time.Second)
	if frame["type"] != "mention-result" || frame["correlationId"] != "c-m1" {
		t.Fatalf("want a correlated mention-result, got %+v", frame)
	}
	cands, _ := frame["candidates"].([]interface{})
	if len(cands) != 2 {
		t.Fatalf("candidates = %+v, want 2", frame["candidates"])
	}
	first, _ := cands[0].(map[string]interface{})
	if first["uri"] != "container:9f2b" || first["title"] != "Auth Design" ||
		first["kind"] != "note" || first["detail"] != "design/ · #auth" {
		t.Fatalf("candidate shape = %+v", first)
	}
	if src.lastQuery != "auth" || src.lastLimit != 8 {
		t.Fatalf("router saw q=%q limit=%d", src.lastQuery, src.lastLimit)
	}
}

// A query with no limit gets the default budget, and an absurd one is capped:
// the wire is client-supplied, and an unbounded limit is an unbounded library
// scan on the UI's socket.
func TestWS_MentionQuery_LimitIsFlooredAndCapped(t *testing.T) {
	srv, _, src := newWsTestServerWithNodes(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{"type": "mention-query", "q": "auth", "correlationId": "c-m2"}); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second)
	if src.lastLimit != mentionDefaultLimit {
		t.Errorf("absent limit = %d, want the default %d", src.lastLimit, mentionDefaultLimit)
	}

	if err := conn.WriteJSON(map[string]interface{}{"type": "mention-query", "q": "auth", "limit": 100000, "correlationId": "c-m3"}); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second)
	if src.lastLimit != mentionMaxLimit {
		t.Errorf("oversized limit = %d, want the cap %d", src.lastLimit, mentionMaxLimit)
	}
}

// An empty result is an EMPTY LIST, never a null: the picker renders "no
// matches", and a null would be an undefined-length crash on the JS side.
func TestWS_MentionQuery_NoMatchesRepliesWithAnEmptyList(t *testing.T) {
	srv, _, src := newWsTestServerWithNodes(t)
	src.offers = nil
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{"type": "mention-query", "q": "zzz", "correlationId": "c-m4"}); err != nil {
		t.Fatal(err)
	}
	frame := readFrame(t, conn, 2*time.Second)
	cands, ok := frame["candidates"].([]interface{})
	if !ok || len(cands) != 0 {
		t.Fatalf("candidates = %#v, want an empty list", frame["candidates"])
	}
}

// TestWS_MentionResult_RoutesToRequester_NotChannelOwner is the mention half of
// the 2026-07-26 stolen-/btw incident: a second workspace socket registering
// __workspace__ deposes the requester as owner. A mention-result is ack-shaped, so
// it is REQUESTER-AFFINE — reaching for sendTo(workspaceChannelKey) here would
// silently hand one tab's typeahead replies to another.
func TestWS_MentionResult_RoutesToRequester_NotChannelOwner(t *testing.T) {
	srv, _, _ := newWsTestServerWithNodes(t)
	requester := dialWorkspaceWS(t, srv)
	defer requester.Close()

	// A second workspace socket connects and takes over __workspace__ BEFORE the query.
	thief := dialWorkspaceWS(t, srv)
	defer thief.Close()
	if err := thief.WriteJSON(map[string]string{"type": "ping"}); err != nil {
		t.Fatal(err)
	}
	_ = readUntil(t, thief, "pong", 2*time.Second)

	if err := requester.WriteJSON(map[string]interface{}{
		"type": "mention-query", "q": "auth", "correlationId": "c-steal-m",
	}); err != nil {
		t.Fatal(err)
	}

	frame := readFrame(t, requester, 2*time.Second)
	if frame["correlationId"] != "c-steal-m" || frame["type"] != "mention-result" {
		t.Fatalf("expected the result on the requesting socket, got %+v", frame)
	}

	_ = thief.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, raw, err := thief.ReadMessage(); err == nil {
		var m map[string]interface{}
		_ = json.Unmarshal(raw, &m)
		if m["correlationId"] == "c-steal-m" {
			t.Fatalf("mention result leaked to the deposing socket: %s", string(raw))
		}
	}
}

// No Router wired (an unconfigured floor) must still answer — the picker gets an
// empty list rather than hanging on a reply that never comes.
func TestWS_MentionQuery_NoRouterStillReplies(t *testing.T) {
	srv, sp, _, _ := newWsTestServer(t)
	sp.Nodes = nil
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{"type": "mention-query", "q": "auth", "correlationId": "c-m5"}); err != nil {
		t.Fatal(err)
	}
	frame := readFrame(t, conn, 2*time.Second)
	if frame["type"] != "mention-result" || frame["correlationId"] != "c-m5" {
		t.Fatalf("want an empty mention-result, got %+v", frame)
	}
	if cands, ok := frame["candidates"].([]interface{}); !ok || len(cands) != 0 {
		t.Fatalf("candidates = %#v, want an empty list", frame["candidates"])
	}
}
