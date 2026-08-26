package block

import (
	"strconv"
	"strings"

	"sieve/ident"
	"sieve/sieve/domain"
)

// ReferenceURIMigrator rewrites a reference block's ONE address attr, `uri`, and
// folds the retired two-attr shape onto it. It MUST stay scoped to
// Kind == "reference": smart-image carries its own `src` with an unrelated
// meaning, and a kind-blind fold would read that as an unmigrated reference and
// corrupt it.
//
// Three legacy shapes converge here, all reachable only on the load path, since
// a document uuid to mint against is not available inside
// DocumentCodec.Deserialize:
//
//   - container:{u}[@v{n}] and block:{c}[@v{n}]/{h} — the dropped legacy scheme
//     spellings, rewritten to their sieve:// equivalent. A bare block:{uuid} (no
//     handle) has no sieve:// spelling and is left untouched; it resolves
//     dangling, same as it always did.
//   - src with no uri — the pre-rename "attachment" shape, folded to
//     uri: sieve://{document}/{src}. Both set: uri wins, src is dropped.
//   - a stored relative uri (/{leaf}) — nothing mints one any more (a reference
//     copied between documents must keep naming what it always named), so any
//     survivor is absolutised against the document it lives in.
type ReferenceURIMigrator struct{}

// Migrate returns the tree with every reference's uri rewritten to its current
// spelling, plus whether anything changed. The input is never mutated.
func (m ReferenceURIMigrator) Migrate(blocks []SieveBlock, documentUUID string) ([]SieveBlock, bool) {
	if len(blocks) == 0 {
		return blocks, false
	}
	changed := false
	out := make([]SieveBlock, len(blocks))
	for i, b := range blocks {
		if b.Kind == "reference" {
			if rewritten, dirty := m.migrateAttrs(b.Attrs, documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		}
		out[i] = b
	}
	return out, changed
}

// migrateAttrs folds src onto uri and rewrites uri to its current spelling,
// cloning only when a rewrite is needed, so a clean tree allocates nothing.
func (m ReferenceURIMigrator) migrateAttrs(attrs map[string]interface{}, documentUUID string) (map[string]interface{}, bool) {
	uri, _ := attrs["uri"].(string)
	src, hasSrc := attrs["src"].(string)

	newURI := uri
	dropSrc := false
	switch {
	case hasSrc && uri != "":
		// Both set: uri wins, src is retired regardless of what it said.
		dropSrc = true
	case hasSrc && src != "":
		newURI = domain.NewLeafAddress(documentUUID, src).String()
		dropSrc = true
	}

	if newURI != "" {
		if rewritten, ok := m.rewriteURI(newURI, documentUUID); ok {
			newURI = rewritten
		}
	}

	if newURI == uri && !dropSrc {
		return attrs, false
	}

	cloned := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		cloned[k] = v
	}
	if newURI != uri {
		cloned["uri"] = newURI
	}
	if dropSrc {
		delete(cloned, "src")
	}
	return cloned, true
}

// rewriteURI answers the current spelling of a stored uri, and whether it
// differs from what was stored. It tries the dropped legacy schemes first, then
// a stored relative form; a uri that is already sieve:// (or an admitted scheme
// like https://, or an unrecognised/dangling legacy form) comes back unchanged.
func (m ReferenceURIMigrator) rewriteURI(uri, documentUUID string) (string, bool) {
	if rewritten, ok := m.legacyScheme(uri); ok {
		return rewritten, true
	}
	if strings.HasPrefix(uri, "/") {
		if addr, err := domain.ResolveAddress(uri, domain.NewContainerAddress(documentUUID)); err == nil {
			return addr.String(), true
		}
	}
	return uri, false
}

// legacyScheme rewrites the two dropped scheme spellings to their sieve://
// equivalent. Neither address constructor takes a version pin, so a pinned
// address is built by setting Address.Version on the constructed value, never by
// concatenating the query string.
func (m ReferenceURIMigrator) legacyScheme(s string) (string, bool) {
	switch {
	case strings.HasPrefix(s, "container:"):
		uuid, version, ok := m.splitVersion(strings.TrimPrefix(s, "container:"))
		if !ok || !ident.Valid(uuid) {
			return "", false
		}
		addr := domain.NewContainerAddress(uuid)
		addr.Version = version
		return addr.String(), true

	case strings.HasPrefix(s, "block:"):
		cv, handle, hasSlash := strings.Cut(strings.TrimPrefix(s, "block:"), "/")
		if !hasSlash || handle == "" {
			// A bare block:{uuid} has no sieve:// spelling; leave it dangling.
			return "", false
		}
		uuid, version, ok := m.splitVersion(cv)
		if !ok || !ident.Valid(uuid) {
			return "", false
		}
		addr := domain.NewLeafAddress(uuid, handle)
		addr.Version = version
		return addr.String(), true
	}
	return "", false
}

// splitVersion peels a legacy "@v{n}" pin off a uuid segment.
func (m ReferenceURIMigrator) splitVersion(s string) (uuid string, version int, ok bool) {
	before, after, hasPin := strings.Cut(s, "@v")
	if !hasPin {
		return s, 0, true
	}
	n, err := strconv.Atoi(after)
	if err != nil || n < 1 {
		return "", 0, false
	}
	return before, n, true
}
