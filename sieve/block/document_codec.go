package block

import (
	"fmt"
	"strings"

	"sieve/sieve/fencedblock"
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

// Deserialize parses markdown into an ordered block slice. It splits into regions,
// asks each non-prose processor Accepts in priority order, and lets the first
// acceptor build the block(s). A run of unclaimed regions is coalesced and handed
// to prose (terminal mop-up), so a stray fence survives as verbatim prose content.
func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error) {
	regions := c.scanner().Scan(markdown)
	prose := c.registry.Get(KindProse)
	if prose == nil {
		return nil, fmt.Errorf("DocumentCodec: no prose processor registered (KindProse) — registry is misconfigured")
	}

	var out []SieveBlock
	var pending []Region
	flushProse := func() error {
		if len(pending) == 0 {
			return nil
		}
		var raw strings.Builder
		for _, r := range pending {
			raw.WriteString(r.Raw)
		}
		pending = nil
		blocks, err := prose.Deserialize(Region{Raw: raw.String()})
		if err != nil {
			return err
		}
		out = append(out, blocks...)
		return nil
	}

	for _, region := range regions {
		p := c.firstAcceptor(region)
		if p == nil {
			// No registered processor claims this region, so it is not a supported
			// structured kind: it coalesces into the terminal prose mop-up, its
			// text (including any fence) preserved verbatim. The registry is the
			// sole authority on what is structured — no kind-guessing heuristic.
			// Any future kind that registers a processor is claimed above and
			// becomes structured automatically.
			pending = append(pending, region)
			continue
		}
		if err := flushProse(); err != nil {
			return nil, err
		}
		blocks, err := p.Deserialize(region)
		if err != nil {
			return nil, err
		}
		out = append(out, blocks...)
	}
	if err := flushProse(); err != nil {
		return nil, err
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

// firstAcceptor returns the first non-prose processor (registry priority order)
// that claims the region, or nil. Prose is excluded here — it is the terminal
// mop-up, invoked explicitly by flushProse, never asked in the loop.
func (c *DocumentCodec) firstAcceptor(region Region) BlockProcessor {
	for _, p := range c.registry.Ordered() {
		if p.Mode() == BlockModeProse {
			continue
		}
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
	return serializeFencedBlock(b)
}

// serializeFencedBlock renders any block-mode kind as ```kind\n<yaml>\n```
// using the shared literal-style machinery — registry-free, so it serializes
// code, diagram, etc. uniformly without needing a BlockProcessor.
func serializeFencedBlock(b SieveBlock) (string, error) {
	body, err := fencedblock.SerializeYaml(b.Attrs)
	if err != nil {
		return "", err
	}
	return "```" + b.Kind + "\n" + body + "\n```", nil
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
