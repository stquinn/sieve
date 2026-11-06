package requesthandlers

import (
	"context"
	"errors"
	"sync"
	"time"

	"sieve/ident"
)

// ErrNoWorkspaceClient is a request with no workspace client connected to ask.
var ErrNoWorkspaceClient = errors.New("no workspace client is connected")

// ErrNoWorkspaceAnswer is a request the client asked did not answer in time, or left unanswered
// when it disconnected.
var ErrNoWorkspaceAnswer = errors.New("the workspace client did not answer")

// workspaceAnswerWait is how long a request waits for its answer.
const workspaceAnswerWait = 60 * time.Second

// WorkspaceRequests is the asking side of the workspace wire: Go sends one connected client a
// frame carrying a fresh correlation id, and waits for the frame that client answers with under
// the same id. The client asked is, of those connected, the one that connected last. Each kind of
// request is a frame word the client claims, and its answer an inbound frame word whose handler
// hands the decoded answer on. It is safe for concurrent use, and a request holds no lock while
// it waits.
type WorkspaceRequests struct {
	broadcast *WorkspaceBroadcast
	wait      time.Duration
	// after is the clock a request waits on.
	after func(time.Duration) <-chan time.Time

	mu      sync.Mutex
	pending map[string]*workspaceAsk
}

// workspaceAsk is one request waiting: the client asked, and where its answer, or its leaving,
// is delivered.
type workspaceAsk struct {
	conn   *wsConn
	answer chan interface{}
	gone   chan struct{}
}

func newWorkspaceRequests(b *WorkspaceBroadcast) *WorkspaceRequests {
	return &WorkspaceRequests{broadcast: b, wait: workspaceAnswerWait, after: time.After, pending: map[string]*workspaceAsk{}}
}

// Ask writes the frame frameFor builds for a fresh correlation id to the workspace client that
// connected last, and returns the answer that client gives under that id. No client connected is
// ErrNoWorkspaceClient at once; no answer within the wait, or the client leaving first, is
// ErrNoWorkspaceAnswer; ctx ending is ctx's error.
func (r *WorkspaceRequests) Ask(ctx context.Context, frameFor func(correlationID string) interface{}) (interface{}, error) {
	conn := r.broadcast.newest()
	if conn == nil {
		return nil, ErrNoWorkspaceClient
	}
	id := ident.New()
	ask := &workspaceAsk{conn: conn, answer: make(chan interface{}, 1), gone: make(chan struct{})}
	r.mu.Lock()
	r.pending[id] = ask
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
	}()
	timeout := r.after(r.wait)
	conn.write(frameFor(id))
	select {
	case answer := <-ask.answer:
		return answer, nil
	case <-ask.gone:
		return nil, ErrNoWorkspaceAnswer
	case <-timeout:
		return nil, ErrNoWorkspaceAnswer
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// answer hands answer, which client from sent under correlationID, to the request waiting for it,
// and reports whether one was. An answer from a client that was not asked is refused.
func (r *WorkspaceRequests) answer(from *wsConn, correlationID string, answer interface{}) bool {
	r.mu.Lock()
	ask, ok := r.pending[correlationID]
	if ok && ask.conn == from {
		delete(r.pending, correlationID)
	}
	r.mu.Unlock()
	if !ok || ask.conn != from {
		return false
	}
	ask.answer <- answer
	return true
}

// left fails every request waiting on an answer from c.
func (r *WorkspaceRequests) left(c *wsConn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, ask := range r.pending {
		if ask.conn == c {
			close(ask.gone)
			delete(r.pending, id)
		}
	}
}
