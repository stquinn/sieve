package domain

// JobInfo describes one background job the UI can see: what the tab spinner and
// the jobs view render, and what the workspace wire's jobs-changed frame carries.
//
// It lives in the leaf because its producer and its consumers must not have to
// know each other: services.JobTracker mints one and the protocol contract puts
// it on the wire, and domain/ is the package both can name (same reason as Node
// and Candidate).
type JobInfo struct {
	JobID string `json:"jobId"`
	Label string `json:"label"`
	// DocID is the document the job belongs to, when it has one — a job dispatched
	// for a block or a whole document. Workspace-wide jobs leave it empty.
	DocID string `json:"docId,omitempty"`
	// SpinTab asks the tab bar to spin this job's document tab. Not every job is
	// worth a spinner, so it is a job property rather than a consequence of DocID.
	SpinTab bool `json:"spinTab"`
	// State is "queued" or "active".
	State string `json:"state,omitempty"`
	// Category is the worker pool the job runs on — opaque routing data.
	Category string `json:"category,omitempty"`
}
