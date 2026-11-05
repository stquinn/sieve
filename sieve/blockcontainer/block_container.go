// Package blockcontainer stores one block as a container of its own, beside
// documents over store.MetaStorable. It sits directly over block and store, so a
// service that creates containers does not depend on the editor.
package blockcontainer

import (
	"fmt"
	"maps"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"
)

// bodyKindKey is the key of the first line of a container's content file. It is
// never an attr, so a kind whose attrs carry this key cannot be held in a container.
const bodyKindKey = "kind"

// BlockContainerService owns every store.TypeBlock storable: it is to a
// domain.BlockContainer what services.DocumentService is to a domain.Document. A
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
func (s *BlockContainerService) Create(kind string, overrides map[string]interface{}) (*domain.BlockContainer, error) {
	processor := s.registry.Get(kind)
	if processor == nil {
		return nil, fmt.Errorf("block container: no processor for kind %q", kind)
	}
	id := ident.New()
	blk := domain.NewSieveBlock(kind, id, processor.InitAttrs(id, overrides))
	body, err := s.render(blk)
	if err != nil {
		return nil, err
	}
	meta := s.withFace(map[string]string{"uuid": id, store.MetaKeyKind: kind}, blk)
	ms, err := s.store.CreateTyped(domain.Blocks, id, store.TypeBlock, meta, body)
	if err != nil {
		return nil, fmt.Errorf("block container: create %s: %w", kind, err)
	}
	return s.open(ms)
}

// Load returns the container named by uuid. A uuid naming no container is
// ErrNotBlockContainer; a container whose body will not parse is a different
// error, so a broken file never reads as a missing one.
func (s *BlockContainerService) Load(uuid string) (*domain.BlockContainer, error) {
	storable, err := s.store.LoadByUUID(uuid)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", domain.ErrNotBlockContainer, uuid, err)
	}
	ms, ok := storable.(store.MetaStorable)
	if !ok || ms.Type() != store.TypeBlock {
		return nil, fmt.Errorf("%w: %s", domain.ErrNotBlockContainer, uuid)
	}
	return s.open(ms)
}

// Save writes the held block and its kind's face, bumping the version and
// writing a snapshot. It returns the new container; c is stale.
// store.ErrStaleStorable is surfaced.
func (s *BlockContainerService) Save(c *domain.BlockContainer) (*domain.BlockContainer, error) {
	body, err := s.render(c.Block())
	if err != nil {
		return nil, err
	}
	ms := c.Storable()
	ms.SetMeta(s.withFace(ms.Meta(), c.Block()))
	ms.SetBody(body)
	saved, err := s.store.Save(ms)
	if err != nil {
		return nil, fmt.Errorf("block container %s: save: %w", c.UUID(), err)
	}
	savedMS, ok := saved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("block container %s: save: not MetaStorable", c.UUID())
	}
	return s.open(savedMS)
}

// Delete removes the container, its history and its assets.
func (s *BlockContainerService) Delete(c *domain.BlockContainer) error {
	return s.store.Delete(c.Storable())
}

// Version reads the block as saved at ref. A version nobody wrote, or one pruned
// from history, wraps fs.ErrNotExist.
func (s *BlockContainerService) Version(c *domain.BlockContainer, ref store.VersionRef) (domain.SieveBlock, error) {
	snapshot, err := s.store.RetrieveVersion(c.Storable(), ref)
	if err != nil {
		return domain.SieveBlock{}, fmt.Errorf("block container %s: version %s: %w", c.UUID(), ref.ID, err)
	}
	return s.parse(c.Storable(), snapshot.Body)
}

// SaveAsset writes data as an asset beside the block, replacing any asset of the
// same key. The container's version does not move.
func (s *BlockContainerService) SaveAsset(c *domain.BlockContainer, assetKey string, data []byte) (store.AssetStorable, error) {
	return store.OwnedAssets{Store: s.store}.Save(c.Storable(), assetKey, data)
}

// AppendAsset appends data to an asset beside the block, creating it when
// absent, without reading or rewriting what the asset already holds. The
// container's version does not move.
func (s *BlockContainerService) AppendAsset(c *domain.BlockContainer, assetKey string, data []byte) (store.AssetStorable, error) {
	return store.OwnedAssets{Store: s.store}.Append(c.Storable(), assetKey, data)
}

// LoadAsset reads an asset the container owns.
func (s *BlockContainerService) LoadAsset(c *domain.BlockContainer, assetKey string) (store.AssetStorable, error) {
	return s.store.LoadAsset(c.Storable().Category(), c.UUID(), assetKey)
}

// DeleteAsset removes an asset the container owns. c's Assets list is stale
// afterwards; Load again to read it.
func (s *BlockContainerService) DeleteAsset(c *domain.BlockContainer, assetKey string) error {
	return s.store.DeleteAsset(c.Storable().Category(), c.UUID(), assetKey)
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
func (s *BlockContainerService) withFace(meta map[string]string, blk domain.SieveBlock) map[string]string {
	out := maps.Clone(meta)
	if bearer, ok := s.registry.Get(blk.Kind).(block.FaceBearer); ok {
		maps.Copy(out, bearer.Face(blk))
	}
	return out
}

// open reads the block out of a type: block storable's body and pairs the two.
func (s *BlockContainerService) open(ms store.MetaStorable) (*domain.BlockContainer, error) {
	blk, err := s.parse(ms, ms.Body())
	if err != nil {
		return nil, err
	}
	return domain.NewBlockContainer(ms, blk), nil
}

// parse reads content-file bytes of container ms, live or from a snapshot, into
// a block of the kind its .meta names. Bytes that name no kind, or another kind
// than .meta does, are an error. The kind line never reaches Attrs, and the
// container's uuid overrides any id the bytes carry.
func (s *BlockContainerService) parse(ms store.MetaStorable, body []byte) (domain.SieveBlock, error) {
	uuid, kind := ms.Key(), ms.Meta()[store.MetaKeyKind]
	if kind == "" {
		return domain.SieveBlock{}, fmt.Errorf("block container %s: .meta names no kind", uuid)
	}
	parsed, err := block.FencedDeserializer{Kind: kind}.DeserializeAttrs(string(body))
	if err != nil {
		return domain.SieveBlock{}, fmt.Errorf("block container %s: parse body: %w", uuid, err)
	}
	if named, _ := parsed.Attrs[bodyKindKey].(string); named != kind {
		return domain.SieveBlock{}, fmt.Errorf("block container %s: body names kind %q, .meta names %q", uuid, named, kind)
	}
	delete(parsed.Attrs, bodyKindKey)
	blk := domain.NewSieveBlock(kind, uuid, parsed.Attrs)
	blk.Aliases = parsed.Aliases
	return blk, nil
}

// render produces a container's content file: the kind line, then the block's map
// through the same YAML writer the fenced form uses. An attr named like the kind
// line is refused, since the file would hold the key twice.
func (s *BlockContainerService) render(blk domain.SieveBlock) ([]byte, error) {
	if _, clash := blk.Attrs[bodyKindKey]; clash {
		return nil, fmt.Errorf("block container %s: attr %q is reserved", blk.ID, bodyKindKey)
	}
	yaml, err := block.FencedSerializer{}.SerializeAttrs(blk)
	if err != nil {
		return nil, fmt.Errorf("block container %s: serialize: %w", blk.ID, err)
	}
	return []byte(bodyKindKey + ": " + blk.Kind + "\n" + yaml + "\n"), nil
}
