// Package blockcontainer stores one block as a container of its own, beside
// documents over store.MetaStorable. It sits directly over block and store, so a
// service that creates containers does not depend on the editor.
package blockcontainer

import (
	"errors"
	"fmt"
	"maps"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"
)

// ErrNotBlockContainer reports a uuid that names no block container: nothing at
// all, or a storable of another type.
var ErrNotBlockContainer = errors.New("block container: uuid names no block container")

// bodyKindKey is the key of the first line of a container's content file. It is
// never an attr, so a kind whose attrs carry this key cannot be held in a container.
const bodyKindKey = "kind"

// BlockContainer is one block written directly to a file: its content file opens
// with a kind line, then holds the block's YAML map, exactly what its fence would
// hold inside a document. .meta carries the kind too, set at creation, so listings
// need not parse bodies; the two disagreeing is a parse error. The container's uuid
// IS the block's id.
//
// It is a sibling of domain.Document over store.MetaStorable, and every store
// mutation returns a new one: a BlockContainer is stale once it has been passed
// to BlockContainerService.Save.
type BlockContainer struct {
	storable store.MetaStorable
	block    block.SieveBlock
}

// newBlockContainer reads the block out of a type: block storable's body.
func newBlockContainer(ms store.MetaStorable) (*BlockContainer, error) {
	c := &BlockContainer{storable: ms}
	blk, err := c.parse(ms.Body())
	if err != nil {
		return nil, err
	}
	c.block = blk
	return c, nil
}

// UUID is the container's identity, and the id of the block it holds.
func (c *BlockContainer) UUID() string { return c.storable.Key() }

// Kind is the block kind recorded in .meta.
func (c *BlockContainer) Kind() string { return c.storable.Meta()[store.MetaKeyKind] }

// Block returns the block this container holds, with any unsaved Merge applied.
func (c *BlockContainer) Block() block.SieveBlock { return c.block }

// Merge applies attrs additively to the held block. The change is local until
// BlockContainerService.Save. The block's id cannot be changed this way.
func (c *BlockContainer) Merge(attrs map[string]interface{}) {
	c.block.Merge(block.SieveBlock{Attrs: attrs})
	c.block.Attrs["id"] = c.UUID()
}

// Versions lists the saved snapshots, newest first.
func (c *BlockContainer) Versions() []store.VersionRef { return c.storable.Versions() }

// Storable returns the underlying MetaStorable for direct Store operations.
func (c *BlockContainer) Storable() store.MetaStorable { return c.storable }

// Assets lists the assets beside the block.
func (c *BlockContainer) Assets() []store.Storable { return c.storable.Owns() }

// parse reads content-file bytes, live or from a snapshot, into a block of this
// container's kind. Bytes that name no kind, or another kind than .meta does, are
// an error. The kind line never reaches Attrs, and the container's uuid overrides
// any id the bytes carry.
func (c *BlockContainer) parse(body []byte) (block.SieveBlock, error) {
	kind := c.Kind()
	if kind == "" {
		return block.SieveBlock{}, fmt.Errorf("block container %s: .meta names no kind", c.UUID())
	}
	parsed, err := block.FencedDeserializer{Kind: kind}.DeserializeAttrs(string(body))
	if err != nil {
		return block.SieveBlock{}, fmt.Errorf("block container %s: parse body: %w", c.UUID(), err)
	}
	if named, _ := parsed.Attrs[bodyKindKey].(string); named != kind {
		return block.SieveBlock{}, fmt.Errorf("block container %s: body names kind %q, .meta names %q", c.UUID(), named, kind)
	}
	delete(parsed.Attrs, bodyKindKey)
	blk := block.NewSieveBlock(kind, c.UUID(), parsed.Attrs)
	blk.Aliases = parsed.Aliases
	return blk, nil
}

// BlockContainerService owns every store.TypeBlock storable: it is to a
// BlockContainer what services.DocumentService is to a domain.Document. A
// container may be in any category; new ones are born in domain.Blocks.
type BlockContainerService struct {
	store    store.Store
	registry block.ProcessorRegistry
}

// NewBlockContainerService prepares the Blocks category and builds the service.
func NewBlockContainerService(st store.Store, registry block.ProcessorRegistry) (*BlockContainerService, error) {
	if err := st.PrepareCategory(domain.Blocks); err != nil {
		return nil, err
	}
	return &BlockContainerService{store: st, registry: registry}, nil
}

// Create makes a new container holding a fresh block of kind, seeded by the kind's
// InitAttrs from overrides. A kind with no registered processor is an error. Its
// uuid is minted here and names its directory.
func (s *BlockContainerService) Create(kind string, overrides map[string]interface{}) (*BlockContainer, error) {
	processor := s.registry.Get(kind)
	if processor == nil {
		return nil, fmt.Errorf("block container: no processor for kind %q", kind)
	}
	id := ident.New()
	blk := block.NewSieveBlock(kind, id, processor.InitAttrs(id, overrides))
	body, err := s.render(blk)
	if err != nil {
		return nil, err
	}
	meta := s.withFace(map[string]string{"uuid": id, store.MetaKeyKind: kind}, blk)
	ms, err := s.store.CreateTyped(domain.Blocks, id, store.TypeBlock, meta, body)
	if err != nil {
		return nil, fmt.Errorf("block container: create %s: %w", kind, err)
	}
	return newBlockContainer(ms)
}

// Load returns the container named by uuid. A uuid naming no container is
// ErrNotBlockContainer; a container whose body will not parse is a different
// error, so a broken file never reads as a missing one.
func (s *BlockContainerService) Load(uuid string) (*BlockContainer, error) {
	storable, err := s.store.LoadByUUID(uuid)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", ErrNotBlockContainer, uuid, err)
	}
	ms, ok := storable.(store.MetaStorable)
	if !ok || ms.Type() != store.TypeBlock {
		return nil, fmt.Errorf("%w: %s", ErrNotBlockContainer, uuid)
	}
	return newBlockContainer(ms)
}

// Save writes the held block and its kind's face, bumping the version and
// writing a snapshot. It returns the new container; c is stale.
// store.ErrStaleStorable is surfaced.
func (s *BlockContainerService) Save(c *BlockContainer) (*BlockContainer, error) {
	body, err := s.render(c.block)
	if err != nil {
		return nil, err
	}
	c.storable.SetMeta(s.withFace(c.storable.Meta(), c.block))
	c.storable.SetBody(body)
	saved, err := s.store.Save(c.storable)
	if err != nil {
		return nil, fmt.Errorf("block container %s: save: %w", c.UUID(), err)
	}
	ms, ok := saved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("block container %s: save: not MetaStorable", c.UUID())
	}
	return newBlockContainer(ms)
}

// Delete removes the container, its history and its assets.
func (s *BlockContainerService) Delete(c *BlockContainer) error {
	return s.store.Delete(c.storable)
}

// Version reads the block as saved at ref. A version nobody wrote, or one pruned
// from history, wraps fs.ErrNotExist.
func (s *BlockContainerService) Version(c *BlockContainer, ref store.VersionRef) (block.SieveBlock, error) {
	snapshot, err := s.store.RetrieveVersion(c.storable, ref)
	if err != nil {
		return block.SieveBlock{}, fmt.Errorf("block container %s: version %s: %w", c.UUID(), ref.ID, err)
	}
	return c.parse(snapshot.Body)
}

// SaveAsset writes data as an asset beside the block, replacing any asset of the
// same key. The container's version does not move.
func (s *BlockContainerService) SaveAsset(c *BlockContainer, assetKey string, data []byte) (store.AssetStorable, error) {
	return store.OwnedAssets{Store: s.store}.Save(c.storable, assetKey, data)
}

// AppendAsset appends data to an asset beside the block, creating it when
// absent, without reading or rewriting what the asset already holds. The
// container's version does not move.
func (s *BlockContainerService) AppendAsset(c *BlockContainer, assetKey string, data []byte) (store.AssetStorable, error) {
	return store.OwnedAssets{Store: s.store}.Append(c.storable, assetKey, data)
}

// LoadAsset reads an asset the container owns.
func (s *BlockContainerService) LoadAsset(c *BlockContainer, assetKey string) (store.AssetStorable, error) {
	return s.store.LoadAsset(c.storable.Category(), c.UUID(), assetKey)
}

// DeleteAsset removes an asset the container owns. c's Assets list is stale
// afterwards; Load again to read it.
func (s *BlockContainerService) DeleteAsset(c *BlockContainer, assetKey string) error {
	return s.store.DeleteAsset(c.storable.Category(), c.UUID(), assetKey)
}

// searchedCategories are the categories Find looks in: every one that holds
// content storables.
var searchedCategories = []store.Category{domain.Blocks, domain.LibraryCategory, domain.WorkingCopy}

// Find returns the .meta of every container of kind whose .meta holds each of
// face's fields with the same value, keyed by uuid, in any category and at any
// folder depth. It reads .meta only and parses no body.
func (s *BlockContainerService) Find(kind string, face map[string]string) (map[string]map[string]string, error) {
	listed, err := s.store.ListFrom(searchedCategories, "")
	if err != nil {
		return nil, fmt.Errorf("block container: find %s: %w", kind, err)
	}
	found := map[string]map[string]string{}
	for len(listed) > 0 {
		item := listed[0]
		listed = listed[1:]
		if folder, ok := item.(store.FolderStorable); ok {
			listed = append(listed, folder.Owns()...)
			continue
		}
		ms, ok := item.(store.MetaStorable)
		if !ok || ms.Type() != store.TypeBlock || ms.Meta()[store.MetaKeyKind] != kind || !s.shows(ms.Meta(), face) {
			continue
		}
		found[ms.Key()] = maps.Clone(ms.Meta())
	}
	return found, nil
}

// shows reports whether meta holds every field of face with the same value.
func (s *BlockContainerService) shows(meta, face map[string]string) bool {
	for k, v := range face {
		if got, ok := meta[k]; !ok || got != v {
			return false
		}
	}
	return true
}

// withFace returns a copy of meta carrying blk's face, for a kind that shows one.
func (s *BlockContainerService) withFace(meta map[string]string, blk block.SieveBlock) map[string]string {
	out := maps.Clone(meta)
	if bearer, ok := s.registry.Get(blk.Kind).(block.FaceBearer); ok {
		maps.Copy(out, bearer.Face(blk))
	}
	return out
}

// render produces a container's content file: the kind line, then the block's map
// through the same YAML writer the fenced form uses. An attr named like the kind
// line is refused, since the file would hold the key twice.
func (s *BlockContainerService) render(blk block.SieveBlock) ([]byte, error) {
	if _, clash := blk.Attrs[bodyKindKey]; clash {
		return nil, fmt.Errorf("block container %s: attr %q is reserved", blk.ID, bodyKindKey)
	}
	yaml, err := block.FencedSerializer{}.SerializeAttrs(blk)
	if err != nil {
		return nil, fmt.Errorf("block container %s: serialize: %w", blk.ID, err)
	}
	return []byte(bodyKindKey + ": " + blk.Kind + "\n" + yaml + "\n"), nil
}
