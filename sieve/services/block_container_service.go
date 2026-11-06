package services

import (
	"fmt"
	"maps"
	"sync"

	"sieve/ident"
	"sieve/logger"
	"sieve/sieve/domain"
	"sieve/store"
)

// bodyKindKey is the key of the first line of a container's content file. It is
// never an attr, so a kind whose attrs carry this key cannot be held in a container.
const bodyKindKey = "kind"

// ContainableKinds is what a container needs of the kinds of block it can hold.
// block.Registry implements it.
type ContainableKinds interface {
	// InitialAttrs returns the attrs of a fresh block of kind with the given id,
	// seeded from overrides. ok is false when no such kind exists.
	InitialAttrs(kind, id string, overrides map[string]interface{}) (attrs map[string]interface{}, ok bool)

	// Face returns the fields blk's kind shows in a container's .meta; nil for a
	// kind that shows none.
	Face(blk domain.SieveBlock) map[string]string

	// WriteMap renders blk as the YAML map a fenced block holds.
	WriteMap(blk domain.SieveBlock) (string, error)

	// ReadMap parses a YAML map into a block of kind.
	ReadMap(kind, yaml string) (domain.SieveBlock, error)
}

// ContainerChangeListener is told that a container changed behind whoever holds it
// open, so that an open session adopts what the container's owner now holds.
// editor.EditorService implements it.
type ContainerChangeListener interface {
	Refresh(uuid string) error
}

// BlockContainerService owns every store.TypeBlock storable: it is to a
// domain.BlockContainer what services.DocumentService is to a domain.Document. A
// container may be in any category; new ones are born in domain.Blocks.
type BlockContainerService struct {
	store    store.Store
	kinds    ContainableKinds
	listener ContainerChangeListener
	// writes is held while Save or SaveMeta reads a container's stored .meta and writes it.
	writes sync.Mutex
}

// NewBlockContainerService prepares the Blocks category and builds the service.
func NewBlockContainerService(st store.Store, kinds ContainableKinds) (*BlockContainerService, error) {
	if err := st.PrepareCategory(domain.Blocks); err != nil {
		return nil, err
	}
	return &BlockContainerService{store: st, kinds: kinds}, nil
}

// SetChangeListener registers who hears each successful Save and SaveMeta. It must be called
// before the service is shared: the field is read without a lock.
func (s *BlockContainerService) SetChangeListener(l ContainerChangeListener) {
	s.listener = l
}

// Create makes a new container holding a fresh block of kind, seeded by the kind's
// InitAttrs from overrides. A kind with no registered processor is an error. Its
// uuid is minted here and names its directory.
func (s *BlockContainerService) Create(kind string, overrides map[string]interface{}) (*domain.BlockContainer, error) {
	id := ident.New()
	attrs, ok := s.kinds.InitialAttrs(kind, id, overrides)
	if !ok {
		return nil, fmt.Errorf("block container: no processor for kind %q", kind)
	}
	blk := domain.NewSieveBlock(kind, id, attrs)
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
	ms, err := s.stored(uuid)
	if err != nil {
		return nil, err
	}
	return s.open(ms)
}

// Save writes the held block and its kind's face, bumping the version and
// writing a snapshot. The .meta written is the container's .meta as stored now
// with the face laid over it: every key the face does not hold is the store's,
// so what a SaveMeta wrote after c was loaded is kept, and c's own .meta gives
// only the version it was loaded at. It returns the new container; c is stale.
// store.ErrStaleStorable is surfaced.
func (s *BlockContainerService) Save(c *domain.BlockContainer) (*domain.BlockContainer, error) {
	opened, err := s.save(c)
	if err != nil {
		return nil, err
	}
	if s.listener != nil {
		if err := s.listener.Refresh(opened.UUID()); err != nil {
			logger.Warn("block container: listener could not reload", "uuid", opened.UUID(), "err", err)
		}
	}
	return opened, nil
}

// save is Save without telling the listener.
func (s *BlockContainerService) save(c *domain.BlockContainer) (*domain.BlockContainer, error) {
	body, err := s.render(c.Block())
	if err != nil {
		return nil, err
	}
	s.writes.Lock()
	defer s.writes.Unlock()
	ms := c.Storable()
	meta := maps.Clone(ms.Meta())
	if stored, err := s.stored(c.UUID()); err == nil {
		meta = maps.Clone(stored.Meta())
		meta["version"] = ms.Meta()["version"]
	}
	ms.SetMeta(s.withFace(meta, c.Block()))
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

// SaveMeta applies edit to the .meta of container uuid as it is stored now and
// writes the .meta alone: the block is not rendered, the version does not move
// and no snapshot is written. Save and SaveMeta run one at a time and each starts
// from the stored .meta, so neither loses what the other wrote. edit must not set
// the keys the store writes or the kind's face. It returns the container as
// stored after the write. The listener hears it as it hears a Save.
func (s *BlockContainerService) SaveMeta(uuid string, edit func(domain.DocumentMeta)) (*domain.BlockContainer, error) {
	saved, err := s.saveMeta(uuid, edit)
	if err != nil {
		return nil, err
	}
	if s.listener != nil {
		if err := s.listener.Refresh(uuid); err != nil {
			logger.Warn("block container: listener could not reload", "uuid", uuid, "err", err)
		}
	}
	return saved, nil
}

// saveMeta is SaveMeta without telling the listener.
func (s *BlockContainerService) saveMeta(uuid string, edit func(domain.DocumentMeta)) (*domain.BlockContainer, error) {
	s.writes.Lock()
	defer s.writes.Unlock()
	ms, err := s.stored(uuid)
	if err != nil {
		return nil, err
	}
	meta := maps.Clone(ms.Meta())
	edit(domain.NewDocumentMeta(meta, func(map[string]string) {}))
	ms.SetMeta(meta)
	if _, err := s.store.SaveMeta(ms); err != nil {
		return nil, fmt.Errorf("block container %s: save meta: %w", uuid, err)
	}
	reloaded, err := s.store.Load(ms.Category(), uuid)
	if err != nil {
		return nil, fmt.Errorf("block container %s: save meta: %w", uuid, err)
	}
	reloadedMS, ok := reloaded.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("%w: %s", domain.ErrNotBlockContainer, uuid)
	}
	return s.open(reloadedMS)
}

// stored is the storable of container uuid as the store holds it now.
func (s *BlockContainerService) stored(uuid string) (store.MetaStorable, error) {
	storable, err := s.store.LoadByUUID(uuid)
	if err != nil {
		return nil, fmt.Errorf("%w: %s: %v", domain.ErrNotBlockContainer, uuid, err)
	}
	ms, ok := storable.(store.MetaStorable)
	if !ok || ms.Type() != store.TypeBlock {
		return nil, fmt.Errorf("%w: %s", domain.ErrNotBlockContainer, uuid)
	}
	return ms, nil
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
	maps.Copy(out, s.kinds.Face(blk))
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
	parsed, err := s.kinds.ReadMap(kind, string(body))
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
	yaml, err := s.kinds.WriteMap(blk)
	if err != nil {
		return nil, fmt.Errorf("block container %s: serialize: %w", blk.ID, err)
	}
	return []byte(bodyKindKey + ": " + blk.Kind + "\n" + yaml + "\n"), nil
}
