package editor

import (
	"fmt"
	"strings"

	"sieve/ident"
	"sieve/sieve/block"
	"sieve/sieve/domain"
	"sieve/store"
)

// assetKind is the kind an asset leaf reports, in place of the block kind a
// block reports. It is a constant, never mime.TypeByExtension, which reads the
// host's mime files and so would make one address answer differently on
// different machines.
const assetKind = "asset"

// containerLeaves answers what inside one container is named {leaf}, for every
// leaf the grammar admits: a block uuid, a block's declared alias, or an asset
// key.
//
// The answer is always a LOOKUP, never an inference from the leaf string — the
// three vocabularies are not distinguishable by shape, so each index is offered
// the same string in turn and the first hit wins.
type containerLeaves struct {
	addr     domain.Address
	doc      domain.Document
	registry block.ProcessorRegistry
	blocks   []block.SieveBlock
}

// newContainerLeaves indexes a container for leaf lookup. body must be the
// content the ADDRESS names — live, or the snapshot it pins — so a pinned leaf
// reads out of the frozen text.
//
// A body that will not parse is an error, never a dangling address: the caller
// must not report a broken document as a stale reference.
func newContainerLeaves(addr domain.Address, doc domain.Document, body string) (*containerLeaves, error) {
	registry := block.GlobalRegistry()
	blocks, err := block.NewDocumentCodec(registry).Deserialize(body)
	if err != nil {
		return nil, fmt.Errorf("container %s: parse body: %w", addr.Container, err)
	}
	return &containerLeaves{addr: addr, doc: doc, registry: registry, blocks: blocks}, nil
}

// resolve dereferences the address's leaf against the three indexes, in order:
// block id, block alias, asset key. No match is domain.ErrNodeNotFound —
// dangling is a normal state.
//
// LOOKUP ORDER DOMINATES and exact-beats-folded holds only WITHIN one lookup: a
// folded id hit outranks an exact alias hit, and either outranks an asset key.
// Case-forgiveness rescues a miss; it must never re-rank the vocabularies.
func (c *containerLeaves) resolve() (domain.NodeDescriptor, error) {
	if blk, ok := c.blockNamed(c.addr.Leaf); ok {
		return c.blockNode(blk), nil
	}
	if asset, ok := c.assetNamed(c.addr.Leaf); ok {
		return c.assetNode(asset), nil
	}
	return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, c.addr.String())
}

// blockNamed finds the block a leaf names — by primary id first, by declared
// alias second. Both lookups fold case (ids through ident.Canonical), with an
// exact match beating a folded one within each. The two lookups are ordered,
// not merged: an exact alias hit does not outrank a folded id hit.
func (c *containerLeaves) blockNamed(leaf string) (block.SieveBlock, bool) {
	var foldedID, exactAlias, foldedAlias *block.SieveBlock
	canonical := ident.Canonical(leaf)
	for i := range c.blocks {
		b := &c.blocks[i]
		if b.ID == leaf {
			return *b, true
		}
		if foldedID == nil && ident.Canonical(b.ID) == canonical {
			foldedID = b
		}
		for _, alias := range b.Aliases {
			if alias == leaf {
				if exactAlias == nil {
					exactAlias = b
				}
			} else if foldedAlias == nil && strings.EqualFold(alias, leaf) {
				foldedAlias = b
			}
		}
	}
	for _, hit := range []*block.SieveBlock{foldedID, exactAlias, foldedAlias} {
		if hit != nil {
			return *hit, true
		}
	}
	return block.SieveBlock{}, false
}

// assetNamed finds the asset a leaf names by its full key — the filename,
// extension included — folding case, exact beating folded.
//
// The pin is IGNORED: assets are immutable, so membership is judged against what
// the container owns now.
//
// The tie-break is UNDEFINED. When two keys differ only in case and the address
// matches neither exactly, the winner is whichever Owns() yields first —
// directory scan order, not a guarantee. Do not build on it; spell the key you
// mean.
func (c *containerLeaves) assetNamed(leaf string) (store.AssetStorable, bool) {
	var folded store.AssetStorable
	for _, owned := range c.doc.Storable().Owns() {
		asset, ok := owned.(store.AssetStorable)
		if !ok {
			continue
		}
		if asset.Key() == leaf {
			return asset, true
		}
		if folded == nil && strings.EqualFold(asset.Key(), leaf) {
			folded = asset
		}
	}
	return folded, folded != nil
}

// blockNode projects a block into the kind-agnostic descriptor shape. Body is
// the block's markdown representation, not its on-disk Serialize form, which
// wraps every kind in fenced YAML. A kind with no registered processor
// contributes an empty body.
func (c *containerLeaves) blockNode(b block.SieveBlock) domain.NodeDescriptor {
	body := ""
	if p := c.registry.Get(b.Kind); p != nil {
		body = p.MarkdownRepresentation(b, c.addr.Container)
	}
	return domain.NodeDescriptor{
		URI:     c.leafURI(b.ID),
		UUID:    b.ID,
		Kind:    b.Kind,
		Title:   strings.TrimSpace(b.StringAttr("title")),
		Summary: strings.TrimSpace(b.StringAttr("summary")),
		Body:    body,
	}
}

// assetNode describes an asset leaf. Its key is both its identity and its only
// name; Body stays empty, because a descriptor is text and bytes are fetched
// through the served asset URL.
func (c *containerLeaves) assetNode(a store.AssetStorable) domain.NodeDescriptor {
	return domain.NodeDescriptor{
		URI:   c.leafURI(a.Key()),
		UUID:  a.Key(),
		Kind:  assetKind,
		Title: a.Key(),
	}
}

// leafURI rebuilds the coordinate around the leaf spelling the CONTAINER holds,
// keeping the pin. It must never echo the caller's spelling: an asset key builds
// a served asset URL, which 404s in any spelling the file does not have.
func (c *containerLeaves) leafURI(leaf string) string {
	addr := c.addr
	addr.Leaf = leaf
	return addr.String()
}
