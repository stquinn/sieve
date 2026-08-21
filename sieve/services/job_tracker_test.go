package services

import (
	"testing"

	"sieve/sieve/domain"
)

func TestJobTracker_QueuedActiveFinishLifecycle(t *testing.T) {
	notifications := 0
	tr := NewJobTracker()
	tr.Notify = func() { notifications++ }

	tr.Enqueue(domain.JobInfo{JobID: "j1", Label: "Refining…", Category: "ai"})
	if got := tr.Queued(); len(got) != 1 || got[0].JobID != "j1" || got[0].State != "queued" {
		t.Fatalf("after Enqueue, Queued()=%+v", got)
	}
	if got := tr.Active(); len(got) != 0 {
		t.Fatalf("after Enqueue, Active() should be empty, got %+v", got)
	}

	tr.Activate("j1")
	if got := tr.Queued(); len(got) != 0 {
		t.Fatalf("after Activate, Queued() should be empty, got %+v", got)
	}
	if got := tr.Active(); len(got) != 1 || got[0].State != "active" {
		t.Fatalf("after Activate, Active()=%+v", got)
	}

	tr.Finish("j1")
	if len(tr.Active()) != 0 || len(tr.Queued()) != 0 {
		t.Fatalf("after Finish, both lists should be empty")
	}
	// Every transition notifies: the snapshot is pushed, never polled, so a
	// transition nobody hears about is one the status bar never shows.
	if notifications != 3 {
		t.Fatalf("enqueue+activate+finish notified %d times, want 3", notifications)
	}
}

func TestJobTracker_QueuedPreservesInsertionOrder(t *testing.T) {
	tr := NewJobTracker()
	for _, id := range []string{"a", "b", "c"} {
		tr.Enqueue(domain.JobInfo{JobID: id})
	}
	got := tr.Queued()
	if len(got) != 3 || got[0].JobID != "a" || got[1].JobID != "b" || got[2].JobID != "c" {
		t.Fatalf("Queued() not in insertion order: %+v", got)
	}
}

// The snapshot is what the workspace push carries: every active job and every
// queued one, each in insertion order.
func TestJobTracker_SnapshotShape(t *testing.T) {
	tr := NewJobTracker()
	tr.Enqueue(domain.JobInfo{JobID: "q1"})
	tr.Enqueue(domain.JobInfo{JobID: "a1"})
	tr.Activate("a1")

	active, queued := tr.Active(), tr.Queued()
	if len(active) != 1 || active[0].JobID != "a1" {
		t.Fatalf("active=%+v", active)
	}
	if len(queued) != 1 || queued[0].JobID != "q1" {
		t.Fatalf("queued=%+v", queued)
	}
}
