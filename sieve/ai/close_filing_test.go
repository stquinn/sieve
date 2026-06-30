package ai

import (
	"sync"
	"testing"
	"time"
)

// These tests pin the close-time filing fan-out — the single backend path both
// "Close Tab" and "Close All Tabs" route through. The regression they guard:
// close-all used to file ZERO docs (it never called the evaluator at all), while
// individual close filed the one doc. The fix routes every closed doc through one
// bounded-parallel runner; these tests prove (a) every doc is evaluated exactly
// once and (b) concurrency is capped so a large close-all can't spawn one CLI
// process per tab. fileOnClose is injected so no real AI/CLI runs.

func TestRunCloseFiling_evaluatesEveryClosedDoc(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]int{}
	svc := &AIService{closeFilingLimit: 3}
	svc.fileOnClose = func(id string) {
		mu.Lock()
		seen[id]++
		mu.Unlock()
	}

	ids := []string{"a", "b", "c", "d", "e", "f", "g"}
	svc.runCloseFiling(ids)

	if len(seen) != len(ids) {
		t.Fatalf("expected every closed doc evaluated, got %d of %d: %v", len(seen), len(ids), seen)
	}
	for _, id := range ids {
		if seen[id] != 1 {
			t.Fatalf("doc %q evaluated %d times, want exactly 1", id, seen[id])
		}
	}
}

func TestRunCloseFiling_capsConcurrentEvaluations(t *testing.T) {
	const limit = 3
	var mu sync.Mutex
	var active, peak int
	svc := &AIService{closeFilingLimit: limit}
	svc.fileOnClose = func(id string) {
		mu.Lock()
		active++
		if active > peak {
			peak = active
		}
		mu.Unlock()
		time.Sleep(30 * time.Millisecond) // hold the slot so overlap is observable
		mu.Lock()
		active--
		mu.Unlock()
	}

	ids := make([]string, 12)
	for i := range ids {
		ids[i] = string(rune('a' + i))
	}
	svc.runCloseFiling(ids)

	if peak > limit {
		t.Fatalf("concurrency cap exceeded: peak %d > limit %d", peak, limit)
	}
	if peak < 2 {
		t.Fatalf("expected real parallelism (peak >= 2 with %d docs), got peak %d", len(ids), peak)
	}
}
