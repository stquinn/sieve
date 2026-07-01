package services

import (
	"fmt"
	"sync"
)

// queueBacklog is the per-pool buffer depth — a runaway backstop, not a tuning
// knob. Pools are effectively unbounded for Sieve's workloads; what we configure
// is worker count, not depth.
const queueBacklog = 1024

// JobDescriptor is the unit of work the engine runs. Category is opaque data the
// engine routes on — it never switches on its meaning.
type JobDescriptor struct {
	Category   string
	Meta       JobInfo
	Work       func() (any, error)
	OnFinished func(result any)
	OnError    func(err error)
}

// JobEngine is the one communal producer/consumer engine: a bounded worker pool
// per Category, all pools identical, differing only by configured worker count.
type JobEngine struct {
	tracker  *JobTracker
	defaultN int
	sizes    map[string]int
	mu       sync.Mutex
	pools    map[string]*workerPool
}

func NewJobEngine(sizes map[string]int, defaultN int, tracker *JobTracker) *JobEngine {
	if defaultN < 1 {
		defaultN = 1
	}
	if sizes == nil {
		sizes = map[string]int{}
	}
	return &JobEngine{tracker: tracker, defaultN: defaultN, sizes: sizes, pools: map[string]*workerPool{}}
}

func (e *JobEngine) Submit(d JobDescriptor) {
	if e.tracker != nil {
		meta := d.Meta
		meta.Category = d.Category
		e.tracker.Enqueue(meta)
	}
	e.poolFor(d.Category).submit(d)
}

func (e *JobEngine) poolFor(category string) *workerPool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if p, ok := e.pools[category]; ok {
		return p
	}
	n := e.defaultN
	if sz, ok := e.sizes[category]; ok && sz > 0 {
		n = sz
	}
	p := newWorkerPool(n, e.run)
	e.pools[category] = p
	return p
}

func (e *JobEngine) run(d JobDescriptor) {
	if e.tracker != nil {
		e.tracker.Activate(d.Meta.JobID)
	}
	result, err := e.safeWork(d.Work)
	if e.tracker != nil {
		e.tracker.Finish(d.Meta.JobID)
	}
	if err != nil {
		if d.OnError != nil {
			d.OnError(err)
		}
		return
	}
	if d.OnFinished != nil {
		d.OnFinished(result)
	}
}

// safeWork runs a descriptor's Work closure, converting a panic into an error
// so one bad job never kills its worker. A nil Work is an immediate success.
func (e *JobEngine) safeWork(work func() (any, error)) (result any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("job panicked: %v", r)
		}
	}()
	if work == nil {
		return nil, nil
	}
	return work()
}

// workerPool is N goroutines draining one buffered channel. All categories use
// the same implementation; only n differs.
type workerPool struct {
	jobs chan JobDescriptor
}

func newWorkerPool(n int, run func(JobDescriptor)) *workerPool {
	if n < 1 {
		n = 1
	}
	p := &workerPool{jobs: make(chan JobDescriptor, queueBacklog)}
	for i := 0; i < n; i++ {
		go func() {
			for d := range p.jobs {
				run(d)
			}
		}()
	}
	return p
}

func (p *workerPool) submit(d JobDescriptor) { p.jobs <- d }
