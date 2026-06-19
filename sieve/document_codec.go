package sieve

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
