package editor

import (
	"errors"
	"fmt"
	"io/fs"
	"strconv"

	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/sieve/services"
	"sieve/store"
)

// BlockSource is the Router's face on block containers.
//
// OFFERED = NOTHING; RESOLVED = ANY CONTAINER. A container is found through the
// business service of its kind, and a kind with none is not found, so Search
// offers nothing. Resolve dereferences one at container grain, and at
// a leaf naming the block or an asset beside it, into a descriptor whose Kind is
// the block's kind and whose Attrs carries its map.
type BlockSource struct {
	containers *services.BlockContainerService
}

// NewBlockSource builds the source over the container service.
func NewBlockSource(containers *services.BlockContainerService) *BlockSource {
	return &BlockSource{containers: containers}
}

// Name identifies this source in Router diagnostics.
func (s *BlockSource) Name() string { return "blocks" }

// Search offers nothing.
func (s *BlockSource) Search(domain.SearchCriteria) []domain.Candidate { return nil }

// Resolve loads the container an address names and dereferences the address as
// Node does. Anything that is not a block container is domain.ErrNodeNotFound.
func (s *BlockSource) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	c, err := s.containers.Load(addr.Container)
	if errors.Is(err, domain.ErrNotBlockContainer) {
		return domain.NodeDescriptor{}, fmt.Errorf("%w: %s: %v", domain.ErrNodeNotFound, addr.String(), err)
	}
	if err != nil {
		return domain.NodeDescriptor{}, err
	}
	return s.Node(addr, c)
}

// Node dereferences an address into c, the container it names, already loaded:
// at container grain c's block, live or as of the version the address pins,
// titled with what the container is called (block.Registry.ContainerName); at a
// leaf the block or an asset beside it. A version nobody wrote or a leaf c does not answer to is
// domain.ErrNodeNotFound.
func (s *BlockSource) Node(addr domain.Address, c *domain.BlockContainer) (domain.NodeDescriptor, error) {
	var err error
	blk := c.Block()
	if addr.IsPinned() {
		blk, err = s.containers.Version(c, store.VersionRef{ID: strconv.Itoa(addr.Version)})
		if errors.Is(err, fs.ErrNotExist) {
			return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, addr.String())
		}
		if err != nil {
			return domain.NodeDescriptor{}, err
		}
	}
	leaves := &containerLeaves{
		addr:     addr,
		owner:    c.Storable(),
		registry: block.GlobalRegistry(),
		blocks:   []domain.SieveBlock{blk},
	}
	if addr.IsContainer() {
		node := leaves.blockNode(blk)
		node.URI = addr.String()
		node.Title = block.GlobalRegistry().ContainerName(blk, c.Storable().Meta())
		return node, nil
	}
	return leaves.resolve()
}
