package requesthandlers

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"sieve/sieve"
	"sieve/sieve/command"
	"sieve/sieve/services"
)

type fakeCmd struct {
	name  string
	build func(text string, ctx command.Context) (command.Job, error)
}

func (f *fakeCmd) Name() string        { return f.name }
func (f *fakeCmd) Description() string { return "fake command for ws test" }
func (f *fakeCmd) Family() string      { return command.FamilyAI }
func (f *fakeCmd) ResultKind() string  { return "ai-block" }
func (f *fakeCmd) Build(text string, ctx command.Context) (command.Job, error) {
	if f.build != nil {
		return f.build(text, ctx)
	}
	return command.Job{}, nil
}

func newWsTestServerWithCommands(t *testing.T) (*httptest.Server, *sieve.ServiceProvider, *WsHandler, string, chan struct{}) {
	t.Helper()
	srv, sp, h, uuid := newWsTestServer(t)

	reg := command.NewRegistry()
	tr := services.NewJobTracker()
	eng := services.NewJobEngine(map[string]int{command.Category: 2}, 1, tr)
	reg.SetEngine(eng)

	gate := make(chan struct{})
	reg.Register(&fakeCmd{
		name: "fake",
		build: func(text string, ctx command.Context) (command.Job, error) {
			pend := &command.Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "PENDING", "question": text}}
			return command.Job{
				Label:   "/fake " + text,
				Pending: pend,
				Work: func() (command.Block, error) {
					<-gate
					return command.Block{Kind: "ai-block", Attrs: map[string]interface{}{"status": "COMPLETE", "response": "answer:" + text}}, nil
				},
			}, nil
		},
	})
	sp.Commands = reg
	return srv, sp, h, uuid, gate
}

func TestWS_Command_PendingThenCompleteCorrelated(t *testing.T) {
	srv, _, _, _, gate := newWsTestServerWithCommands(t)
	conn := dialSessionWS(t, srv)
	defer conn.Close()

	cmdMsg := map[string]interface{}{
		"type":          "command",
		"family":        "ai",
		"cmd":           "fake",
		"args":          map[string]string{"text": "hi"},
		"correlationId": "c-1",
		"context":       map[string]interface{}{},
	}
	if err := conn.WriteJSON(cmdMsg); err != nil {
		t.Fatal(err)
	}

	pending := readFrame(t, conn, 2*time.Second)
	if pending["type"] != "command-result" || pending["correlationId"] != "c-1" || pending["status"] != "PENDING" {
		t.Fatalf("expected PENDING frame, got %+v", pending)
	}
	blk, _ := pending["block"].(map[string]interface{})
	if blk == nil || blk["kind"] != "ai-block" {
		t.Fatalf("expected block envelope in PENDING, got %+v", pending)
	}

	close(gate)

	complete := readFrame(t, conn, 2*time.Second)
	if complete["type"] != "command-result" || complete["correlationId"] != "c-1" || complete["status"] != "COMPLETE" {
		t.Fatalf("expected COMPLETE frame, got %+v", complete)
	}
	cBlk, _ := complete["block"].(map[string]interface{})
	attrs, _ := cBlk["attrs"].(map[string]interface{})
	if attrs["response"] != "answer:hi" {
		t.Fatalf("expected response answer:hi, got %+v", attrs)
	}
}

func TestWS_Command_ConcurrentCommandsRouteDisjointly(t *testing.T) {
	srv, _, _, _, gate := newWsTestServerWithCommands(t)
	conn := dialSessionWS(t, srv)
	defer conn.Close()

	cmd1 := map[string]interface{}{"type": "command", "family": "ai", "cmd": "fake", "args": map[string]string{"text": "first"}, "correlationId": "c-1"}
	cmd2 := map[string]interface{}{"type": "command", "family": "ai", "cmd": "fake", "args": map[string]string{"text": "second"}, "correlationId": "c-2"}

	if err := conn.WriteJSON(cmd1); err != nil {
		t.Fatal(err)
	}
	p1 := readFrame(t, conn, 2*time.Second)

	if err := conn.WriteJSON(cmd2); err != nil {
		t.Fatal(err)
	}
	p2 := readFrame(t, conn, 2*time.Second)

	if p1["correlationId"] != "c-1" || p2["correlationId"] != "c-2" {
		t.Fatalf("pending correlation mismatch: p1=%v p2=%v", p1, p2)
	}

	close(gate)

	// Collect two COMPLETE frames
	c1 := readFrame(t, conn, 2*time.Second)
	c2 := readFrame(t, conn, 2*time.Second)

	ids := map[string]bool{c1["correlationId"].(string): true, c2["correlationId"].(string): true}
	if !ids["c-1"] || !ids["c-2"] {
		t.Fatalf("expected c-1 and c-2 complete frames, got %v and %v", c1, c2)
	}
}

func TestWS_Command_DocChannelCloseDoesNotOrphan(t *testing.T) {
	srv, _, _, docUUID, gate := newWsTestServerWithCommands(t)
	docConn := dialWS(t, srv, docUUID)
	sessionConn := dialSessionWS(t, srv)
	defer sessionConn.Close()

	cmdMsg := map[string]interface{}{"type": "command", "family": "ai", "cmd": "fake", "args": map[string]string{"text": "orphan-test"}, "correlationId": "c-99"}
	if err := sessionConn.WriteJSON(cmdMsg); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, sessionConn, 2*time.Second) // PENDING

	// Close the doc socket
	closeAndSettle(docConn)

	// Release the job
	close(gate)

	// Complete should still arrive on session socket
	complete := readFrame(t, sessionConn, 2*time.Second)
	if complete["correlationId"] != "c-99" || complete["status"] != "COMPLETE" {
		t.Fatalf("session socket failed to receive complete after doc socket close: %+v", complete)
	}
}

func TestWS_Command_UnknownFamilyAndUnknownCmd(t *testing.T) {
	srv, _, _, _, _ := newWsTestServerWithCommands(t)
	conn := dialSessionWS(t, srv)
	defer conn.Close()

	badFamily := map[string]interface{}{"type": "command", "family": "unknown_fam", "cmd": "fake", "correlationId": "c-err1"}
	if err := conn.WriteJSON(badFamily); err != nil {
		t.Fatal(err)
	}
	res1 := readFrame(t, conn, 2*time.Second)
	if res1["status"] != "ERROR" || res1["correlationId"] != "c-err1" {
		t.Fatalf("expected ERROR frame for unknown family, got %+v", res1)
	}

	badCmd := map[string]interface{}{"type": "command", "family": "ai", "cmd": "nope", "correlationId": "c-err2"}
	if err := conn.WriteJSON(badCmd); err != nil {
		t.Fatal(err)
	}
	res2 := readFrame(t, conn, 2*time.Second)
	if res2["status"] != "ERROR" || res2["correlationId"] != "c-err2" {
		t.Fatalf("expected ERROR frame for unknown cmd, got %+v", res2)
	}
}

func TestWS_CommandCancel_SuppressesResult(t *testing.T) {
	srv, _, _, _, gate := newWsTestServerWithCommands(t)
	conn := dialSessionWS(t, srv)
	defer conn.Close()

	cmdMsg := map[string]interface{}{"type": "command", "family": "ai", "cmd": "fake", "args": map[string]string{"text": "cancel-me"}, "correlationId": "c-cancel"}
	if err := conn.WriteJSON(cmdMsg); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second) // PENDING

	cancelMsg := map[string]interface{}{"type": "command-cancel", "correlationId": "c-cancel"}
	if err := conn.WriteJSON(cancelMsg); err != nil {
		t.Fatal(err)
	}

	// Send ping and wait for pong to guarantee cancelMsg was processed by the server loop
	if err := conn.WriteJSON(map[string]string{"type": "ping"}); err != nil {
		t.Fatal(err)
	}
	_ = readUntil(t, conn, "pong", 2*time.Second)

	close(gate)

	// Expect no COMPLETE message
	_ = conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, raw, err := conn.ReadMessage()
	if err == nil {
		var m map[string]interface{}
		_ = json.Unmarshal(raw, &m)
		if m["correlationId"] == "c-cancel" && m["status"] == "COMPLETE" {
			t.Fatalf("expected cancelled result to be suppressed, but got %s", string(raw))
		}
	}
}
