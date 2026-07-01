package editor

import (
	"sync"
	"testing"
	"time"

	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/services"
)

// recordingFiler is a fake docFiler: it records how many times each id is filed
// and tracks peak concurrency (holding a slot with a sleep so overlap is
// observable). It replaces the CLI so no real AI runs. This ports the two
// assertions the retired sieve/ai/close_filing_test.go pinned onto the new
// engine path (EditorService.CloseAllAndFile → JobEngine ai pool).
type recordingFiler struct {
	mu     sync.Mutex
	seen   map[string]int
	active int
	peak   int
	hold   time.Duration
	wg     *sync.WaitGroup
}

func (r *recordingFiler) EvaluateAndFileDoc(id string, fileAfter, allowDiscard bool) (ai.FilingOutcome, error) {
	r.mu.Lock()
	r.seen[id]++
	r.active++
	if r.active > r.peak {
		r.peak = r.active
	}
	r.mu.Unlock()

	time.Sleep(r.hold) // hold the slot so concurrent overlap is measurable

	r.mu.Lock()
	r.active--
	r.mu.Unlock()
	r.wg.Done()
	return ai.FilingOutcome{}, nil
}

// TestEditorService_CloseAllAndFile_filesEveryDocOnceBoundedByPool proves that
// CloseAllAndFile evaluates EVERY closing doc exactly once (the close-all-files-
// nothing regression stays fixed) AND that concurrency is bounded by the engine's
// ai worker pool (what the retired local semaphore used to guarantee).
func TestEditorService_CloseAllAndFile_filesEveryDocOnceBoundedByPool(t *testing.T) {
	const poolSize = 2

	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	tracker := services.NewJobTracker()
	engine := services.NewJobEngine(map[string]int{"ai": poolSize}, poolSize, tracker)
	es.SetEngine(engine)

	ids := []string{"a", "b", "c", "d", "e"}
	var wg sync.WaitGroup
	wg.Add(len(ids))
	filer := &recordingFiler{seen: map[string]int{}, hold: 40 * time.Millisecond, wg: &wg}
	// White-box injection: SetAI takes the concrete *ai.AIService, but the field is
	// the docFiler seam, so a same-package test substitutes the fake directly.
	es.ai = filer

	es.CloseAllAndFile(ids)

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for close-all filing jobs to finish")
	}

	filer.mu.Lock()
	defer filer.mu.Unlock()

	if len(filer.seen) != len(ids) {
		t.Fatalf("expected every closing doc filed, got %d of %d: %v", len(filer.seen), len(ids), filer.seen)
	}
	for _, id := range ids {
		if filer.seen[id] != 1 {
			t.Fatalf("doc %q filed %d times, want exactly 1", id, filer.seen[id])
		}
	}
	if filer.peak > poolSize {
		t.Fatalf("concurrency exceeded ai pool: peak %d > pool %d", filer.peak, poolSize)
	}
	if filer.peak < 2 {
		t.Fatalf("expected real parallelism (peak >= 2 with pool %d), got peak %d", poolSize, filer.peak)
	}
}
