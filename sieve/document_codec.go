package sieve

import "strings"

// DocumentCodec owns BOTH directions of document SerDes. It sees only the
// registry + the BlockProcessor interface, so it CANNOT switch on kind — the
// structural guarantee inherited from the serialization half.
type DocumentCodec struct {
	registry ProcessorRegistry
	scanner  *RegionScanner
}

func NewDocumentCodec(reg ProcessorRegistry) *DocumentCodec {
	return &DocumentCodec{registry: reg, scanner: NewRegionScanner()}
}

// Deserialize parses markdown into an ordered block slice. It splits into regions,
// asks each non-prose processor Accepts in priority order, and lets the first
// acceptor build the block(s). A run of unclaimed regions is coalesced and handed
// to prose (terminal mop-up), so a stray fence survives as verbatim prose content.
func (c *DocumentCodec) Deserialize(markdown string) ([]SieveBlock, error) {
	regions := c.scanner.Scan(markdown)
	prose := c.registry.Get(KindProse)

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

func globalRegistry() ProcessorRegistry { return registryAdapter{} }
