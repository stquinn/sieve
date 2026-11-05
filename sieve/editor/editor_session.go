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
// of a session open on a block container. A container is read-only from the
// client: its block changes only through the service that owns it, and reaches
// an open session through ReloadFromDisk.
var ErrNotDocument = errors.New("is a block container, not a document")

// session is one container EditorService holds open. Its two implementations are
// the only place the service tells a document from a block container.
type session interface {
	// document is the shadow a document verb works on; a block container answers
	// ErrNotDocument.
	document() (*block.ShadowDocument, error)

	// blocks is what the session holds, as copies.
	blocks() []domain.SieveBlock

	// close ends the session. reason names the flush in the log.
	close(es *EditorService, reason string)

	// reload adopts what disk now holds for the session.
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
		logger.Warn("editor: reload-from-disk load failed", "uuid", d.shadow.UUID, "err", err)
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
	return nil, fmt.Errorf("uuid %q %w", c.uuid(), ErrNotDocument)
}

func (c *containerSession) blocks() []domain.SieveBlock {
	c.mu.Lock()
	defer c.mu.Unlock()
	return []domain.SieveBlock{c.container.Block().Clone()}
}

func (c *containerSession) close(*EditorService, string) {}

// reload reads the container again and pushes its block's attrs to the client
// through the same lifecycle event a document block's attr update takes.
func (c *containerSession) reload(es *EditorService) error {
	loaded, err := es.containers.Load(c.uuid())
	if err != nil {
		logger.Warn("editor: block container reload failed", "uuid", c.uuid(), "err", err)
		return err
	}
	c.mu.Lock()
	c.container = loaded
	c.mu.Unlock()
	es.pushBlockAttrs(loaded.UUID(), loaded.Block())
	return nil
}

func (c *containerSession) uuid() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.container.UUID()
}
