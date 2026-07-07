package editor

import (
	"sync"
	"testing"
	"time"

	"sieve/sieve/ai"
	"sieve/sieve/block"
	"sieve/sieve/services"
)

// countingFiler records every id passed to EvaluateAndFileDoc. Unlike
// recordingFiler it does not use a WaitGroup — close-guard tests assert on which
// ids reached the filer, not on concurrency, and a skipped doc never arrives.
type countingFiler struct {
	mu   sync.Mutex
	seen map[string]int
}

func (c *countingFiler) EvaluateAndFileDoc(id string, fileAfter, allowDiscard bool) (ai.FilingOutcome, error) {
	c.mu.Lock()
	c.seen[id]++
	c.mu.Unlock()
	return ai.FilingOutcome{}, nil
}

func (c *countingFiler) count(id string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.seen[id]
}

// newGuardEditorService builds an EditorService wired to a real DocumentService
// (so alreadyFiled can consult live document kinds) and a synchronous engine, with
// a countingFiler substituted for the AI brain.
func newGuardEditorService(t *testing.T) (*EditorService, *services.DocumentService, *countingFiler) {
	t.Helper()
	resetRegistry()
	ds, _ := newTestDocumentService(t)
	es := NewEditorService(ds, block.NewDocumentCodec(block.GlobalRegistry()), 0)

	tracker := services.NewJobTracker()
	engine := services.NewJobEngine(map[string]int{"ai": 2}, 2, tracker)
	es.SetEngine(engine)

	filer := &countingFiler{seen: map[string]int{}}
	es.ai = filer // white-box: the field is the docFiler seam
	return es, ds, filer
}

func waitFiling(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		if cond() {
			return
		}
		select {
		case <-deadline:
			return // let the caller assert and report
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestCloseDocument_skipsAlreadyFiledNote proves an already-filed note (KindNote)
// is NOT re-evaluated on close, while an unfiled buffer still is. This is the
// Bug 2 guard: smart filing on close is only for unfiled buffers.
func TestCloseDocument_skipsAlreadyFiledNote(t *testing.T) {
	es, ds, filer := newGuardEditorService(t)

	// A filed note: create a buffer then promote it to the Library. UUID is stable
	// across the move, so the close path resolves the same id to a KindNote.
	buf, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	buf.SetBody([]byte("some real content"))
	if _, err = ds.Save(buf); err != nil {
		t.Fatalf("Save: %v", err)
	}
	filed, err := ds.File(buf)
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	filedID := filed.UUID()

	es.CloseDocument(filedID)
	waitFiling(t, func() bool { return filer.count(filedID) > 0 })
	if got := filer.count(filedID); got != 0 {
		t.Fatalf("already-filed note was re-evaluated on close %d time(s), want 0", got)
	}

	// An unfiled buffer must STILL be filed on close (legitimate case preserved).
	unfiled, err := ds.New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	unfiledID := unfiled.UUID()

	es.CloseDocument(unfiledID)
	waitFiling(t, func() bool { return filer.count(unfiledID) > 0 })
	if got := filer.count(unfiledID); got != 1 {
		t.Fatalf("unfiled buffer filed %d time(s) on close, want 1", got)
	}
}

// TestCloseAllAndFile_skipsAlreadyFiledNotes proves the batch close path applies
// the same guard: filed notes are skipped, unfiled buffers are filed.
func TestCloseAllAndFile_skipsAlreadyFiledNotes(t *testing.T) {
	es, ds, filer := newGuardEditorService(t)

	buf, _ := ds.New()
	buf.SetBody([]byte("content"))
	_, _ = ds.Save(buf)
	filed, err := ds.File(buf)
	if err != nil {
		t.Fatalf("File: %v", err)
	}
	filedID := filed.UUID()

	unfiled, _ := ds.New()
	unfiledID := unfiled.UUID()

	es.CloseAllAndFile([]string{filedID, unfiledID})
	waitFiling(t, func() bool { return filer.count(unfiledID) > 0 })

	if got := filer.count(filedID); got != 0 {
		t.Fatalf("already-filed note re-evaluated in close-all %d time(s), want 0", got)
	}
	if got := filer.count(unfiledID); got != 1 {
		t.Fatalf("unfiled buffer filed %d time(s) in close-all, want 1", got)
	}
}
