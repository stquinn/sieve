package requesthandlers

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestJobTracker_EmptyOnCreate(t *testing.T) {
	tracker := NewJobTracker()
	if got := tracker.Active(); len(got) != 0 {
		t.Errorf("expected 0 active jobs, got %d", len(got))
	}
}

func TestJobTracker_StartAddsJob(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Filing note...", DocID: "doc1", SpinTab: true})
	active := tracker.Active()
	if len(active) != 1 {
		t.Fatalf("expected 1 job, got %d", len(active))
	}
	if active[0].JobID != "j1" || active[0].Label != "Filing note..." {
		t.Errorf("unexpected job: %+v", active[0])
	}
}

func TestJobTracker_EndRemovesJob(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Asking AI...", DocID: "doc1", SpinTab: false})
	tracker.End("j1")
	if got := tracker.Active(); len(got) != 0 {
		t.Errorf("expected 0 active jobs after End, got %d", len(got))
	}
}

func TestJobTracker_EndUnknownIDIsNoop(t *testing.T) {
	tracker := NewJobTracker()
	tracker.End("nonexistent") // must not panic
}

func TestJobTracker_MultipleJobs(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Filing note...", DocID: "d1", SpinTab: true})
	tracker.Start(JobInfo{JobID: "j2", Label: "Asking AI...", DocID: "d2", SpinTab: false})
	if len(tracker.Active()) != 2 {
		t.Errorf("expected 2 jobs")
	}
	tracker.End("j1")
	if len(tracker.Active()) != 1 {
		t.Errorf("expected 1 job after removing j1")
	}
}

func TestJobTracker_ServeActiveJobs(t *testing.T) {
	tracker := NewJobTracker()
	tracker.Start(JobInfo{JobID: "j1", Label: "Explaining...", DocID: "doc1", SpinTab: false})

	req := httptest.NewRequest("GET", "/api/ai/active-jobs", nil)
	w := httptest.NewRecorder()
	tracker.ServeActiveJobs(w, req)

	if w.Code != 200 {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body struct {
		Jobs []JobInfo `json:"jobs"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Jobs) != 1 || body.Jobs[0].JobID != "j1" {
		t.Errorf("unexpected jobs: %+v", body.Jobs)
	}
}
