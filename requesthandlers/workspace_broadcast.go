package requesthandlers

import (
	"sync"

	"sieve/sieve/domain"
	"sieve/sieve/protocol"
)

// JobsSource is the live job state a jobs-changed frame carries. It is an
// interface here rather than the tracker itself because services/ sits BELOW
// protocol/ in the import DAG and so cannot build the frame: the tracker keeps
// the state, and this package — which may name both — composes it.
type JobsSource interface {
	Active() []domain.JobInfo
	Queued() []domain.JobInfo
}

// WorkspaceBroadcast is the push side of the workspace wire: a frame handed to
// it reaches EVERY connected workspace socket, which is what a UI-wide signal
// like "the notes changed" means. It is deliberately not the reply side — a
// correlated reply is requester-affine and goes back through WsHandler.replyTo.
//
// It keeps its own set of connections rather than reading WsHandler's channels
// map, because that map answers a different question: which SINGLE socket
// currently owns the workspace channel (replyTo's fallback when the requester
// has gone). Folding a fan-out into that single-owner slot is what would break
// requester affinity.
type WorkspaceBroadcast struct {
	// jobs is read whenever a jobs-changed frame is composed. Set once at
	// construction by the composition root; a nil jobs (e.g. in a test that
	// never wires one) simply composes an empty snapshot.
	jobs JobsSource

	mu    sync.RWMutex
	conns map[*wsConn]struct{}
}

// NewWorkspaceBroadcast returns an empty fan-out wired to jobs (nil is valid —
// jobsFrame composes an empty snapshot). One instance is shared by the whole
// app: the WS handler fills it as sockets connect, and everything with news to
// push holds it. jobs is a constructor parameter, not a post-construction
// setter, because it is read from socket goroutines (jobsFrame on connect,
// PushJobs on every transition) and the composition root sets it exactly once,
// before any socket can dial in — a mutable exported field would let a caller
// reassign it after sockets are already reading it.
func NewWorkspaceBroadcast(jobs JobsSource) *WorkspaceBroadcast {
	return &WorkspaceBroadcast{jobs: jobs, conns: make(map[*wsConn]struct{})}
}

// join adds a freshly connected workspace socket to the fan-out.
func (b *WorkspaceBroadcast) join(c *wsConn) {
	b.mu.Lock()
	b.conns[c] = struct{}{}
	b.mu.Unlock()
}

// leave removes a dead workspace socket. Unlike the channels map there is no
// ownership question here: every live socket is a member, so a departure is
// unconditional.
func (b *WorkspaceBroadcast) leave(c *wsConn) {
	b.mu.Lock()
	delete(b.conns, c)
	b.mu.Unlock()
}

// size reports the current fan-out membership. It exists so a test can pin
// that leave() actually removes a departed socket rather than assuming it
// from the survivors alone still receiving broadcasts.
func (b *WorkspaceBroadcast) size() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.conns)
}

// Send writes frame to every connected workspace socket. The membership is
// copied under the lock and the writes happen outside it: each write takes that
// connection's own writer mutex, and holding the registry lock across a blocking
// socket write would queue every other broadcast behind the slowest client.
func (b *WorkspaceBroadcast) Send(frame interface{}) {
	b.mu.RLock()
	conns := make([]*wsConn, 0, len(b.conns))
	for c := range b.conns {
		conns = append(conns, c)
	}
	b.mu.RUnlock()

	for _, c := range conns {
		c.write(frame)
	}
}

// Invalidate tells every workspace socket that a topic's views are stale. The
// frame carries no data: the client refetches the affected view over HTTP, so
// hypermedia stays hypermedia and only the signalling rides this wire.
func (b *WorkspaceBroadcast) Invalidate(topic protocol.Topic) {
	b.Send(protocol.NewInvalidateFrame(topic))
}

// NotesChanged satisfies command.NotesInvalidator, the port the filing family
// drives. That port is topic-free because command/ cannot import protocol/ (the
// edge runs protocol → block → ai → command), so the topic is chosen here.
func (b *WorkspaceBroadcast) NotesChanged() {
	b.Invalidate(protocol.TopicNotes)
}

// ContainerDeleted tells every workspace socket that a container is gone —
// see protocol.ContainerDeletedFrame for the reconciliation contract and the
// CONTAINER-not-"document" naming rationale.
func (b *WorkspaceBroadcast) ContainerDeleted(uuid string) {
	b.Send(protocol.NewContainerDeletedFrame(uuid))
}

// ContainerSaved tells every workspace socket that a container's content
// reached disk — see protocol.ContainerSavedFrame for why a save is a
// workspace-wide fact rather than a reply on the document wire. It satisfies
// editor.ContainerSavedNotifier, which is how EditorService's save chokepoint
// reaches this fan-out without naming it.
func (b *WorkspaceBroadcast) ContainerSaved(uuid string, version int) {
	b.Send(protocol.NewContainerSavedFrame(uuid, version))
}

// jobsFrame composes the current snapshot. It is the ONE composition, so the
// frame a socket is handed on connect and the frame a transition broadcasts can
// never describe the job set differently.
func (b *WorkspaceBroadcast) jobsFrame() protocol.JobsChangedFrame {
	var snapshot protocol.JobsSnapshot
	if b.jobs != nil {
		snapshot = protocol.JobsSnapshot{Active: b.jobs.Active(), Queued: b.jobs.Queued()}
	}
	return protocol.NewJobsChangedFrame(snapshot)
}

// PushJobs broadcasts the whole job snapshot. It is what JobTracker notifies on
// every transition.
func (b *WorkspaceBroadcast) PushJobs() {
	b.Send(b.jobsFrame())
}
