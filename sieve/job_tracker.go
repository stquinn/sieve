package sieve

import (
	"encoding/json"
	"net/http"
	"sync"
)

// JobInfo is the payload for ai:job-started SSE events and GET /api/ai/active-jobs.
type JobInfo struct {
	JobID   string `json:"jobId"`
	Label   string `json:"label"`
	DocID   string `json:"docId,omitempty"`
	SpinTab bool   `json:"spinTab"`
}

// JobTracker is a thread-safe registry of in-flight AI jobs.
type JobTracker struct {
	Broadcast func(event, data string)
	mu        sync.RWMutex
	jobs      map[string]JobInfo
}

func NewJobTracker() *JobTracker {
	return &JobTracker{jobs: make(map[string]JobInfo)}
}

func (t *JobTracker) Start(info JobInfo) {
	t.mu.Lock()
	t.jobs[info.JobID] = info
	t.mu.Unlock()

	if t.Broadcast != nil {
		data, _ := json.Marshal(info)
		t.Broadcast("ai:job-started", string(data))
	}
}

func (t *JobTracker) End(jobID string) {
	t.mu.Lock()
	info, exists := t.jobs[jobID]
	if exists {
		delete(t.jobs, jobID)
	}
	t.mu.Unlock()

	if exists && t.Broadcast != nil {
		data, _ := json.Marshal(map[string]string{"jobId": jobID, "docId": info.DocID})
		t.Broadcast("ai:job-ended", string(data))
	}
}

func (t *JobTracker) Active() []JobInfo {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([]JobInfo, 0, len(t.jobs))
	for _, j := range t.jobs {
		out = append(out, j)
	}
	return out
}

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
