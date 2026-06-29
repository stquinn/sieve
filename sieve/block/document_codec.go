package block

import (
	"fmt"
	"strings"
)

// DocumentCodec owns BOTH directions of document SerDes. It sees only the
// registry + the BlockProcessor interface, so it CANNOT switch on kind — the
// structural guarantee inherited from the serialization half.
type DocumentCodec struct {
	registry ProcessorRegistry
}

func NewDocumentCodec(reg ProcessorRegistry) *DocumentCodec {
	return &DocumentCodec{registry: reg}
}

// scanner builds a RegionScanner from the registry's CURRENT shapes. Shapes are
// collected per call, NOT cached at construction: in production the codec is wired
// BEFORE the fenced processors register (service_provider builds the codec, then
// registers diagram/code/ai-block/…), so a construction-time snapshot would know
// only prose and every fence would fall through to the prose mop-up. Reading the
// live registry here keeps segmentation correct regardless of wiring order.
func (c *DocumentCodec) scanner() *RegionScanner {
	var shapes []RegionShape
	for _, p := range c.registry.Ordered() {
		if s := p.Shape(); !s.IsZero() {
			shapes = append(shapes, s)
		}
	}
	return NewRegionScanner(shapes)
}

// Deserialize parses markdown into an ordered block slice. The scanner (driven by
// the registered shapes) yields gapless regions, each already a whole unit — a
// prose <!--s:--> span arrives intact, opaque interior and all. Each region goes to
// the first processor whose Accepts claims it. The terminal prose processor sorts
// LAST (orderedProseLast), so its always-true Accepts mops up gap text and
// unsupported fences without ever shadowing a structured recogniser. No coalescing:
// the shape parser already delivers maximal units, so a prose block containing a
// fence is one region, and an unsupported fence stays inside its surrounding gap.
func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error) {
	ordered := c.orderedProseLast()
	var out []SieveBlock
	for _, region := range c.scanner().Scan(markdown) {
		p := c.firstAccepting(ordered, region)
		if p == nil {
			return nil, fmt.Errorf("DocumentCodec: no processor accepted region kind %q (prose terminal missing?)", region.Kind)
		}
		blocks, err := p.Deserialize(region)
		if err != nil {
			return nil, err
		}
		out = append(out, blocks...)
	}
	return out, nil
}

// Serialize renders the block slice to markdown by asking each block's flavour to
// serialize ITSELF — the mirror of Deserialize. The spine never decides format by
// kind. A block must carry an id (persistence-boundary invariant). Identical
// behaviour to the former shim SerializeBlockDocWithHandles, now fully on the codec.
func (c *DocumentCodec) Serialize(blocks []SieveBlock) (string, error) {
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.ID == "" {
			return "", fmt.Errorf("refusing to persist id-less %s block (construct via NewSieveBlock)", b.Kind)
		}
		s, err := c.serializeBlock(b)
		if err != nil {
			return "", err
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n"), nil
}

// orderedProseLast returns the registry's processors with the terminal prose
// (BlockModeProse) flavour moved to the end, so first-acceptor dispatch lets
// structured recognisers win and prose mops up gap text and unsupported fences.
// This is the ONLY place prose is "special" — a single ordering rule reflecting its
// genuine catch-all role, not a per-region branch.
func (c *DocumentCodec) orderedProseLast() []BlockProcessor {
	all := c.registry.Ordered()
	out := make([]BlockProcessor, 0, len(all))
	var prose []BlockProcessor
	for _, p := range all {
		if p.Mode() == BlockModeProse {
			prose = append(prose, p)
			continue
		}
		out = append(out, p)
	}
	return append(out, prose...)
}

// firstAccepting returns the first processor (in the given order) that claims the
// region, or nil.
func (c *DocumentCodec) firstAccepting(ordered []BlockProcessor, region Region) BlockProcessor {
	for _, p := range ordered {
		if p.Accepts(region) {
			return p
		}
	}
	return nil
}

// serializeBlock dispatches one block to its flavour's Serialize via the INJECTED
// registry (not the package global) — the codec is the serialization authority.
// The fence fallback covers any block-mode kind with no registered processor.
func (c *DocumentCodec) serializeBlock(b SieveBlock) (string, error) {
	if p := c.registry.Get(b.Kind); p != nil {
		return p.Serialize(b)
	}
	return FencedSerializer{}.Serialize(b)
}

// findBlockByID parses markdown and returns the SieveBlock whose ID matches id,
// or (SieveBlock{}, false) if not found. Used as a fallback in BuildContextForID
// when the document is in markdown mode and its blocks tree is not populated.
func (c *DocumentCodec) findBlockByID(markdown string, id string) (SieveBlock, bool) {
	blocks, err := c.Deserialize(markdown)
	if err != nil {
		return SieveBlock{}, false
	}
	for _, b := range blocks {
		if b.ID == id {
			return b, true
		}
	}
	return SieveBlock{}, false
}

// ProcessorRegistry is the narrow read-only seam DocumentCodec needs over the
// registry. Injecting it (rather than reaching into the package globals) lets the
// codec be tested with a fake registry — no resetRegistry() global gymnastics.
type ProcessorRegistry interface {
	Get(kind string) BlockProcessor
	Ordered() []BlockProcessor // registry priority order, for the Accepts loop
}

// registryAdapter satisfies ProcessorRegistry over the existing package-global
// registry. De-globalizing registration is a separate follow-up; this keeps the
// codec injectable today without that ripple.
type registryAdapter struct{}

func (registryAdapter) Get(kind string) BlockProcessor { return GetProcessor(kind) }

func (registryAdapter) Ordered() []BlockProcessor {
	registryMu.RLock()
	defer registryMu.RUnlock()
	out := make([]BlockProcessor, 0, len(pasteMatchers))
	for _, pm := range pasteMatchers {
		out = append(out, pm.Processor)
	}
	return out
}

func GlobalRegistry() ProcessorRegistry { return registryAdapter{} }
