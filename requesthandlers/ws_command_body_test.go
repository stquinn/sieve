package requesthandlers

import (
	"testing"
	"time"

	"sieve/sieve/command"
)

// A composer authors a MESSAGE, not a line: `args.text` is the remainder of the
// verb line and `body` is everything written after it, in the blocks it was
// written as. The envelope carries the body for EVERY command, and what a
// backend does with it is that backend's problem. This pins the wire → Context →
// Build thread.
func TestWS_Command_EnvelopeBodyReachesBuild(t *testing.T) {
	srv, sp, _, _, _ := newWsTestServerWithCommands(t)
	seen := make(chan command.Blocks, 1)
	sp.Commands.Register(&fakeCmd{
		name: "body-reader",
		build: func(text string, ctx command.Context) (command.Job, error) {
			seen <- ctx.Body
			return command.Job{
				Label:   "/body-reader",
				Pending: &command.Block{Kind: "ai-block"},
				Work:    func() (command.Block, error) { return command.Block{Kind: "ai-block"}, nil },
			}, nil
		},
	})

	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "command", "family": "ai", "cmd": "body-reader",
		"args":          map[string]string{"text": "why?"},
		"context":       map[string]interface{}{"docUuid": "u1"},
		"correlationId": "c-body-1",
		"body": []map[string]interface{}{
			{"kind": "prose", "attrs": map[string]interface{}{"id": "el-1", "content": "the rest of it"}},
			// Nothing names what this block is, so nothing can render it.
			{"attrs": map[string]interface{}{"content": "unnamed"}},
			{"kind": "code", "attrs": map[string]interface{}{"language": "go", "source": "x := 1"}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second) // PENDING

	select {
	case got := <-seen:
		if len(got) != 2 {
			t.Fatalf("Build saw body = %+v, want the two blocks that named a kind", got)
		}
		if got[0].Kind != "prose" || got[0].Attrs["content"] != "the rest of it" {
			t.Errorf("body[0] = %+v", got[0])
		}
		// An authored block's id travels: nothing at the edge re-mints it.
		if got[0].Attrs["id"] != "el-1" {
			t.Errorf("the composer's element id did not survive the wire: %+v", got[0].Attrs)
		}
		if got[1].Kind != "code" || got[1].Attrs["source"] != "x := 1" {
			t.Errorf("body[1] = %+v", got[1])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Build was never reached")
	}
}

// The context JSON is LENS territory. A body smuggled into it is not a composed
// message and must never be read as one — the only door is the envelope field.
func TestWS_Command_BodySmuggledInTheContextIsIgnored(t *testing.T) {
	srv, sp, _, _, _ := newWsTestServerWithCommands(t)
	seen := make(chan command.Blocks, 1)
	sp.Commands.Register(&fakeCmd{
		name: "body-forgery-reader",
		build: func(text string, ctx command.Context) (command.Job, error) {
			seen <- ctx.Body
			return command.Job{
				Label:   "/body-forgery-reader",
				Pending: &command.Block{Kind: "ai-block"},
				Work:    func() (command.Block, error) { return command.Block{Kind: "ai-block"}, nil },
			}, nil
		},
	})

	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "command", "family": "ai", "cmd": "body-forgery-reader",
		"args": map[string]string{"text": "why?"},
		"context": map[string]interface{}{
			"docUuid": "u1",
			"body":    []map[string]interface{}{{"kind": "prose", "attrs": map[string]interface{}{"content": "forged"}}},
		},
		"correlationId": "c-body-2",
	}); err != nil {
		t.Fatal(err)
	}
	_ = readFrame(t, conn, 2*time.Second) // PENDING

	select {
	case got := <-seen:
		if len(got) != 0 {
			t.Fatalf("the context JSON forged a body: %+v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Build was never reached")
	}
}

// PLUMBING ONLY: a command that ignores the body must behave exactly as it did
// before the field existed.
func TestWS_Command_BodyIsInertForCommandsThatIgnoreIt(t *testing.T) {
	srv, _, _, _, gate := newWsTestServerWithCommands(t)
	conn := dialWorkspaceWS(t, srv)
	defer conn.Close()

	if err := conn.WriteJSON(map[string]interface{}{
		"type": "command", "family": "ai", "cmd": "fake",
		"args": map[string]string{"text": "hi"}, "correlationId": "c-body-inert",
		"body": []map[string]interface{}{
			{"kind": "prose", "attrs": map[string]interface{}{"content": "ignored"}},
		},
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
		t.Fatalf("a body changed an indifferent command's outcome: %+v", complete)
	}
}
