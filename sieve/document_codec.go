package sieve

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
			// Fence-fallback: a fenced region with a YAML body that carries an
			// "id" field is a structured block whose kind simply has no registered
			// processor yet (e.g. column-row in Stage E). Keep it structured rather
			// than melting it into prose — mirrors serializeFencedBlock on the
			// serialize side.
			if b, ok := unclaimedFenceBlock(region); ok {
				if err := flushProse(); err != nil {
					return nil, err
				}
				out = append(out, b)
				continue
			}
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
// behaviour to the former SerializeBlockDocWithHandles, now on the codec.
func (c *DocumentCodec) Serialize(blocks []SieveBlock) (string, error) {
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.ID == "" {
			return "", fmt.Errorf("refusing to persist id-less %s block (construct via newSieveBlock)", b.Kind)
		}
		s, err := serializeBlock(b)
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

// unclaimedFenceBlock checks whether a region that has no registered processor
// is nevertheless a Sieve structured block stored in the fence-fallback format.
// It returns (block, true) when BOTH conditions hold:
//  1. region.Kind != "" — it is a fenced region, not a plain text run.
//  2. region.Body parses as YAML into a map with a non-empty string "id" value.
//
// Only when BOTH hold do we reconstruct the block; otherwise we return (_, false)
// and the caller falls through to the existing pending→prose coalesce path. That
// keeps stray language fences (```python with no YAML id) safely in prose.
//
// Tradeoff (accepted): this gate is KIND-BLIND on purpose — it cannot tell a
// processor-less Sieve kind (column-row) from a language fence whose body happens
// to be a YAML map starting with `id: <string>`, so that pathological hand-written
// fence would also be claimed as structured. The only way to disambiguate is a
// hardcoded allow-list of known kinds, which would put kind-awareness back into the
// deliberately kind-blind codec — a worse cost than this contrived edge case (which
// still round-trips byte-stable). When Stage E gives container kinds a real
// processor, they go through Accepts and this fallback narrows to true unknowns.
func unclaimedFenceBlock(region Region) (SieveBlock, bool) {
	if region.Kind == "" {
		return SieveBlock{}, false
	}
	attrs, err := fencedblock.DeserializeYaml(region.Body)
	if err != nil {
		return SieveBlock{}, false
	}
	id, _ := attrs["id"].(string)
	if id == "" {
		return SieveBlock{}, false
	}
	return newSieveBlock(region.Kind, id, "", attrs), true
}
