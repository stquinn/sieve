package requesthandlers

import (
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sieve/sieve/domain"
	"sieve/sieve/protocol"
	"sieve/sieve/services"
)

// A broadcast reaches EVERY connected workspace socket — the app window and any
// dev-server tab beside it — and no document socket, which speaks a different
// vocabulary and would refuse the word anyway.
func TestWorkspaceBroadcast_ReachesEveryWorkspaceSocketOnly(t *testing.T) {
	srv, _, h, uuid := newWsTestServer(t)

	workspaces := []*websocket.Conn{}
	for i := 0; i < 3; i++ {
		c := dialWorkspaceWS(t, srv)
		defer c.Close()
		workspaces = append(workspaces, c)
	}
	doc := dialWS(t, srv, uuid)
	defer doc.Close()

	h.broadcast.Invalidate(protocol.TopicNotes)

	for i, c := range workspaces {
		got := readUntil(t, c, protocol.TypeInvalidate, 2*time.Second)
		if got["topic"] != string(protocol.TopicNotes) {
			t.Errorf("workspace socket %d got topic %v, want notes", i, got["topic"])
		}
	}
	expectNoMessage(t, doc, protocol.TypeInvalidate, 300*time.Millisecond)
}

// A socket that dies leaves the fan-out set, and its departure costs the
// survivors nothing: a broadcast after it must still reach them.
func TestWorkspaceBroadcast_ADeadSocketLeavesTheSurvivorsAlone(t *testing.T) {
	srv, _, h, _ := newWsTestServer(t)

	dying := dialWorkspaceWS(t, srv)
	survivor := dialWorkspaceWS(t, srv)
	defer survivor.Close()

	if got, want := h.broadcast.size(), 2; got != want {
		t.Fatalf("fan-out membership before the close = %d, want %d", got, want)
	}

	closeAndSettle(dying)
	// Pin that leave() actually ran and shrank the set — without this, a
	// no-op leave() would still pass the read below on the survivor alone.
	if got, want := h.broadcast.size(), 1; got != want {
		t.Fatalf("fan-out membership after the dead socket settled = %d, want %d (leave() did not remove it)", got, want)
	}
	h.broadcast.Invalidate(protocol.TopicLibrary)

	got := readUntil(t, survivor, protocol.TypeInvalidate, 2*time.Second)
	if got["topic"] != string(protocol.TopicLibrary) {
		t.Errorf("survivor got topic %v, want library", got["topic"])
	}
}

// Nothing polls for the job snapshot, so a workspace socket is handed one the
// moment it connects — otherwise a client that connected after the last job
// event would show an empty status bar until the next one.
func TestWorkspaceConnect_PushesTheCurrentJobsSnapshot(t *testing.T) {
	tracker := services.NewJobTracker()
	tracker.Enqueue(domain.JobInfo{JobID: "j-queued", Label: "Waiting…", Category: "ai"})
	tracker.Enqueue(domain.JobInfo{JobID: "j-active", Label: "Refining…", Category: "ai"})
	tracker.Activate("j-active")
	srv, _, _, _ := newWsTestServerWithJobs(t, 0, tracker)

	c := dialWorkspaceWSRaw(t, srv)
	defer c.Close()

	first := readFrame(t, c, 2*time.Second)
	if first["type"] != protocol.TypeJobsChanged {
		t.Fatalf("first frame on a fresh workspace socket = %v, want jobs-changed", first["type"])
	}
	active, _ := first["active"].([]interface{})
	queued, _ := first["queued"].([]interface{})
	if len(active) != 1 || len(queued) != 1 {
		t.Fatalf("snapshot = %v active, %v queued; want one of each", active, queued)
	}
	if job, _ := active[0].(map[string]interface{}); job["jobId"] != "j-active" {
		t.Errorf("active job = %v, want j-active", active[0])
	}
}

// The tracker's notification is the whole seam: it keeps the state, the wire
// composes the frame. Every workspace socket hears the result.
func TestJobsChanged_BroadcastsTheSnapshotOnEveryTransition(t *testing.T) {
	tracker := services.NewJobTracker()
	srv, _, h, _ := newWsTestServerWithJobs(t, 0, tracker)
	tracker.Notify = h.broadcast.PushJobs

	c := dialWorkspaceWS(t, srv)
	defer c.Close()

	tracker.Enqueue(domain.JobInfo{JobID: "j1", Label: "Refining…", Category: "ai"})

	got := readUntil(t, c, protocol.TypeJobsChanged, 2*time.Second)
	queued, _ := got["queued"].([]interface{})
	if len(queued) != 1 {
		t.Fatalf("queued = %v, want the one job just enqueued", got["queued"])
	}
}
