package services

import (
	"sync"

	"sieve/sieve/domain"
)

// JobTracker is a thread-safe registry of in-flight AI jobs.
type JobTracker struct {
	// Notify is called after every transition. It is a bare notification rather
	// than a payload because the frame this becomes is a protocol/ type, and
	// protocol/ sits ABOVE this package in the import DAG: the tracker keeps the
	// state, and whoever wires it reads Active()/Queued() to compose the push.
	Notify func()

	mu    sync.RWMutex
	jobs  map[string]domain.JobInfo
	order []string
}

func NewJobTracker() *JobTracker {
	return &JobTracker{jobs: make(map[string]domain.JobInfo)}
}

func (t *JobTracker) Active() []domain.JobInfo { return t.listByState("active") }

// Enqueue records a job as queued and notifies.
func (t *JobTracker) Enqueue(info domain.JobInfo) {
	info.State = "queued"
	t.mu.Lock()
	if _, exists := t.jobs[info.JobID]; !exists {
		t.order = append(t.order, info.JobID)
	}
	t.jobs[info.JobID] = info
	t.mu.Unlock()
	t.notifyChanged()
}

// Activate transitions a queued job to active and notifies.
func (t *JobTracker) Activate(jobID string) {
	t.mu.Lock()
	if info, ok := t.jobs[jobID]; ok {
		info.State = "active"
		t.jobs[jobID] = info
	}
	t.mu.Unlock()
	t.notifyChanged()
}

// Finish removes a job and notifies.
func (t *JobTracker) Finish(jobID string) {
	t.mu.Lock()
	if _, ok := t.jobs[jobID]; ok {
		delete(t.jobs, jobID)
		for i, id := range t.order {
			if id == jobID {
				t.order = append(t.order[:i], t.order[i+1:]...)
				break
			}
		}
	}
	t.mu.Unlock()
	t.notifyChanged()
}

// Queued returns insertion-ordered jobs with State=="queued".
func (t *JobTracker) Queued() []domain.JobInfo { return t.listByState("queued") }

func (t *JobTracker) listByState(state string) []domain.JobInfo {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []domain.JobInfo{}
	for _, id := range t.order {
		if j := t.jobs[id]; j.State == state {
			out = append(out, j)
		}
	}
	return out
}

func (t *JobTracker) notifyChanged() {
	if t.Notify != nil {
		t.Notify()
	}
}
