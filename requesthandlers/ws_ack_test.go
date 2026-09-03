package requesthandlers

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sieve/sieve/block"
	"sieve/sieve/block/processors"
	"sieve/sieve/domain"
	"sieve/sieve/protocol"
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
		`","op":{"type":"create-block","kind":"prose","attrs":{"content":"probe"},"token":"` + token + `"}}`
}

// A block-op-ack for a successful create MUST arrive with ok:true, echo the opId,
// and land AFTER the insert-block render-back on the same socket (the ordering the
// JS correlation relies on).
func TestWS_BlockOpAck_SuccessArrivesAfterRenderBack(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOpWithOpID(uuid, "tok-ok", "op-7"))); err != nil {
		t.Fatalf("write: %v", err)
	}

	// The render-back must come before the ack. readUntil only reads FORWARD, so
	// an ack that arrived first would be consumed here and the second read would
	// time out — the ordering is pinned without also asserting that no unrelated
	// server-initiated frame shares the socket.
	readUntil(t, c, protocol.TypeInsertBlock, 2*time.Second)
	ack := readUntil(t, c, protocol.TypeBlockOpAck, 2*time.Second)
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
	srv, _, _, uuid := newWsTestServer(t)
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
	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOp(uuid, "tok-plain"))); err != nil {
		t.Fatalf("write: %v", err)
	}
	insert := readUntil(t, c, protocol.TypeInsertBlock, 2*time.Second)
	if _, has := insert["opId"]; has {
		t.Errorf("render-back for an opId-less request must not carry opId, got %v", insert["opId"])
	}
	// No ack must follow. Unrelated server-initiated traffic on the same socket
	// (text marks push themselves when a channel opens) is drained, because
	// this pins what an opId-less REQUEST is answered with, not what else a
	// document channel carries.
	expectNoMessage(t, c, `"`+protocol.TypeBlockOpAck+`"`, 300*time.Millisecond)
	closeAndSettle(c)
}

// extract-ack covers the TRANSFORM path: the new block reaches the client as a
// replace-block render-back, and the ack — the only correlated reply — follows
// it with the echoed opId.
func TestWS_ExtractAck_TransformRendersBackThenAcks(t *testing.T) {
	srv, _, _, uuid := newWsTestServer(t)
	c := dialWS(t, srv, uuid)

	// Seed a prose block to transform.
	if err := c.WriteMessage(websocket.TextMessage, []byte(createProseOpWithOpID(uuid, "tok-src", "op-seed"))); err != nil {
		t.Fatalf("write create: %v", err)
	}
	insert := readUntil(t, c, protocol.TypeInsertBlock, 2*time.Second)
	srcID, _ := insert["id"].(string)
	if srcID == "" {
		t.Fatalf("no source block id from insert-block: %v", insert)
	}
	readUntil(t, c, "block-op-ack", 2*time.Second) // drain the create ack

	// Transform it in place: operation=transform → a replace-block render-back and
	// an extract-ack. Prose is the only self-registered processor in the WS harness
	// (the rest need injected BlockServices); the ack mechanics are kind-blind, so
	// a prose→prose transform exercises the path.
	entries := `[{"mimeType":"text/plain","content":"probe"}]`
	extract := `{"type":"extract","opId":"op-tx","blockId":"` + srcID +
		`","targetKind":"prose","operation":"transform","entries":` + entries + `}`
	if err := c.WriteMessage(websocket.TextMessage, []byte(extract)); err != nil {
		t.Fatalf("write extract: %v", err)
	}

	// Read every frame until the ack; the render-back must have arrived first —
	// the ordering the client's correlation relies on.
	deadline := time.Now().Add(2 * time.Second)
	sawReplace := false
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
		if m["type"] == "replace-block" {
			sawReplace = true
			if m["oldId"] != srcID {
				t.Errorf("replace-block oldId = %v, want %s", m["oldId"], srcID)
			}
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
	if !sawReplace {
		t.Errorf("a transform must render back with replace-block before its ack")
	}
	closeAndSettle(c)
}

// spellProseBlockID is the seeded prose block the text-replace cases write to.
// A real uuid: the loader upgrades any other handle it parses, and a test that
// names its target must seed one it will leave alone.
const spellProseBlockID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4c01"

// text-replace answers with an OUTCOME, and the outcomes it has to tell apart
// are not success and failure — they are "applied", "the run you pointed at is
// not there any more", and "that request names nothing I can write to". Stale
// draws no error frame: the client's view moved on, which is news about the
// mark rather than a fault.
//
// An applied edit reaches the client as the authoritative block through the
// replace-by-id render-back a transform takes — the client PLACES the block Go
// now holds rather than merging attrs onto text it believes it owns. Nothing
// about the new text rides in the ack.
//
// THE ANCHOR IS THE ONE THE READ LANE PUSHED. Every case takes the locator off
// a real text-marks frame and breaks at most one thing about it, because a
// locator is the block kind's own and nothing outside that kind — this test
// included — may spell one.
func TestWS_TextReplaceAck_ReportsAppliedOrStale(t *testing.T) {
	cases := []struct {
		name        string
		locator     string // empty means the one the marks push carried
		quote       string
		occurrence  int
		grain       string
		replacement string
		wantOutcome string
		wantContent string
		wantError   bool // whether the ack carries a message; only a refusal does
	}{
		{
			name:  "the anchor still resolves",
			quote: "helllo", occurrence: 0, grain: domain.GrainWord, replacement: "hello",
			wantOutcome: protocol.TextReplaceOK,
			wantContent: "a hello here",
		},
		{
			name:  "a literal anchor writes inside a word",
			quote: "elll", occurrence: 0, grain: domain.GrainLiteral, replacement: "ell",
			wantOutcome: protocol.TextReplaceOK,
			wantContent: "a hello here",
		},
		{
			name:  "the quote is not in the text",
			quote: "wolrd", occurrence: 0, grain: domain.GrainWord, replacement: "hello",
			wantOutcome: protocol.TextReplaceStale,
		},
		{
			name:  "the occurrence is past what the text holds",
			quote: "helllo", occurrence: 3, grain: domain.GrainWord, replacement: "hello",
			wantOutcome: protocol.TextReplaceStale,
		},
		{
			// The word IS in the text, but not as a word run — the grain the client
			// declared is the whole reason this does not resolve.
			name:  "a word grain does not reach inside a word",
			quote: "elll", occurrence: 0, grain: domain.GrainWord, replacement: "ell",
			wantOutcome: protocol.TextReplaceStale,
		},
		{
			// A locator this block's kind never minted is not a mark that went
			// stale — no text could make it resolve — so it is the third outcome.
			name:    "a locator the block's kind never minted",
			locator: "content",
			quote:   "helllo", occurrence: 0, grain: domain.GrainWord, replacement: "hello",
			wantOutcome: protocol.TextReplaceFailed, wantError: true,
		},
		{
			// An anchor with no grain says nothing about how its occurrence was
			// counted, so it names no run at all — a request no text could satisfy,
			// which is the refusal and not the staleness.
			name:  "an anchor declaring no grain",
			quote: "helllo", occurrence: 0, grain: "", replacement: "hello",
			wantOutcome: protocol.TextReplaceFailed, wantError: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			block.RegisterProcessor(&processors.ProseProcessor{})
			srv, sp, _, uuid := newWsTestServer(t)
			seedBody(t, sp, uuid, "<!--s:"+spellProseBlockID+"-->\na helllo here\n<!--/s:"+spellProseBlockID+"-->")

			c := dialWS(t, srv, uuid)
			locator := tc.locator
			if locator == "" {
				locator = pushedLocator(t, c)
			}
			send(t, c, `{"type":"text-replace","opId":"op-tr","blockId":"`+spellProseBlockID+
				`","locator":`+strconv.Quote(locator)+`,"quote":"`+tc.quote+`","occurrence":`+strconv.Itoa(tc.occurrence)+
				`,"grain":"`+tc.grain+`","start":2,"end":8,"replacement":"`+tc.replacement+`"}`)

			if tc.wantContent != "" {
				// The render-back must precede the ack. readUntil only reads
				// FORWARD, so an ack that arrived first would be consumed here and
				// the ack read below would time out.
				replace := readUntil(t, c, protocol.TypeReplaceBlock, 2*time.Second)
				if replace["oldId"] != spellProseBlockID || replace["newId"] != spellProseBlockID {
					t.Errorf("replace-block ids = (%v, %v), want both %s — a text edit keeps the block's identity",
						replace["oldId"], replace["newId"], spellProseBlockID)
				}
				if replace["newKind"] != "prose" {
					t.Errorf("replace-block newKind = %v, want prose", replace["newKind"])
				}
				attrs, _ := replace["attrs"].(map[string]interface{})
				if content, _ := attrs["content"].(string); content != tc.wantContent {
					t.Errorf("render-back content = %v, want %q", attrs["content"], tc.wantContent)
				}
			}

			ack := readUntil(t, c, protocol.TypeTextReplaceAck, 2*time.Second)
			if ack["opId"] != "op-tr" {
				t.Errorf("ack opId = %v, want op-tr", ack["opId"])
			}
			if ack["outcome"] != tc.wantOutcome {
				t.Errorf("ack outcome = %v, want %q", ack["outcome"], tc.wantOutcome)
			}
			_, hasErr := ack["error"]
			if hasErr != tc.wantError {
				t.Errorf("a %s ack carried error=%v, want an error field: %v", tc.wantOutcome, ack["error"], tc.wantError)
			}
			if tc.wantOutcome != protocol.TextReplaceOK {
				// Nothing changed, so nothing is echoed and nothing is reported on
				// the error frame — the outcome IS the report.
				expectNoMessage(t, c, `"`+protocol.TypeReplaceBlock+`"`, 300*time.Millisecond)
				expectNoMessage(t, c, `"`+protocol.TypeError+`"`, 100*time.Millisecond)
			}
			closeAndSettle(c)
		})
	}
}

// pushedLocator reads the locator off the engine's own marks push — the read
// lane handing the write lane an anchor, which is the only way one is ever made.
func pushedLocator(t *testing.T, c *websocket.Conn) string {
	t.Helper()
	frame := readUntil(t, c, protocol.TypeTextMarks, 3*time.Second)
	marks, _ := frame["marks"].([]interface{})
	if len(marks) == 0 {
		t.Fatalf("the marks push carried nothing to anchor on: %v", frame)
	}
	mark, _ := marks[0].(map[string]interface{})
	locator, _ := mark["locator"].(string)
	if locator == "" {
		t.Fatalf("the pushed mark carries no locator: %v", mark)
	}
	return locator
}
