package services

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"sieve/sieve/domain"
)

// helper: a Work fn that tracks peak concurrency within its category.
func concurrencyProbe(active *int32, peak *int32, hold time.Duration) func() (any, error) {
	return func() (any, error) {
		cur := atomic.AddInt32(active, 1)
		for {
			p := atomic.LoadInt32(peak)
			if cur <= p || atomic.CompareAndSwapInt32(peak, p, cur) {
				break
			}
		}
		time.Sleep(hold)
		atomic.AddInt32(active, -1)
		return "ok", nil
	}
}

func TestJobEngine_CapsConcurrencyPerCategory(t *testing.T) {
	tr := NewJobTracker()
	eng := NewJobEngine(map[string]int{"ai": 3}, 4, tr)

	var active, peak int32
	var wg sync.WaitGroup
	const n = 12
	wg.Add(n)
	for i := 0; i < n; i++ {
		probe := concurrencyProbe(&active, &peak, 30*time.Millisecond)
		eng.Submit(JobDescriptor{
			Category:   "ai",
			Meta:       domain.JobInfo{JobID: string(rune('a' + i))},
			Work:       probe,
			OnFinished: func(any) { wg.Done() },
			OnError:    func(error) { wg.Done() },
		})
	}
	wg.Wait()
	if peak > 3 {
		t.Fatalf("ai pool peak %d > limit 3", peak)
	}
	if peak < 2 {
		t.Fatalf("expected real parallelism (peak>=2), got %d", peak)
	}
}

func TestJobEngine_UnknownCategoryUsesDefault(t *testing.T) {
	eng := NewJobEngine(map[string]int{"ai": 1}, 2, NewJobTracker())
	var active, peak int32
	var wg sync.WaitGroup
	const n = 6
	wg.Add(n)
	for i := 0; i < n; i++ {
		probe := concurrencyProbe(&active, &peak, 30*time.Millisecond)
		eng.Submit(JobDescriptor{
			Category:   "exec", // not in sizes → default 2
			Meta:       domain.JobInfo{JobID: string(rune('a' + i))},
			Work:       probe,
			OnFinished: func(any) { wg.Done() },
			OnError:    func(error) { wg.Done() },
		})
	}
	wg.Wait()
	if peak > 2 || peak < 2 {
		t.Fatalf("default pool should cap at exactly 2, got peak %d", peak)
	}
}

func TestJobEngine_RunsEachJobOnceAndDrivesTracker(t *testing.T) {
	var mu sync.Mutex
	notifications := 0
	tr := NewJobTracker()
	tr.Notify = func() { mu.Lock(); notifications++; mu.Unlock() }
	eng := NewJobEngine(map[string]int{"ai": 2}, 2, tr)

	var ran int32
	var wg sync.WaitGroup
	wg.Add(5)
	for i := 0; i < 5; i++ {
		eng.Submit(JobDescriptor{
			Category:   "ai",
			Meta:       domain.JobInfo{JobID: string(rune('a' + i))},
			Work:       func() (any, error) { atomic.AddInt32(&ran, 1); return nil, nil },
			OnFinished: func(any) { wg.Done() },
		})
	}
	wg.Wait()
	if ran != 5 {
		t.Fatalf("expected 5 runs, got %d", ran)
	}
	// each job notifies at least on enqueue + activate + finish
	mu.Lock()
	defer mu.Unlock()
	if notifications < 5*3 {
		t.Fatalf("expected >=15 notifications, got %d", notifications)
	}
}

func TestJobEngine_PanicInWorkIsIsolated(t *testing.T) {
	eng := NewJobEngine(map[string]int{"ai": 1}, 1, NewJobTracker())
	done := make(chan struct{}, 2)

	eng.Submit(JobDescriptor{
		Category: "ai", Meta: domain.JobInfo{JobID: "boom"},
		Work:    func() (any, error) { panic("kaboom") },
		OnError: func(error) { done <- struct{}{} },
	})
	eng.Submit(JobDescriptor{
		Category: "ai", Meta: domain.JobInfo{JobID: "after"},
		Work:       func() (any, error) { return nil, nil },
		OnFinished: func(any) { done <- struct{}{} },
	})

	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("a panicking job killed the pool — second job never ran")
		}
	}
}
