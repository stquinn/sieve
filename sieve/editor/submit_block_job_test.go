package editor

import (
	"errors"
	"sync"
	"testing"
	"time"

	"sieve/sieve/block"
	"sieve/sieve/services"
)

func newEngineEditor(t *testing.T) *EditorService {
	t.Helper()
	es, _ := newTestEditorServiceWithProseBlock(t)
	es.SetEngine(services.NewJobEngine(map[string]int{"ai": 2}, 2, services.NewJobTracker()))
	return es
}

func TestSubmitBlockJob_AppliesThenFinishesOnSuccess(t *testing.T) {
	es := newEngineEditor(t)
	blk := &block.SieveBlock{ID: "b1", Kind: "code", Attrs: map[string]interface{}{}}
	var order []string
	var mu sync.Mutex
	done := make(chan struct{})
	job := block.ProcessorJob{
		Category: block.CategoryAI, Label: "Refining…",
		Work: func() (any, error) { mu.Lock(); order = append(order, "work"); mu.Unlock(); return "go", nil },
		Apply: func(result any, b *block.SieveBlock) {
			mu.Lock(); order = append(order, "apply"); mu.Unlock()
			b.Attrs["language"] = result.(string)
		},
	}
	es.submitBlockJob(job, services.JobInfo{JobID: "b1"}, blk, func(err error) {
		mu.Lock(); order = append(order, "finish"); mu.Unlock()
		if err != nil { t.Errorf("unexpected err: %v", err) }
		close(done)
	})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("onDone never called")
	}
	if blk.Attrs["language"] != "go" { t.Fatalf("Apply did not mutate blk: %+v", blk.Attrs) }
	if len(order) != 3 || order[0] != "work" || order[1] != "apply" || order[2] != "finish" {
		t.Fatalf("order wrong: %v (want work,apply,finish)", order)
	}
}

func TestSubmitBlockJob_ErrorSkipsApply(t *testing.T) {
	es := newEngineEditor(t)
	blk := &block.SieveBlock{ID: "b1", Attrs: map[string]interface{}{}}
	applied := false
	done := make(chan error, 1)
	job := block.ProcessorJob{
		Category: block.CategoryAI,
		Work:  func() (any, error) { return nil, errors.New("boom") },
		Apply: func(any, *block.SieveBlock) { applied = true },
	}
	es.submitBlockJob(job, services.JobInfo{JobID: "b1"}, blk, func(err error) { done <- err })
	select {
	case err := <-done:
		if err == nil { t.Fatal("expected error to reach onDone") }
	case <-time.After(2 * time.Second):
		t.Fatal("onDone never called")
	}
	if applied { t.Fatal("Apply must NOT run on error") }
}

func TestSubmitBlockJob_NilWorkStillApplies(t *testing.T) {
	es := newEngineEditor(t)
	blk := &block.SieveBlock{ID: "b1", Attrs: map[string]interface{}{}}
	done := make(chan struct{})
	job := block.ProcessorJob{Category: block.CategoryAI, Apply: func(_ any, b *block.SieveBlock) { b.Attrs["applied"] = true }}
	es.submitBlockJob(job, services.JobInfo{JobID: "b1"}, blk, func(err error) {
		if err != nil { t.Errorf("nil Work should be success, got %v", err) }
		close(done)
	})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("onDone never called")
	}
	if blk.Attrs["applied"] != true { t.Fatalf("Apply should run for nil Work") }
}
