package requesthandlers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// readFrame reads one WS frame as a decoded map within timeout, or fails.
func readFrame(t *testing.T, c *websocket.Conn, timeout time.Duration) map[string]interface{} {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(timeout))
	_, raw, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read frame: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode frame %q: %v", string(raw), err)
	}
	return m
}

// readUntil reads frames until one of type wantType arrives (draining unrelated
// frames), or fails after timeout. Returns the matching frame.
func readUntil(t *testing.T, c *websocket.Conn, wantType string, timeout time.Duration) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		_ = c.SetReadDeadline(deadline)
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read until %q: %v", wantType, err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		if m["type"] == wantType {
			return m
		}
	}
}

// createProseOpWithOpID mints a create-block frame carrying the outer-envelope opId.
func createProseOpWithOpID(uuid, token, opID string) string {
	return `{"type":"block-op","opId":"` + opID + `","uuid":"` + uuid +
		`","op":{"type":"create-block","kind":"prose","attrs":{"content":"probe"},"index":0,"token":"` + token + `"}}`
}

// A block-op-ack for a successful create MUST arrive with ok:true, echo the opId,
// and land AFTER the insert-block render-back on the same socket (the ordering the
// JS correlation relies on).
func TestWS_BlockOpAck_SuccessArrivesAfterRenderBack(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOpWithOpID(uuid, "tok-ok", "op-7"))); err != nil {
		t.Fatalf("write: %v", err)
	}

	// First correlated frame back must be the render-back, THEN the ack.
	insert := readFrame(t, c, 2*time.Second)
	if insert["type"] != "insert-block" {
		t.Fatalf("expected insert-block render-back first, got %v", insert["type"])
	}
	ack := readFrame(t, c, 2*time.Second)
	if ack["type"] != "block-op-ack" {
		t.Fatalf("expected block-op-ack after the render-back, got %v", ack["type"])
	}
	if ack["opId"] != "op-7" {
		t.Errorf("ack opId = %v, want op-7", ack["opId"])
	}
	if ack["ok"] != true {
		t.Errorf("ack ok = %v, want true", ack["ok"])
	}
	if _, hasErr := ack["error"]; hasErr {
		t.Errorf("success ack must not carry an error field, got %v", ack["error"])
	}
	closeAndSettle(c)
}

// A failing block-op (delete of a ghost block on an open doc) MUST still produce a
// block-op-ack with ok:false + an error message, alongside the unchanged error frame.
func TestWS_BlockOpAck_FailureCarriesError(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	badOp := `{"type":"block-op","opId":"op-9","uuid":"` + uuid +
		`","op":{"type":"delete-block","blockId":"ghost-does-not-exist"}}`
	if err := c.WriteMessage(websocket.TextMessage, []byte(badOp)); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The generic error frame is still emitted (compat) …
	errFrame := readUntil(t, c, "error", 2*time.Second)
	if msg, _ := errFrame["message"].(string); !strings.Contains(msg, "delete-block") {
		t.Errorf("error frame message = %q, want it to mention delete-block", msg)
	}
	// … and the correlated ack reports the failure.
	ack := readUntil(t, c, "block-op-ack", 2*time.Second)
	if ack["opId"] != "op-9" {
		t.Errorf("ack opId = %v, want op-9", ack["opId"])
	}
	if ack["ok"] != false {
		t.Errorf("ack ok = %v, want false", ack["ok"])
	}
	if msg, _ := ack["error"].(string); msg == "" {
		t.Errorf("failure ack must carry an error message, got empty")
	}
	closeAndSettle(c)
}

// A block-op WITHOUT an opId gets its replies without opId — the compatibility
// pin: an unadorned frame behaves exactly as before (no ack, render-back only).
func TestWS_BlockOp_NoOpIDGetsNoAck(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-plain"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	insert := readFrame(t, c, 2*time.Second)
	if insert["type"] != "insert-block" {
		t.Fatalf("expected insert-block, got %v", insert["type"])
	}
	if _, has := insert["opId"]; has {
		t.Errorf("render-back for an opId-less request must not carry opId, got %v", insert["opId"])
	}
	// No ack must follow: a short read should time out rather than yield a frame.
	_ = c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, raw, err := c.ReadMessage(); err == nil {
		t.Fatalf("expected NO further frame for an opId-less block-op, got %q", string(raw))
	}
	closeAndSettle(c)
}

// flush WITH an opId echoes it on the request-correlated flush-ack. A successful
// flush ALSO fires the unsolicited background flush-ack (notifySaved) with NO opId
// — the two paths coexist, and correlation keys on the opId one.
func TestWS_FlushAck_EchoesOpID(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	flush := `{"type":"flush","opId":"op-42","uuid":"` + uuid + `"}`
	if err := c.WriteMessage(websocket.TextMessage, []byte(flush)); err != nil {
		t.Fatalf("write flush: %v", err)
	}
	// Drain flush-acks until the request-correlated one (opId op-42) arrives — the
	// background notifySaved ack (no opId) may precede it.
	deadline := time.Now().Add(2 * time.Second)
	found := false
	for !found {
		_ = c.SetReadDeadline(deadline)
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read flush-ack: %v", err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil || m["type"] != "flush-ack" {
			continue
		}
		if m["opId"] == "op-42" {
			found = true
		}
	}

	// A flush WITHOUT opId gets ONLY opId-less flush-acks (compat): collect every
	// flush-ack in a short window and assert none carries an opId.
	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"flush","uuid":"`+uuid+`"}`)); err != nil {
		t.Fatalf("write flush 2: %v", err)
	}
	sawAck := false
	end := time.Now().Add(500 * time.Millisecond)
	for {
		_ = c.SetReadDeadline(end)
		_, raw, err := c.ReadMessage()
		if err != nil {
			break // read deadline reached — done collecting
		}
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil || m["type"] != "flush-ack" {
			continue
		}
		sawAck = true
		if _, has := m["opId"]; has {
			t.Errorf("opId-less flush must get opId-less acks, got %v", m["opId"])
		}
	}
	if !sawAck {
		t.Errorf("expected at least one flush-ack for the opId-less flush")
	}
	closeAndSettle(c)
}

// extract-ack covers the TRANSFORM path, which emits NO block-extracted hint: the
// ack is the only correlated reply, and it must arrive with the echoed opId.
func TestWS_ExtractAck_TransformHasNoHintButAcks(t *testing.T) {
	srv, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	// Seed a prose block to transform.
	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOpWithOpID(uuid, "tok-src", "op-seed"))); err != nil {
		t.Fatalf("write create: %v", err)
	}
	insert := readFrame(t, c, 2*time.Second)
	srcID, _ := insert["id"].(string)
	if srcID == "" {
		t.Fatalf("no source block id from insert-block: %v", insert)
	}
	readUntil(t, c, "block-op-ack", 2*time.Second) // drain the create ack

	// Transform it in place: operation=transform → replace-block render-back, NO
	// block-extracted, but an extract-ack. Prose is the only self-registered
	// processor in the WS harness (the rest need injected BlockServices); the ack
	// mechanics are kind-blind, so a prose→prose transform exercises the path.
	entries := `[{"mimeType":"text/plain","content":"probe"}]`
	extract := `{"type":"extract","opId":"op-tx","blockId":"` + srcID +
		`","targetKind":"prose","operation":"transform","entries":` + entries + `,"index":-1}`
	if err := c.WriteMessage(websocket.TextMessage, []byte(extract)); err != nil {
		t.Fatalf("write extract: %v", err)
	}

	// Read every frame until the ack; assert no block-extracted appeared en route.
	deadline := time.Now().Add(2 * time.Second)
	sawExtracted := false
	for {
		_ = c.SetReadDeadline(deadline)
		_, raw, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("read to extract-ack: %v", err)
		}
		var m map[string]interface{}
		if err := json.Unmarshal(raw, &m); err != nil {
			continue
		}
		if m["type"] == "block-extracted" {
			sawExtracted = true
		}
		if m["type"] == "extract-ack" {
			if m["opId"] != "op-tx" {
				t.Errorf("extract-ack opId = %v, want op-tx", m["opId"])
			}
			if m["ok"] != true {
				t.Errorf("extract-ack ok = %v, want true", m["ok"])
			}
			break
		}
	}
	if sawExtracted {
		t.Errorf("a transform must NOT emit block-extracted, but one arrived")
	}
	closeAndSettle(c)
}
