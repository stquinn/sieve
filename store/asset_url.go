package store

import (
	"regexp"
	"strings"

	"sieve/ident"
)

// AssetURLPrefix is the served-route prefix every FileStore-minted asset
// ExternalRef carries: an asset lives at AssetURLPrefix + {docUUID} + "/" +
// {filename}, routed by requesthandlers/asset_handler.go. AssetURL is the only
// place that concatenation happens — every caller that needs a served asset
// route builds it there, never by hand.
const AssetURLPrefix = "/ui/assets/"

// LegacyAssetURLPrefix was AssetURLPrefix before the route moved (#19).
// It is never minted anymore, but documents saved before the move still carry
// it verbatim in Attrs and prose content, so matchers must still recognise it
// and RewriteLegacyAssetURLs rewrites it forward on load.
const LegacyAssetURLPrefix = "/sieve/"

// AssetURL builds the served route for the asset named filename inside
// document uuid. It is the ONE place this concatenation happens — every other
// site that needs a served asset URL calls this instead of spelling the
// prefix + uuid + "/" + filename shape itself.
func AssetURL(uuid, filename string) string {
	return AssetURLPrefix + uuid + "/" + filename
}

// ContainsAssetURL reports whether s embeds a served asset route — current or
// legacy. Persisted content can predate the #19 route move, so a
// matcher that only recognised AssetURLPrefix would treat a pre-migration
// document's images as unrecognised URLs rather than local asset references.
func ContainsAssetURL(s string) bool {
	return strings.Contains(s, AssetURLPrefix) || strings.Contains(s, LegacyAssetURLPrefix)
}

// legacyAssetRoute matches the legacy asset ROUTE SHAPE — prefix, uuid segment,
// slash — never the bare prefix. Anchoring on the shape is what keeps
// RewriteLegacyAssetURLs off authored content: "/sieve/" alone occurs in Go
// import paths (`sieve/sieve/block`), in this project's own repo URLs
// (`…/stephen/sieve/issues/19`) and in any absolute path under the checkout, all
// of which a bare prefix replace would silently corrupt inside a code block or a
// line of prose. The 36-char class is only a cheap pre-filter; ident.Valid is the
// real gate (see RewriteLegacyAssetURLs).
var legacyAssetRoute = regexp.MustCompile(regexp.QuoteMeta(LegacyAssetURLPrefix) + `([0-9a-fA-F-]{36})/`)

// RewriteLegacyAssetURLs moves every legacy asset route in s forward to the
// current one, leaving everything else — including a "/sieve/" that is part of
// an import path, a URL or a filesystem path — byte-identical. A candidate is
// only rewritten when its uuid segment is one Sieve could have minted
// (ident.Valid), so the 36-char pre-filter cannot promote arbitrary text into a
// route.
func RewriteLegacyAssetURLs(s string) string {
	return legacyAssetRoute.ReplaceAllStringFunc(s, func(match string) string {
		uuid := match[len(LegacyAssetURLPrefix) : len(match)-1]
		if !ident.Valid(uuid) {
			return match
		}
		return AssetURLPrefix + uuid + "/"
	})
}
