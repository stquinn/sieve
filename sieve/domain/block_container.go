package domain

import (
	"errors"

	"sieve/store"
)

// ErrNotBlockContainer reports a uuid that names no block container: nothing at
// all, or a storable of another type.
var ErrNotBlockContainer = errors.New("block container: uuid names no block container")

// BlockContainer is one block written directly to a file: its content file opens
// with a kind line, then holds the block's YAML map, exactly what its fence would
// hold inside a document. .meta carries the kind too, set at creation, so listings
// need not parse bodies; the two disagreeing is a parse error. The container's uuid
// IS the block's id.
//
// It is a sibling of Document over store.MetaStorable, and every store mutation
// returns a new one: a BlockContainer is stale once it has been passed to
// BlockContainerService.Save.
type BlockContainer struct {
	storable store.MetaStorable
	block    SieveBlock
}

// NewBlockContainer pairs a type: block storable with the block already parsed
// out of its body. blk's id must be the storable's key.
func NewBlockContainer(ms store.MetaStorable, blk SieveBlock) *BlockContainer {
	return &BlockContainer{storable: ms, block: blk}
}

// UUID is the container's identity, and the id of the block it holds.
func (c *BlockContainer) UUID() string { return c.storable.Key() }

// Kind is the block kind recorded in .meta.
func (c *BlockContainer) Kind() string { return c.storable.Meta()[store.MetaKeyKind] }

// Block returns the block this container holds, with any unsaved Merge applied.
func (c *BlockContainer) Block() SieveBlock { return c.block }

// Merge applies attrs additively to the held block. The change is local until
// BlockContainerService.Save. The block's id cannot be changed this way.
func (c *BlockContainer) Merge(attrs map[string]interface{}) {
	c.block.Merge(SieveBlock{Attrs: attrs})
	c.block.Attrs["id"] = c.UUID()
}

// Version is the store's version of the container's last save.
func (c *BlockContainer) Version() int { return metaInt(c.storable.Meta(), "version") }

// Versions lists the saved snapshots, newest first.
func (c *BlockContainer) Versions() []store.VersionRef { return c.storable.Versions() }

// Storable returns the underlying MetaStorable for direct Store operations.
func (c *BlockContainer) Storable() store.MetaStorable { return c.storable }

// Assets lists the assets beside the block.
func (c *BlockContainer) Assets() []store.Storable { return c.storable.Owns() }
