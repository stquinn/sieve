package ink

import (
	"sync"

	"sieve/ident"
	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// SyncJobCategory is the category of every sync's job.
const SyncJobCategory = "ink-sync"

// syncKind is what a sync is: a catch-up, the refill of a rewind that found the log damaged, or a
// Resync.
type syncKind int

const (
	syncCatchUp syncKind = iota
	syncRepair
	syncResync
)

// label is what a sync of the note called name is shown as.
func (k syncKind) label(name string) string {
	if name == "" {
		name = "a notebook"
	}
	switch k {
	case syncRepair:
		return "Repairing " + name
	case syncResync:
		return "Resyncing " + name
	default:
		return "Syncing " + name
	}
}

// syncJobs are one session's syncs of its notes, each a job on a JobTracker of category
// SyncJobCategory that spins its note's tab: queued while the note waits for its HEAD, active with
// its progress, seq out of the HEAD's, while its records arrive, and gone when it is published, the
// tablet refuses it or the session ends. A note has at most one job. A nil syncJobs, or one with a
// nil tracker, does nothing. It is safe for concurrent use.
type syncJobs struct {
	tracker *services.JobTracker
	// describe is the container and name of a note; either "" while not known.
	describe func(note link.ID) (container, name string)

	mu   sync.Mutex
	jobs map[link.ID]*syncJob
}

// syncJob is one note's job as the tracker was last told it.
type syncJob struct {
	id        string
	kind      syncKind
	container string
	name      string
	active    bool
	head      uint32
	done      uint32
	// posted is the tracker holding the job, and shownActive its holding it as active.
	posted, shownActive bool
}

func newSyncJobs(tracker *services.JobTracker, describe func(note link.ID) (container, name string)) *syncJobs {
	return &syncJobs{tracker: tracker, describe: describe, jobs: map[link.ID]*syncJob{}}
}

// queue has note's sync of kind wait for its HEAD: a new job, or one already held queued again. A
// job held for a rewind keeps its kind.
func (j *syncJobs) queue(note link.ID, kind syncKind) {
	if j == nil || j.tracker == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	job := j.jobLocked(note, kind)
	if job.kind == syncCatchUp {
		job.kind = kind
	}
	job.active, job.head, job.done = false, 0, 0
	j.postLocked(job)
}

// begin is note's HEAD: the tablet holds it to head and the replica to have. A note behind has its
// job made active, made first when none was queued; a note not behind has none.
func (j *syncJobs) begin(note link.ID, head, have uint32) {
	if j == nil || j.tracker == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if head <= have {
		j.finishLocked(note)
		return
	}
	job := j.jobLocked(note, syncCatchUp)
	job.active, job.head, job.done = true, head, have
	j.postLocked(job)
}

// progress is the record at seq taken into note's replica, which is in container: an active job
// says how far it has got.
func (j *syncJobs) progress(note link.ID, seq uint32, container string) {
	if j == nil || j.tracker == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	job, ok := j.jobs[note]
	if !ok || !job.active {
		return
	}
	job.done = seq
	if job.container == "" && container != "" {
		job.container = container
		j.postLocked(job)
		return
	}
	j.tracker.Update(job.id, int(job.done), int(job.head))
}

// finish is note's sync over.
func (j *syncJobs) finish(note link.ID) {
	if j == nil || j.tracker == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.finishLocked(note)
}

// finishAll is every sync over: the session has ended.
func (j *syncJobs) finishAll() {
	if j == nil || j.tracker == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	for note := range j.jobs {
		j.finishLocked(note)
	}
}

// jobLocked is note's job, made of kind and described when there is none. j.mu is held.
func (j *syncJobs) jobLocked(note link.ID, kind syncKind) *syncJob {
	if job, ok := j.jobs[note]; ok {
		return job
	}
	job := &syncJob{id: ident.New(), kind: kind}
	job.container, job.name = j.describe(note)
	j.jobs[note] = job
	return job
}

// postLocked tells the tracker the job as it stands: queued afresh while it waits, and otherwise
// made active once, described and brought to its progress without leaving that state. j.mu is held.
func (j *syncJobs) postLocked(job *syncJob) {
	label := job.kind.label(job.name)
	if !job.posted || !job.active {
		j.tracker.Enqueue(domain.JobInfo{
			JobID: job.id, Label: label, DocID: job.container, SpinTab: true, Category: SyncJobCategory,
			Done: int(job.done), Total: int(job.head),
		})
		job.posted, job.shownActive = true, false
	} else {
		j.tracker.Update(job.id, int(job.done), int(job.head))
		j.tracker.Describe(job.id, label, job.container)
	}
	if job.active && !job.shownActive {
		j.tracker.Activate(job.id)
		job.shownActive = true
	}
}

// finishLocked takes note's job off the tracker. j.mu is held.
func (j *syncJobs) finishLocked(note link.ID) {
	if job, ok := j.jobs[note]; ok {
		delete(j.jobs, note)
		j.tracker.Finish(job.id)
	}
}
