package services

import (
	"encoding/json"
	"net/http"
	"sync"
)

// JobInfo is the payload for ai:job-started SSE events and GET /api/ai/active-jobs.
type JobInfo struct {
	JobID    string `json:"jobId"`
	Label    string `json:"label"`
	DocID    string `json:"docId,omitempty"`
	SpinTab  bool   `json:"spinTab"`
	State    string `json:"state,omitempty"`    // "queued" | "active"
	Category string `json:"category,omitempty"`
}

// JobTracker is a thread-safe registry of in-flight AI jobs.
type JobTracker struct {
	Broadcast func(event, data string)
	mu        sync.RWMutex
	jobs      map[string]JobInfo
	order     []string
}

func NewJobTracker() *JobTracker {
	return &JobTracker{jobs: make(map[string]JobInfo)}
}

func (t *JobTracker) Start(info JobInfo) {
	info.State = "active"
	t.mu.Lock()
	if _, exists := t.jobs[info.JobID]; !exists {
		t.order = append(t.order, info.JobID)
	}
	t.jobs[info.JobID] = info
	t.mu.Unlock()

	if t.Broadcast != nil {
		data, _ := json.Marshal(info)
		t.Broadcast("ai:job-started", string(data)) // legacy event unchanged
	}
}

func (t *JobTracker) End(jobID string) {
	t.mu.Lock()
	info, exists := t.jobs[jobID]
	if exists {
		delete(t.jobs, jobID)
		for i, id := range t.order {
			if id == jobID {
				t.order = append(t.order[:i], t.order[i+1:]...)
				break
			}
		}
	}
	t.mu.Unlock()

	if exists && t.Broadcast != nil {
		data, _ := json.Marshal(map[string]string{"jobId": jobID, "docId": info.DocID})
		t.Broadcast("ai:job-ended", string(data))
	}
}

func (t *JobTracker) Active() []JobInfo { return t.listByState("active") }

// ServeActiveJobs handles GET /api/ai/active-jobs.
// Returns {"jobs": [...]} for the JS status bar to restore state after a tab switch.
func (t *JobTracker) ServeActiveJobs(w http.ResponseWriter, r *http.Request) {
	jobs := t.Active()
	if jobs == nil {
		jobs = []JobInfo{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string][]JobInfo{"jobs": jobs})
}

// Enqueue records a job as queued and broadcasts jobs:changed.
func (t *JobTracker) Enqueue(info JobInfo) {
	info.State = "queued"
	t.mu.Lock()
	if _, exists := t.jobs[info.JobID]; !exists {
		t.order = append(t.order, info.JobID)
	}
	t.jobs[info.JobID] = info
	t.mu.Unlock()
	t.broadcastJobs()
}

// Activate transitions a queued job to active and broadcasts jobs:changed.
func (t *JobTracker) Activate(jobID string) {
	t.mu.Lock()
	if info, ok := t.jobs[jobID]; ok {
		info.State = "active"
		t.jobs[jobID] = info
	}
	t.mu.Unlock()
	t.broadcastJobs()
}

// Finish removes a job and broadcasts jobs:changed.
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
	t.broadcastJobs()
}

// Queued returns insertion-ordered jobs with State=="queued".
func (t *JobTracker) Queued() []JobInfo { return t.listByState("queued") }

func (t *JobTracker) listByState(state string) []JobInfo {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := []JobInfo{}
	for _, id := range t.order {
		if j := t.jobs[id]; j.State == state {
			out = append(out, j)
		}
	}
	return out
}

func (t *JobTracker) broadcastJobs() {
	if t.Broadcast == nil {
		return
	}
	payload := map[string][]JobInfo{"active": t.listByState("active"), "queued": t.listByState("queued")}
	data, _ := json.Marshal(payload)
	t.Broadcast("jobs:changed", string(data))
}

// ServeJobs handles GET /api/jobs → {"active":[...],"queued":[...]}.
func (t *JobTracker) ServeJobs(w http.ResponseWriter, r *http.Request) {
	payload := map[string][]JobInfo{"active": t.listByState("active"), "queued": t.listByState("queued")}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}
