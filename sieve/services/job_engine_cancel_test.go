package services

import "testing"

func TestCancel_QueuedJobNeverRunsAndLeavesTracker(t *testing.T) {
	tr := NewJobTracker()
	e := NewJobEngine(map[string]int{"t": 1}, 1, tr)
	gate := make(chan struct{})
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j1", Label: "hold"},
		Work: func() (any, error) { <-gate; return nil, nil }})
	ran := false
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j2", Label: "victim"},
		Work: func() (any, error) { ran = true; return nil, nil },
		OnFinished: func(any) { ran = true }})
	e.Cancel("j2")
	close(gate)
	done := make(chan struct{})
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j3", Label: "sentinel"},
		OnFinished: func(any) { close(done) }})
	<-done
	if ran {
		t.Fatal("cancelled queued job ran or fired callbacks")
	}
	if len(tr.Queued())+len(tr.Active()) != 0 {
		t.Fatalf("cancelled job stuck in tracker: q=%v a=%v", tr.Queued(), tr.Active())
	}
}

func TestCancel_ActiveJobCallbacksSuppressed(t *testing.T) {
	tr := NewJobTracker()
	e := NewJobEngine(map[string]int{"t": 1}, 1, tr)
	started := make(chan struct{})
	release := make(chan struct{})
	fired := false
	finished := make(chan struct{})
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j1", Label: "x"},
		Work:       func() (any, error) { close(started); <-release; return "r", nil },
		OnFinished: func(any) { fired = true }})
	<-started
	e.Cancel("j1")
	close(release)
	e.Submit(JobDescriptor{Category: "t", Meta: JobInfo{JobID: "j2", Label: "sentinel"},
		OnFinished: func(any) { close(finished) }})
	<-finished
	if fired {
		t.Fatal("cancelled active job's OnFinished fired")
	}
}
