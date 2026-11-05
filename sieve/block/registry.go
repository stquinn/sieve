package block

import "sieve/sieve/domain"

// Registry is the package-global processor registry as a value: the
// ProcessorRegistry GlobalRegistry returns, and the owner of every reading of a
// block that depends on what its kind's processor can do.
type Registry struct{}

// Get returns the registered processor for kind, or nil.
func (Registry) Get(kind string) BlockProcessor { return GetProcessor(kind) }

// Ordered returns the registered processors in registry priority order, for the
// Accepts loop.
func (Registry) Ordered() []BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]BlockProcessor, 0, len(pasteMatchers))
	for _, pm := range pasteMatchers {
		out = append(out, pm.Processor)
	}
	return out
}

// GlobalRegistry returns the package-global registry.
func GlobalRegistry() Registry { return Registry{} }

// HeldAssets returns the keys of the assets of document self that b holds:
// b's own (domain.SieveBlock.OwnHeldAssets), plus whatever its elements hold
// when its kind is a BlockParent. An asset of another document is not held.
func (r Registry) HeldAssets(b domain.SieveBlock, self domain.Address) []string {
	out := b.OwnHeldAssets(self)
	if parent, ok := r.Get(b.Kind).(BlockParent); ok {
		for _, el := range parent.Children(&b) {
			out = append(out, r.HeldAssets(*el, self)...)
		}
	}
	return out
}

// PlacesHeldAssets reports whether a placement of an asset b holds is built
// from b's own sieve view (see HeldAssetPlacer).
func (r Registry) PlacesHeldAssets(b domain.SieveBlock) bool {
	placer, ok := r.Get(b.Kind).(HeldAssetPlacer)
	return ok && placer.PlacesHeldAssets()
}

// outgoingRefs returns every in-document handle b points at, in order: the
// tokens of its `ref` attr, then the handles its elements address. container is
// the document the block lives in — the naming authority an element address is
// recognised as local against; "" claims no element edge.
func (r Registry) outgoingRefs(b domain.SieveBlock, container string) []string {
	return append(b.RefTokens(), r.elementRefs(b, container)...)
}

// elementRefs returns the handles b's elements point at. A kind whose processor
// is not a BlockParent holds no elements and answers nothing, so every other
// kind's edges are exactly its `ref` attr.
//
// KIND AND ADDRESS DECIDE, never `rel`. A document edge is ROLE-INDEPENDENT —
// what the question was about and what it was handed are equally edges of the
// block holding them — and this is the one place that must stay so: reading a
// role here would hide half a block's edges from the document that resolves
// them. An element is an edge iff it is a reference whose address names a
// LEAF of container's LIVE version: a whole-container address names a document
// rather than a block in one, a leaf elsewhere is not this document's chain, and
// a pinned address names a frozen snapshot instead of the block that is here
// now. None of those is a handle the document resolves, and `ref` is the
// document-local chain and nothing else.
func (r Registry) elementRefs(b domain.SieveBlock, container string) []string {
	parent, ok := r.Get(b.Kind).(BlockParent)
	if !ok || container == "" {
		return nil
	}
	own := domain.NewContainerAddress(container)
	var out []string
	for _, el := range parent.Children(&b) {
		if el.Kind != KindReference {
			continue
		}
		addr, err := domain.ParseAddress(el.StringAttr("uri"))
		if err != nil || addr.IsContainer() || !addr.ContainerAddress().Equal(own) {
			continue
		}
		out = append(out, addr.Leaf)
	}
	return out
}
