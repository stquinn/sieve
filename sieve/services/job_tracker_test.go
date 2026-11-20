package services

import (
	"testing"
	"time"

	"sieve/sieve/domain"
)

func TestJobTracker_QueuedActiveFinishLifecycle(t *testing.T) {
	notifications := 0
	tr := NewJobTracker()
	tr.Notify = func() { notifications++ }

	tr.Enqueue(domain.JobInfo{JobID: "j1", Label: "Refining…", Category: "ai"})
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
	// Every transition notifies: the snapshot is pushed, never polled, so a
	// transition nobody hears about is one the status bar never shows.
	if notifications != 3 {
		t.Fatalf("enqueue+activate+finish notified %d times, want 3", notifications)
	}
}

func TestJobTracker_QueuedPreservesInsertionOrder(t *testing.T) {
	tr := NewJobTracker()
	for _, id := range []string{"a", "b", "c"} {
		tr.Enqueue(domain.JobInfo{JobID: id})
	}
	got := tr.Queued()
	if len(got) != 3 || got[0].JobID != "a" || got[1].JobID != "b" || got[2].JobID != "c" {
		t.Fatalf("Queued() not in insertion order: %+v", got)
	}
}

// The snapshot is what the workspace push carries: every active job and every
// queued one, each in insertion order.
func TestJobTracker_SnapshotShape(t *testing.T) {
	tr := NewJobTracker()
	tr.Enqueue(domain.JobInfo{JobID: "q1"})
	tr.Enqueue(domain.JobInfo{JobID: "a1"})
	tr.Activate("a1")

	active, queued := tr.Active(), tr.Queued()
	if len(active) != 1 || active[0].JobID != "a1" {
		t.Fatalf("active=%+v", active)
	}
	if len(queued) != 1 || queued[0].JobID != "q1" {
		t.Fatalf("queued=%+v", queued)
	}
}

// fakeProgressClock is a JobTracker's clock and timer, moved by hand.
type fakeProgressClock struct {
	at    time.Time
	waits []time.Duration
	fires []func()
}

func (c *fakeProgressClock) install(t *JobTracker) {
	t.now = func() time.Time { return c.at }
	t.afterFunc = func(d time.Duration, f func()) { c.waits, c.fires = append(c.waits, d), append(c.fires, f) }
}

func (c *fakeProgressClock) fire() {
	fires := c.fires
	c.fires = nil
	for _, f := range fires {
		f()
	}
}

func TestJobTracker_Update(t *testing.T) {
	type step struct {
		advance     time.Duration
		done, total int
		fire        bool
		finish      bool
	}
	cases := []struct {
		name      string
		steps     []step
		notified  int // after Enqueue+Activate
		scheduled []time.Duration
		done      int
		total     int
	}{
		{"an update ProgressEvery after the last notification notifies at once",
			[]step{{advance: ProgressEvery, done: 1, total: 10}}, 1, nil, 1, 10},
		{"updates sooner are carried by one later notification",
			[]step{{advance: 100 * time.Millisecond, done: 1, total: 10}, {advance: 50 * time.Millisecond, done: 2, total: 10},
				{advance: 10 * time.Millisecond, done: 3, total: 10, fire: true}}, 1, []time.Duration{150 * time.Millisecond}, 3, 10},
		{"unchanged progress notifies nothing", []step{{advance: time.Second, done: 0, total: 0}}, 0, nil, 0, 0},
		{"a total of 0 says nothing of done", []step{{advance: time.Second, done: 4, total: 0}}, 0, nil, 0, 0},
		{"a finish after a held update notifies at once", []step{{advance: 10 * time.Millisecond, done: 5, total: 9, finish: true}}, 1, []time.Duration{240 * time.Millisecond}, 0, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tr := NewJobTracker()
			clock := &fakeProgressClock{at: time.Unix(1000, 0)}
			clock.install(tr)
			tr.Enqueue(domain.JobInfo{JobID: "j"})
			tr.Activate("j")
			notifications := 0
			tr.Notify = func() { notifications++ }
			for _, s := range tc.steps {
				clock.at = clock.at.Add(s.advance)
				tr.Update("j", s.done, s.total)
				if s.finish {
					tr.Finish("j")
				}
				if s.fire {
					clock.fire()
				}
			}
			if notifications != tc.notified {
				t.Fatalf("notified %d times, want %d", notifications, tc.notified)
			}
			if len(clock.waits) != len(tc.scheduled) || (len(tc.scheduled) > 0 && clock.waits[0] != tc.scheduled[0]) {
				t.Fatalf("scheduled %v, want %v", clock.waits, tc.scheduled)
			}
			var got domain.JobInfo
			if active := tr.Active(); len(active) == 1 {
				got = active[0]
			}
			if got.Done != tc.done || got.Total != tc.total {
				t.Fatalf("progress %d / %d, want %d / %d", got.Done, got.Total, tc.done, tc.total)
			}
		})
	}
}

func TestJobTracker_DescribeKeepsStateAndProgress(t *testing.T) {
	tr := NewJobTracker()
	tr.Enqueue(domain.JobInfo{JobID: "j", Label: "Syncing a notebook"})
	tr.Activate("j")
	tr.Update("j", 3, 9)
	notified := 0
	tr.Notify = func() { notified++ }
	tr.Describe("j", "Syncing Ideas", "doc-1")
	tr.Describe("j", "Syncing Ideas", "doc-1")
	tr.Describe("nobody", "x", "y")
	active := tr.Active()
	if notified != 1 || len(active) != 1 || len(tr.Queued()) != 0 {
		t.Fatalf("notified %d, active %v, queued %v", notified, active, tr.Queued())
	}
	if j := active[0]; j.Label != "Syncing Ideas" || j.DocID != "doc-1" || j.Done != 3 || j.Total != 9 {
		t.Errorf("described job is %+v", j)
	}
}

func TestJobTracker_UpdateOfAnUnknownJobChangesNothing(t *testing.T) {
	tr := NewJobTracker()
	notified := 0
	tr.Notify = func() { notified++ }
	tr.Update("nobody", 1, 2)
	if notified != 0 || len(tr.Active())+len(tr.Queued()) != 0 {
		t.Fatalf("notified %d, jobs %v %v", notified, tr.Active(), tr.Queued())
	}
}
