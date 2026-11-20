package ink

import (
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"sieve/sieve/domain"
	"sieve/sieve/ink/link"
	"sieve/sieve/services"
)

// jobRecorder is a JobTracker whose every notification is written down as the jobs then stand,
// one line per job: its state, label, container and progress.
type jobRecorder struct {
	tracker *services.JobTracker

	mu    sync.Mutex
	shown [][]string
}

func newJobRecorder() *jobRecorder {
	r := &jobRecorder{tracker: services.NewJobTracker()}
	r.tracker.Notify = func() {
		var lines []string
		for _, j := range append(r.tracker.Active(), r.tracker.Queued()...) {
			lines = append(lines, r.line(j))
		}
		r.mu.Lock()
		r.shown = append(r.shown, lines)
		r.mu.Unlock()
	}
	return r
}

func (r *jobRecorder) line(j domain.JobInfo) string {
	line := fmt.Sprintf("%s %s", j.State, j.Label)
	if j.DocID != "" {
		line += " in " + j.DocID
	}
	if j.Total > 0 {
		line += fmt.Sprintf(" %d/%d", j.Done, j.Total)
	}
	if j.Category != SyncJobCategory || !j.SpinTab {
		line += " (not a sync)"
	}
	return line
}

// seen reports whether the jobs ever stood as want, in some order.
func (r *jobRecorder) seen(want ...string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, lines := range r.shown {
		if len(lines) == len(want) && !slices.ContainsFunc(want, func(w string) bool { return !slices.Contains(lines, w) }) {
			return true
		}
	}
	return false
}

// seenLine reports whether any job ever stood as a line that starts with prefix and holds every
// one of parts.
func (r *jobRecorder) seenLine(prefix string, parts ...string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, lines := range r.shown {
		for _, line := range lines {
			if strings.HasPrefix(line, prefix) && !slices.ContainsFunc(parts, func(p string) bool { return !strings.Contains(line, p) }) {
				return true
			}
		}
	}
	return false
}

// open is the jobs held now, as lines.
func (r *jobRecorder) open() []string {
	var lines []string
	for _, j := range append(r.tracker.Active(), r.tracker.Queued()...) {
		lines = append(lines, r.line(j))
	}
	return lines
}

func TestSyncJobs_FollowANotesSyncFromQueueToEnd(t *testing.T) {
	a, b := link.ID{1}, link.ID{2}
	type step func(j *syncJobs)
	cases := []struct {
		name  string
		steps []step
		seen  [][]string
		open  []string
	}{
		{"a listed catch-up is queued, active with its progress at its HEAD, and gone at publish",
			[]step{
				func(j *syncJobs) { j.queue(a, syncCatchUp) },
				func(j *syncJobs) { j.begin(a, 10, 4) },
				func(j *syncJobs) { j.progress(a, 5, "box-a") },
				func(j *syncJobs) { j.finish(a) },
			},
			[][]string{{"queued Syncing Alpha"}, {"active Syncing Alpha 4/10"}, {"active Syncing Alpha in box-a 5/10"}, {}},
			nil},
		{"a live note behind has a job at its HEAD though it was never queued, named once its container is known",
			[]step{
				func(j *syncJobs) { j.begin(b, 3, 0) },
				func(j *syncJobs) { j.progress(b, 1, "box-b") },
			},
			[][]string{{"active Syncing a notebook 0/3"}, {"active Syncing a notebook in box-b 1/3"}},
			[]string{"active Syncing a notebook in box-b 1/3"}},
		{"a HEAD not past the cursor makes no job and ends a queued one",
			[]step{
				func(j *syncJobs) { j.begin(b, 3, 3) },
				func(j *syncJobs) { j.queue(a, syncCatchUp) },
				func(j *syncJobs) { j.begin(a, 4, 4) },
			},
			[][]string{{"queued Syncing Alpha"}, {}},
			nil},
		{"a rewind's refill is a repair, queued again until its HEAD, and keeps its kind through a second rewind",
			[]step{
				func(j *syncJobs) { j.queue(a, syncCatchUp) },
				func(j *syncJobs) { j.begin(a, 10, 0) },
				func(j *syncJobs) { j.queue(a, syncRepair) },
				func(j *syncJobs) { j.queue(a, syncResync) },
				func(j *syncJobs) { j.begin(a, 10, 6) },
			},
			[][]string{{"queued Repairing Alpha"}, {"active Repairing Alpha 6/10"}},
			[]string{"active Repairing Alpha 6/10"}},
		{"a Resync is its own job",
			[]step{
				func(j *syncJobs) { j.queue(a, syncResync) },
				func(j *syncJobs) { j.begin(a, 7, 0) },
			},
			[][]string{{"queued Resyncing Alpha"}, {"active Resyncing Alpha 0/7"}},
			[]string{"active Resyncing Alpha 0/7"}},
		{"a progress of a job not active says nothing",
			[]step{
				func(j *syncJobs) { j.queue(a, syncCatchUp) },
				func(j *syncJobs) { j.progress(a, 2, "box-a") },
			},
			[][]string{{"queued Syncing Alpha"}},
			[]string{"queued Syncing Alpha"}},
		{"the session ending finishes every job",
			[]step{
				func(j *syncJobs) { j.queue(a, syncCatchUp) },
				func(j *syncJobs) { j.queue(b, syncCatchUp) },
				func(j *syncJobs) { j.begin(a, 10, 2) },
				func(j *syncJobs) { j.finishAll() },
			},
			[][]string{{"active Syncing Alpha 2/10", "queued Syncing a notebook"}, {}},
			nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := newJobRecorder()
			jobs := newSyncJobs(rec.tracker, func(note link.ID) (string, string) {
				if note == a {
					return "", "Alpha"
				}
				return "", ""
			})
			for _, s := range tc.steps {
				s(jobs)
			}
			for _, want := range tc.seen {
				if !rec.seen(want...) {
					t.Errorf("jobs never stood as %q; shown %q", want, rec.shown)
				}
			}
			if got := rec.open(); !slices.Equal(got, tc.open) {
				t.Errorf("open jobs %q, want %q", got, tc.open)
			}
		})
	}
}

func TestSyncJobs_WithNoTrackerDoNothing(t *testing.T) {
	jobs := newSyncJobs(nil, func(link.ID) (string, string) { t.Fatal("described"); return "", "" })
	jobs.queue(link.ID{1}, syncCatchUp)
	jobs.begin(link.ID{1}, 3, 0)
	jobs.progress(link.ID{1}, 1, "c")
	jobs.finish(link.ID{1})
	jobs.finishAll()
}

func TestSyncJobs_AJobToldItsContainerIsNeverShownQueuedAgain(t *testing.T) {
	a := link.ID{1}
	rec := newJobRecorder()
	jobs := newSyncJobs(rec.tracker, func(link.ID) (string, string) { return "", "Alpha" })
	jobs.queue(a, syncCatchUp)
	jobs.begin(a, 10, 0)
	jobs.progress(a, 1, "box-a")
	if !rec.seen("active Syncing Alpha in box-a 1/10") {
		t.Fatalf("the job never showed its container: %q", rec.shown)
	}
	for _, lines := range rec.shown {
		for _, line := range lines {
			if strings.HasPrefix(line, "queued ") && strings.Contains(line, "box-a") {
				t.Errorf("an active job was shown queued when its container became known: %q", rec.shown)
			}
		}
	}
}
