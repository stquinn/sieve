package block

import (
	"strings"

	"sieve/store"
)

// AssetURLMigrator rewrites the legacy asset route (store.LegacyAssetURLPrefix,
// "/sieve/{uuid}/{filename}") baked into persisted documents to the current one
// (store.AssetURLPrefix) after #19 moved it. The rewrite rule itself
// (route shape + ident.Valid gate) lives in store.RewriteLegacyAssetURLs; this
// type owns only the walk that finds which Attrs values to hand it.
//
// Every top-level string attr is checked, rather than a per-kind key list: the
// route surfaces under different keys depending on kind (`src` for
// smart-image/attachment, `svgAsset` for diagram, inline inside `content` for a
// prose-embedded image), and a fixed key list would silently miss the next kind
// that starts carrying one. Nested values (maps, slices) are NOT walked — no
// persisted kind carries a served route below the top level today.
type AssetURLMigrator struct{}

// Migrate returns the tree with every legacy asset route rewritten to the current
// one, plus whether anything changed. The input is never mutated: undo and the
// caller's snapshot both depend on that.
func (m AssetURLMigrator) Migrate(blocks []SieveBlock) ([]SieveBlock, bool) {
	if len(blocks) == 0 {
		return blocks, false
	}
	changed := false
	out := make([]SieveBlock, len(blocks))
	for i, b := range blocks {
		if rewritten, dirty := m.rewriteAttrs(b.Attrs); dirty {
			b.Attrs = rewritten
			changed = true
		}
		out[i] = b
	}
	return out, changed
}

// rewriteAttrs returns attrs with every string value's legacy routes rewritten,
// cloning only when a rewrite is actually needed (copy-on-write mirrors
// BlockIdentityMigrator's discipline, so a clean tree produces no allocation).
func (m AssetURLMigrator) rewriteAttrs(attrs map[string]interface{}) (map[string]interface{}, bool) {
	var cloned map[string]interface{}
	for k, v := range attrs {
		s, ok := v.(string)
		if !ok || !strings.Contains(s, store.LegacyAssetURLPrefix) {
			continue
		}
		rewritten := store.RewriteLegacyAssetURLs(s)
		if rewritten == s {
			continue
		}
		if cloned == nil {
			cloned = make(map[string]interface{}, len(attrs))
			for k2, v2 := range attrs {
				cloned[k2] = v2
			}
		}
		cloned[k] = rewritten
	}
	if cloned == nil {
		return attrs, false
	}
	return cloned, true
}
