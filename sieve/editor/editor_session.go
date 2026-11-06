package editor

import (
	"errors"
	"fmt"
	"sync"

	"sieve/logger"
	"sieve/sieve/block"
	"sieve/sieve/domain"
)

// ErrNotOpen reports a uuid EditorService holds no session for.
var ErrNotOpen = errors.New("no open document")

// ErrNotDocument reports a verb that edits a document, or reads one as text, asked
// of a session open on a block container or another node. Such a session is
// read-only from the client: its block changes only through the service that owns
// it, and reaches an open session through Refresh.
var ErrNotDocument = errors.New("not a document")

// session is one container EditorService holds open. Its implementations are the
// only place the service tells a document from a block container or another node.
type session interface {
	// document is the shadow a document verb works on; a block container answers
	// ErrNotDocument.
	document() (*block.ShadowDocument, error)

	// blocks is what the session holds, as copies.
	blocks() []domain.SieveBlock

	// close ends the session. reason names the flush in the log.
	close(es *EditorService, reason string)

	// reload adopts what the session's owner now holds for it.
	reload(es *EditorService) error
}

// documentSession is a document open for editing: a ShadowDocument, flushed on
// close.
type documentSession struct {
	shadow *block.ShadowDocument
}

func (d documentSession) document() (*block.ShadowDocument, error) { return d.shadow, nil }

func (d documentSession) blocks() []domain.SieveBlock { return d.shadow.SnapshotBlocks() }

func (d documentSession) close(es *EditorService, reason string) {
	d.shadow.StopDebounce()
	_ = es.flushShadow(d.shadow, reason)
}

// reload replaces the shadow's content with the stored body, reparsed through the
// codec so marker ids survive. It does not flush and tells no client: the disk
// is already authoritative, and the caller decides how the client reloads.
func (d documentSession) reload(es *EditorService) error {
	doc, err := es.documents.LoadByUUID(d.shadow.UUID)
	if err != nil {
		logger.Warn("editor: reload load failed", "uuid", d.shadow.UUID, "err", err)
		return err
	}
	d.shadow.SetMarkdown(string(doc.Body()))
	logger.Info("editor: reloaded shadow from disk", "uuid", d.shadow.UUID, "bytes", len(doc.Body()))
	return nil
}

// containerSession is a block container open for reading. Its one block has the
// container's uuid for its id. Closing it writes nothing.
type containerSession struct {
	mu        sync.Mutex
	container *domain.BlockContainer
}

func (c *containerSession) document() (*block.ShadowDocument, error) {
	return nil, fmt.Errorf("uuid %q is a block container, %w", c.uuid(), ErrNotDocument)
}

func (c *containerSession) blocks() []domain.SieveBlock {
	c.mu.Lock()
	defer c.mu.Unlock()
	return []domain.SieveBlock{c.container.Block().Clone()}
}

func (c *containerSession) close(*EditorService, string) {}

// reload reads the container again and pushes its block's attrs to the client
// through the same lifecycle event a document block's attr update takes, and its
// name when that changed.
func (c *containerSession) reload(es *EditorService) error {
	loaded, err := es.containers.Load(c.uuid())
	if err != nil {
		logger.Warn("editor: block container reload failed", "uuid", c.uuid(), "err", err)
		return err
	}
	was := c.name()
	c.mu.Lock()
	c.container = loaded
	c.mu.Unlock()
	es.pushBlockAttrs(loaded.UUID(), loaded.Block())
	if now := c.name(); now != was {
		es.notifyNamed(loaded.UUID(), now)
	}
	return nil
}

// name is what the container is called (block.Registry.ContainerName).
func (c *containerSession) name() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return block.GlobalRegistry().ContainerName(c.container.Block(), c.container.Storable().Meta())
}

func (c *containerSession) version() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.container.Version()
}

func (c *containerSession) uuid() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.container.UUID()
}

// nodeSession is a node the Router resolves that is neither a document nor a
// stored block container, open for reading: its one block, built from the node's
// descriptor, whose id is the node's. Closing it writes nothing.
type nodeSession struct {
	mu  sync.Mutex
	blk domain.SieveBlock
}

func (n *nodeSession) document() (*block.ShadowDocument, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	return nil, fmt.Errorf("uuid %q is a %s node, %w", n.blk.ID, n.blk.Kind, ErrNotDocument)
}

func (n *nodeSession) blocks() []domain.SieveBlock {
	n.mu.Lock()
	defer n.mu.Unlock()
	return []domain.SieveBlock{n.blk.Clone()}
}

func (n *nodeSession) close(*EditorService, string) {}

// reload resolves the node again and pushes its block's attrs to the client as a
// block attr update. A node that no longer resolves closes the session.
func (n *nodeSession) reload(es *EditorService) error {
	n.mu.Lock()
	uuid := n.blk.ID
	n.mu.Unlock()
	node, err := es.resolveNode(uuid)
	if errors.Is(err, domain.ErrNodeNotFound) {
		logger.Info("editor: an open node no longer resolves", "uuid", uuid)
		es.Close(uuid)
		return nil
	}
	if err != nil {
		return err
	}
	blk := node.Block()
	n.mu.Lock()
	n.blk = blk
	n.mu.Unlock()
	es.pushBlockAttrs(uuid, blk)
	return nil
}
