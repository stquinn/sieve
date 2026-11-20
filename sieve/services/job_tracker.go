package services

import (
	"sync"
	"time"

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

	// progressEvery is the least time between two notifications of which an Update is the cause.
	progressEvery time.Duration
	now           func() time.Time
	// afterFunc calls f once d has passed.
	afterFunc func(d time.Duration, f func())
	// notified is when Notify was last called; trailing is a notification scheduled for an Update
	// that came too soon after it.
	notified time.Time
	trailing bool
}

// ProgressEvery is the least time between two notifications an Update causes.
const ProgressEvery = 250 * time.Millisecond

func NewJobTracker() *JobTracker {
	return &JobTracker{
		jobs: make(map[string]domain.JobInfo), progressEvery: ProgressEvery, now: time.Now,
		afterFunc: func(d time.Duration, f func()) { time.AfterFunc(d, f) },
	}
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

// Update sets how far the job jobID has got, done out of total; a total of 0 or less says
// nothing. It notifies at once when the last notification is ProgressEvery old, and otherwise
// once ProgressEvery after it, carrying the progress as it then stands; an Enqueue, Activate or
// Finish in between notifies at once as always. An unknown job, or progress unchanged, changes
// nothing.
func (t *JobTracker) Update(jobID string, done, total int) {
	if total <= 0 {
		done, total = 0, 0
	}
	t.mu.Lock()
	info, ok := t.jobs[jobID]
	if !ok || (info.Done == done && info.Total == total) {
		t.mu.Unlock()
		return
	}
	info.Done, info.Total = done, total
	t.jobs[jobID] = info
	now := t.now()
	since := now.Sub(t.notified)
	if since >= t.progressEvery {
		t.notified = now
		t.mu.Unlock()
		t.notify()
		return
	}
	schedule := !t.trailing
	t.trailing = true
	t.mu.Unlock()
	if schedule {
		t.afterFunc(t.progressEvery-since, t.notifyTrailing)
	}
}

// Describe sets what the job jobID is called and the document it belongs to, leaving its state and
// progress as they are, and notifies. An unknown job, or one already so described, changes nothing.
func (t *JobTracker) Describe(jobID, label, docID string) {
	t.mu.Lock()
	info, ok := t.jobs[jobID]
	if !ok || (info.Label == label && info.DocID == docID) {
		t.mu.Unlock()
		return
	}
	info.Label, info.DocID = label, docID
	t.jobs[jobID] = info
	t.mu.Unlock()
	t.notifyChanged()
}

// notifyTrailing is the notification an Update scheduled.
func (t *JobTracker) notifyTrailing() {
	t.mu.Lock()
	t.trailing = false
	t.notified = t.now()
	t.mu.Unlock()
	t.notify()
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
	t.mu.Lock()
	t.notified = t.now()
	t.mu.Unlock()
	t.notify()
}

func (t *JobTracker) notify() {
	if t.Notify != nil {
		t.Notify()
	}
}
