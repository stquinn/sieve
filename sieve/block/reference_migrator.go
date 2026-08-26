package block

import (
	"strconv"
	"strings"

	"sieve/ident"
	"sieve/sieve/domain"
)

// ReferenceMigrator rewrites a reference block's legacy shapes to the current
// one. It MUST stay scoped to Kind == "reference": smart-image carries its own
// `src` with an unrelated meaning, and a kind-blind fold would read that as an
// unmigrated reference and corrupt it.
//
// Four legacy shapes converge here, all reachable only on the load path, since
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
//   - face attrs at root (title/summary/mime/bytes) — the pre-cache shape,
//     folded under the `cache` attr (see FoldFace).
//
// An ai-block's attachments carry the same dropped scheme spellings one attr
// deeper (`attachments[].uri`), so a second, ai-block-scoped arm rewrites those
// too — the uri rewrite only, never the src fold or the face fold.
type ReferenceMigrator struct{}

// Migrate returns the tree with every reference's uri rewritten to its current
// spelling, plus whether anything changed. The input is never mutated.
func (m ReferenceMigrator) Migrate(blocks []SieveBlock, documentUUID string) ([]SieveBlock, bool) {
	if len(blocks) == 0 {
		return blocks, false
	}
	changed := false
	out := make([]SieveBlock, len(blocks))
	for i, b := range blocks {
		switch b.Kind {
		case "reference":
			if rewritten, dirty := m.migrateAttrs(b.Attrs, documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		case "ai-block":
			if rewritten, dirty := m.migrateAttachments(b.Attrs, documentUUID); dirty {
				b.Attrs = rewritten
				changed = true
			}
		}
		out[i] = b
	}
	return out, changed
}

// migrateAttachments rewrites the legacy scheme spellings inside an ai-block's
// attachments list. Current spellings and unrecognised legacy forms leave the
// block untouched (the latter dangle, as they always did); a rewrite clones the
// attrs, never mutating the input.
func (m ReferenceMigrator) migrateAttachments(attrs map[string]interface{}, documentUUID string) (map[string]interface{}, bool) {
	list := domain.DecodeAttachments(attrs[domain.AttachmentsAttr])
	changed := false
	for i, a := range list {
		if rewritten, ok := m.rewriteURI(a.URI, documentUUID); ok {
			list[i].URI = rewritten
			changed = true
		}
	}
	if !changed {
		return attrs, false
	}
	cloned := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		cloned[k] = v
	}
	cloned[domain.AttachmentsAttr] = list.AttrValue()
	return cloned, true
}

// migrateAttrs folds src onto uri and rewrites uri to its current spelling,
// cloning only when a rewrite is needed, so a clean tree allocates nothing.
func (m ReferenceMigrator) migrateAttrs(attrs map[string]interface{}, documentUUID string) (map[string]interface{}, bool) {
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

	if newURI == uri && !dropSrc && !m.hasRootFace(attrs) {
		return attrs, false
	}

	cloned := make(map[string]interface{}, len(attrs))
	for k, v := range attrs {
		cloned[k] = v
	}
	// The fold may write into the cache map, and a shallow clone would alias the
	// input's — copy it before FoldFace touches it.
	if face, ok := cloned["cache"].(map[string]interface{}); ok {
		fc := make(map[string]interface{}, len(face))
		for k, v := range face {
			fc[k] = v
		}
		cloned["cache"] = fc
	}
	if newURI != uri {
		cloned["uri"] = newURI
	}
	if dropSrc {
		delete(cloned, "src")
	}
	m.FoldFace(cloned)
	return cloned, true
}

// hasRootFace reports a face attr still sitting at root — the pre-cache shape.
func (m ReferenceMigrator) hasRootFace(attrs map[string]interface{}) bool {
	for _, key := range [...]string{"title", "summary", "mime", "bytes"} {
		if _, ok := attrs[key]; ok {
			return true
		}
	}
	return false
}

// FoldFace moves face attrs off the root and under `cache` — the fold every
// gate applies to the pre-cache reference shape: this migrator on the load
// path, ReferenceProcessor.InitAttrs on the wire. Root attrs must mean THE
// POINTING, so the legacy keys always leave the root; an existing cache entry
// wins over a stray root value, and empty legacy values are dropped rather than
// minting an empty face. Mutates attrs (and its cache map) in place.
// Deterministic — no stamps are minted.
func (m ReferenceMigrator) FoldFace(attrs map[string]interface{}) {
	for _, key := range [...]string{"title", "summary", "mime", "bytes"} {
		v, ok := attrs[key]
		if !ok {
			continue
		}
		delete(attrs, key)
		if s, isStr := v.(string); isStr && strings.TrimSpace(s) == "" {
			continue
		}
		face, _ := attrs["cache"].(map[string]interface{})
		if face == nil {
			face = map[string]interface{}{}
			attrs["cache"] = face
		}
		if _, taken := face[key]; !taken {
			face[key] = v
		}
	}
}

// rewriteURI answers the current spelling of a stored uri, and whether it
// differs from what was stored. It tries the dropped legacy schemes first, then
// a stored relative form; a uri that is already sieve:// (or an admitted scheme
// like https://, or an unrecognised/dangling legacy form) comes back unchanged.
func (m ReferenceMigrator) rewriteURI(uri, documentUUID string) (string, bool) {
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
func (m ReferenceMigrator) legacyScheme(s string) (string, bool) {
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
func (m ReferenceMigrator) splitVersion(s string) (uuid string, version int, ok bool) {
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
