package block

import (
	"strings"

	"sieve/ident"
	"sieve/sieve/domain"
	"sieve/store"
)

// AssetURIMigrator rewrites served asset routes and legacy filenames in
// smart-image (src) and diagram (svgAsset) blocks down to sieve URI-references:
// the relative form `/{key}` for contained assets, and `sieve://{container}/{key}`
// for foreign cross-container references.
//
// It MUST stay gated to Kind == "smart-image" and Kind == "diagram" so it never
// collides with ReferenceMigrator or alters kinds whose payload does not denote
// a Sieve asset.
type AssetURIMigrator struct{}

// Migrate returns the tree with smart-image and diagram asset routes rewritten
// to sieve URI-references, plus whether anything changed. The input is never
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

// rewriteRef answers the canonical sieve URI-reference for ref, and whether it
// differs from the input.
func (m AssetURIMigrator) rewriteRef(ref, documentUUID string) (string, bool) {
	// 1. Current or legacy served route prefix: /ui/assets/{uuid}/{key} or /sieve/{uuid}/{key}
	for _, prefix := range [...]string{store.AssetURLPrefix, store.LegacyAssetURLPrefix} {
		if strings.HasPrefix(ref, prefix) {
			rest := strings.TrimPrefix(ref, prefix)
			uuid, filename, hasSlash := strings.Cut(rest, "/")
			if hasSlash && ident.Valid(uuid) && filename != "" {
				if ident.Canonical(uuid) == ident.Canonical(documentUUID) {
					return "/" + filename, true
				}
				return domain.NewLeafAddress(uuid, filename).String(), true
			}
		}
	}

	// 2. Self absolute address: sieve://{thisDoc}/{key} folds to relative /{key}
	if strings.HasPrefix(ref, "sieve://") {
		if addr, err := domain.ParseAddress(ref); err == nil {
			if ident.Canonical(addr.Container) == ident.Canonical(documentUUID) && addr.Leaf != "" {
				return "/" + addr.Leaf, true
			}
		}
		return ref, false
	}

	// 3. Already a relative reference: /{key}
	if strings.HasPrefix(ref, "/") {
		return ref, false
	}

	// 4. Remote URLs or inline data URIs stay untouched
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") || strings.HasPrefix(ref, "data:") {
		return ref, false
	}

	// 5. Bare filename or .assets/ prefix folds to /{key}
	filename := strings.TrimPrefix(ref, ".assets/")
	if filename != "" && !strings.Contains(filename, "/") && !strings.Contains(filename, ":") {
		return "/" + filename, true
	}

	return ref, false
}
