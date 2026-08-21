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

// Addresses are uuid-strict since #75, so these need real ones.
const (
	resolveContainerUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b01"
	resolveMissingUUID   = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b02"
	resolveBlockUUID     = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b03"
)

// newWsTestServerWithResolvableNodes wires a Router whose one source HOLDS a
// document, so the resolve round-trip has something to answer with.
func newWsTestServerWithResolvableNodes(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *stubSource) {
	t.Helper()
	srv, sp, _, _ := newWsTestServer(t)
	uri := domain.NewContainerAddress(resolveContainerUUID).String()
	src := &stubSource{nodes: map[string]domain.Node{
		uri: {URI: uri, UUID: resolveContainerUUID, Kind: "note", Title: "Auth Design"},
	}}
	sp.Nodes = editor.NewRouter(src)
	return srv, sp, src
}

// THE ROUND-TRIP the chip click rides. JS holds the coordinate as an OPAQUE
// string and asks what it opens; Go answers with something JS can act on — a
// document uuid — having learned the grammar on its behalf.
func TestWS_MentionResolve_AnswersWhereAContainerAddressOpens(t *testing.T) {
	srv, _, _ := newWsTestServerWithResolvableNodes(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	uri := domain.NewContainerAddress(resolveContainerUUID).String()
	if err := conn.WriteJSON(map[string]interface{}{
		"type": "mention-resolve", "uri": uri, "correlationId": "c-r1",
	}); err != nil {
		t.Fatal(err)
	}

	frame := readFrame(t, conn, 2*time.Second)
	if frame["type"] != "mention-resolved" || frame["correlationId"] != "c-r1" {
		t.Fatalf("want a correlated mention-resolved, got %+v", frame)
	}
	if frame["found"] != true || frame["uuid"] != resolveContainerUUID {
		t.Fatalf("frame = %+v, want the container's uuid", frame)
	}
	if frame["blockId"] != "" {
		t.Errorf("blockId = %v, want empty for a whole-container address", frame["blockId"])
	}
	if frame["title"] != "Auth Design" || frame["kind"] != "note" {
		t.Errorf("frame = %+v, want the resolved node's title/kind", frame)
	}
	if frame["uri"] != uri {
		t.Errorf("uri = %v, want the address echoed back", frame["uri"])
	}
}

// A block: coordinate — the form #75's grammar defines and the JS decode could
// only ever DROP — opens its CONTAINER and names the block to reveal. The
// frontend still learns no grammar: it gets a uuid and a block id.
func TestWS_MentionResolve_AQualifiedBlockAddressOpensItsContainer(t *testing.T) {
	srv, _, _ := newWsTestServerWithResolvableNodes(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	uri := "block:" + resolveContainerUUID + "/" + resolveBlockUUID
	if err := conn.WriteJSON(map[string]interface{}{
		"type": "mention-resolve", "uri": uri, "correlationId": "c-r2",
	}); err != nil {
		t.Fatal(err)
	}

	frame := readFrame(t, conn, 2*time.Second)
	if frame["found"] != true || frame["uuid"] != resolveContainerUUID {
		t.Fatalf("frame = %+v, want the container to open", frame)
	}
	if frame["blockId"] != resolveBlockUUID {
		t.Fatalf("blockId = %v, want the block to reveal", frame["blockId"])
	}
}

// UNRESOLVABLE IS AN ANSWER, NOT SILENCE. The JS guard this replaces returned
// early on anything it did not recognise, so the chip did nothing and said
// nothing. Every request gets a reply; an unresolvable one carries found:false
// and a reason.
func TestWS_MentionResolve_UnresolvableAddressesAnswerWithAReason(t *testing.T) {
	srv, _, _ := newWsTestServerWithResolvableNodes(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	cases := []struct{ name, uri string }{
		{"malformed", "not-an-address"},
		{"dangling", domain.NewContainerAddress(resolveMissingUUID).String()},
		{"version pin", domain.NewContainerAddress(resolveContainerUUID).String() + "@v2"},
		{"bare block", "block:" + resolveBlockUUID},
	}
	for i, tc := range cases {
		cid := "c-bad-" + tc.name
		if err := conn.WriteJSON(map[string]interface{}{
			"type": "mention-resolve", "uri": tc.uri, "correlationId": cid,
		}); err != nil {
			t.Fatal(err)
		}
		frame := readFrame(t, conn, 2*time.Second)
		if frame["correlationId"] != cid || frame["type"] != "mention-resolved" {
			t.Fatalf("case %d (%s): want a correlated reply, got %+v", i, tc.name, frame)
		}
		if frame["found"] != false {
			t.Errorf("case %s: found = %v, want false", tc.name, frame["found"])
		}
		if msg, _ := frame["error"].(string); msg == "" {
			t.Errorf("case %s: an unresolvable address must say why, got %+v", tc.name, frame)
		}
	}
}

// The mention-resolved frame is correlated and therefore ack-shaped: it must go
// back to the REQUESTER. The 2026-07-26 stolen-/btw incident is why — a second
// workspace socket deposes the first as __workspace__ owner, and a handler reaching
// for sendTo(workspaceChannelKey) would hand this tab's answer to the other one.
func TestWS_MentionResolved_RoutesToRequester_NotChannelOwner(t *testing.T) {
	srv, _, _ := newWsTestServerWithResolvableNodes(t)
	requester := dialWorkspaceWS(t, srv)
	defer requester.Close()

	thief := dialWorkspaceWS(t, srv)
	defer thief.Close()
	if err := thief.WriteJSON(map[string]string{"type": "ping"}); err != nil {
		t.Fatal(err)
	}
	_ = readUntil(t, thief, "pong", 2*time.Second)

	if err := requester.WriteJSON(map[string]interface{}{
		"type": "mention-resolve",
		"uri":  domain.NewContainerAddress(resolveContainerUUID).String(), "correlationId": "c-steal-r",
	}); err != nil {
		t.Fatal(err)
	}

	frame := readFrame(t, requester, 2*time.Second)
	if frame["correlationId"] != "c-steal-r" || frame["type"] != "mention-resolved" {
		t.Fatalf("expected the reply on the requesting socket, got %+v", frame)
	}

	_ = thief.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, raw, err := thief.ReadMessage(); err == nil {
		var m map[string]interface{}
		_ = json.Unmarshal(raw, &m)
		if m["correlationId"] == "c-steal-r" {
			t.Fatalf("resolve reply leaked to the deposing socket: %s", string(raw))
		}
	}
}

// No Router wired (the unconfigured floor) must still ANSWER — a click that
// waits on a reply that never comes is the silent failure in a slower costume.
func TestWS_MentionResolve_NoRouterStillReplies(t *testing.T) {
	srv, sp, _, _ := newWsTestServer(t)
	sp.Nodes = nil
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "mention-resolve", "uri": domain.NewContainerAddress(resolveContainerUUID).String(),
		"correlationId": "c-r5",
	}); err != nil {
		t.Fatal(err)
	}
	frame := readFrame(t, conn, 2*time.Second)
	if frame["type"] != "mention-resolved" || frame["correlationId"] != "c-r5" || frame["found"] != false {
		t.Fatalf("want an unfound mention-resolved, got %+v", frame)
	}
}
