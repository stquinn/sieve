package services

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestJobTracker_QueuedActiveFinishLifecycle(t *testing.T) {
	var events []string
	tr := NewJobTracker()
	tr.Broadcast = func(event, data string) { events = append(events, event) }

	tr.Enqueue(JobInfo{JobID: "j1", Label: "Refining…", Category: "ai"})
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
	for _, e := range events {
		if e != "jobs:changed" {
			t.Fatalf("new lifecycle must only emit jobs:changed, saw %q", e)
		}
	}
}

func TestJobTracker_QueuedPreservesInsertionOrder(t *testing.T) {
	tr := NewJobTracker()
	for _, id := range []string{"a", "b", "c"} {
		tr.Enqueue(JobInfo{JobID: id})
	}
	got := tr.Queued()
	if len(got) != 3 || got[0].JobID != "a" || got[1].JobID != "b" || got[2].JobID != "c" {
		t.Fatalf("Queued() not in insertion order: %+v", got)
	}
}

func TestJobTracker_ServeJobsShape(t *testing.T) {
	tr := NewJobTracker()
	tr.Enqueue(JobInfo{JobID: "q1"})
	tr.Enqueue(JobInfo{JobID: "a1"})
	tr.Activate("a1")

	rec := httptest.NewRecorder()
	tr.ServeJobs(rec, nil)
	var body struct {
		Active []JobInfo `json:"active"`
		Queued []JobInfo `json:"queued"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("ServeJobs body not JSON: %v", err)
	}
	if len(body.Active) != 1 || body.Active[0].JobID != "a1" {
		t.Fatalf("active=%+v", body.Active)
	}
	if len(body.Queued) != 1 || body.Queued[0].JobID != "q1" {
		t.Fatalf("queued=%+v", body.Queued)
	}
}
