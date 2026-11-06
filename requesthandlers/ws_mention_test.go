package requesthandlers

import (
	"encoding/json"
	"fmt"
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
	offers   []domain.Candidate
	nodes    map[string]domain.NodeDescriptor
	resolved []string
	asked    []domain.SearchCriteria
}

func (s *stubSource) Name() string { return "stub" }

func (s *stubSource) Search(criteria domain.SearchCriteria) []domain.Candidate {
	s.asked = append(s.asked, criteria)
	if criteria.Limit < len(s.offers) {
		return s.offers[:criteria.Limit]
	}
	return s.offers
}

// last is the criteria the source was last asked with.
func (s *stubSource) last(t *testing.T) domain.SearchCriteria {
	t.Helper()
	if len(s.asked) == 0 {
		t.Fatal("the source was never asked")
	}
	return s.asked[len(s.asked)-1]
}

func (s *stubSource) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	uri := addr.String()
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
		{URI: "sieve://9f2b", Title: "Auth Design", Kind: "note", Detail: "design/ · #auth"},
		{URI: "sieve://7a1c", Title: "Auth Retry RFC", Kind: "note", Detail: "rfc/"},
	}}
	sp.Nodes = editor.NewRouter(src)
	sp.Search = sp.Nodes
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
	if first["uri"] != "sieve://9f2b" || first["title"] != "Auth Design" ||
		first["kind"] != "note" || first["detail"] != "design/ · #auth" {
		t.Fatalf("candidate shape = %+v", first)
	}
	// The picker asks for durable things only, on every field: a reference must
	// outlive the moment it was made, so a buffer is never offered.
	want := domain.SearchCriteria{
		Terms:       "auth",
		Fields:      domain.SearchFields{domain.SearchName, domain.SearchSummary, domain.SearchTags, domain.SearchContent},
		DurableOnly: true,
		Limit:       8,
	}
	if got := src.last(t); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("router was asked %+v, want %+v", got, want)
	}
}

// A blank query offers nothing, and asks no source.
func TestWS_MentionQuery_ABlankQueryOffersNothing(t *testing.T) {
	srv, _, src := newWsTestServerWithNodes(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{"type": "mention-query", "q": "  ", "correlationId": "c-m6"}); err != nil {
		t.Fatal(err)
	}
	frame := readFrame(t, conn, 2*time.Second)
	if cands, ok := frame["candidates"].([]interface{}); !ok || len(cands) != 0 || len(src.asked) != 0 {
		t.Fatalf("candidates = %#v after %d asks, want an empty list and none", frame["candidates"], len(src.asked))
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
	if got := src.last(t).Limit; got != mentionDefaultLimit {
		t.Errorf("absent limit = %d, want the default %d", got, mentionDefaultLimit)
	}

	if err := conn.WriteJSON(map[string]interface{}{"type": "mention-query", "q": "auth", "limit": 100000, "correlationId": "c-m3"}); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second)
	if got := src.last(t).Limit; got != mentionMaxLimit {
		t.Errorf("oversized limit = %d, want the cap %d", got, mentionMaxLimit)
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

// A mention-result is ack-shaped and therefore REQUESTER-AFFINE. A second
// workspace socket registering __workspace__ deposes the requester as owner, so
// reaching for sendTo(workspaceChannelKey) here would silently hand one tab's
// typeahead replies to another.
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
	sp.Nodes, sp.Search = nil, nil
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
