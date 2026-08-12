package requesthandlers

import (
	"testing"
	"time"

	"sieve/sieve/command"
	"sieve/sieve/domain"
)

// `@` is a COMPOSER affordance and the composer is the same textarea that
// dispatches `/` commands — so the envelope carries attachments for EVERY
// command, and what a backend does with them is that backend's problem. This
// pins the wire → Context → Build thread.
func TestWS_Command_EnvelopeAttachmentsReachBuild(t *testing.T) {
	srv, sp, _, _, _ := newWsTestServerWithCommands(t)
	seen := make(chan []domain.Attachment, 1)
	sp.Commands.Register(&fakeCmd{
		name: "attach-reader",
		build: func(text string, ctx command.Context) (command.Job, error) {
			seen <- ctx.Attachments
			return command.Job{
				Label:   "/attach-reader",
				Pending: &command.Block{Kind: "ai-block"},
				Work:    func() (command.Block, error) { return command.Block{Kind: "ai-block"}, nil },
			}, nil
		},
	})

	conn := dialSessionWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "command", "family": "ai", "cmd": "attach-reader",
		"args":          map[string]string{"text": "… @Auth Design …"},
		"context":       map[string]interface{}{"docUuid": "u1"},
		"correlationId": "c-att-1",
		"attachments": []map[string]string{
			{"uri": "container:9f2b", "title": "Auth Design"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second) // PENDING

	select {
	case got := <-seen:
		if len(got) != 1 || got[0].URI != "container:9f2b" || got[0].Title != "Auth Design" {
			t.Fatalf("Build saw attachments = %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Build was never reached")
	}
}

// PLUMBING ONLY: a command that ignores attachments must behave exactly as it
// did before the field existed.
func TestWS_Command_AttachmentsAreInertForCommandsThatIgnoreThem(t *testing.T) {
	srv, _, _, _, gate := newWsTestServerWithCommands(t)
	conn := dialSessionWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "command", "family": "ai", "cmd": "fake",
		"args": map[string]string{"text": "hi"}, "correlationId": "c-inert",
		"attachments": []map[string]string{{"uri": "container:9f2b", "title": "Auth Design"}},
	}); err != nil {
		t.Fatal(err)
	}
	pending := readFrame(t, conn, 2*time.Second)
	if pending["status"] != "PENDING" {
		t.Fatalf("want PENDING, got %+v", pending)
	}
	close(gate)

	complete := readFrame(t, conn, 2*time.Second)
	blk, _ := complete["block"].(map[string]interface{})
	attrs, _ := blk["attrs"].(map[string]interface{})
	if complete["status"] != "COMPLETE" || attrs["response"] != "answer:hi" {
		t.Fatalf("attachments changed an indifferent command's outcome: %+v", complete)
	}
}
