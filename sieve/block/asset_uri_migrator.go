package block

import (
	"strings"

	"sieve/sieve/domain"
)

// AssetURIMigrator rewrites every asset spelling in smart-image (src),
// diagram (svgAsset) and web-clip (page) blocks — a served route, a legacy
// route, a bare or `.assets/` filename, a relative `/{key}` — to the absolute
// sieve address `sieve://{container}/{key}` it names, resolving container-less
// spellings against the document. An attr already in that form is left untouched.
//
// It MUST stay gated to Kind == "smart-image", Kind == "diagram" and
// Kind == "web-clip" so it never collides with ReferenceMigrator or alters
// kinds whose payload does not denote a Sieve asset.
type AssetURIMigrator struct{}

// Migrate returns the tree with smart-image, diagram and web-clip asset references
// rewritten to absolute sieve addresses, plus whether anything changed. The input is never
// mutated.
func (m AssetURIMigrator) Migrate(blocks []SieveBlock, documentUUID string) ([]SieveBlock, bool) {
	if len(blocks) == 0 {
		return blocks, false
	}
	changed := false
	out := make([]SieveBlock, len(blocks))
	for i, b := range blocks {
		switch b.Kind {
		case "smart-image":
			if rewritten, dirty := m.migrateAttr(b.Attrs, "src", documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		case "diagram":
			if rewritten, dirty := m.migrateAttr(b.Attrs, "svgAsset", documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		case "web-clip":
			if rewritten, dirty := m.migrateAttr(b.Attrs, "page", documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		}
		out[i] = b
	}
	return out, changed
}

// migrateAttr inspects attrs[attrKey] and rewrites it if needed, cloning only
// when dirty so an already-migrated tree allocates nothing.
func (m AssetURIMigrator) migrateAttr(attrs map[string]interface{}, attrKey, documentUUID string) (map[string]interface{}, bool) {
	raw, ok := attrs[attrKey].(string)
	if !ok || strings.TrimSpace(raw) == "" {
		return attrs, false
	}

	newRef, dirty := m.rewriteRef(strings.TrimSpace(raw), documentUUID)
	if !dirty || newRef == raw {
		return attrs, false
	}

	cloned := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		cloned[k] = v
	}
	cloned[attrKey] = newRef
	return cloned, true
}

// rewriteRef answers the absolute sieve address ref names, resolved against
// documentUUID, and whether it differs from the input. A ref that is not an
// asset reference (an http(s) URL, a data: URL) is returned unchanged.
func (m AssetURIMigrator) rewriteRef(ref, documentUUID string) (string, bool) {
	addr, err := domain.ResolveAssetReference(ref, domain.NewContainerAddress(documentUUID))
	if err != nil {
		return ref, false
	}
	canonical := addr.String()
	return canonical, ref != canonical
}
