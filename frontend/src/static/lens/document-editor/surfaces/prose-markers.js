// prose-markers.js — save-direction prose handle markers (node-granular, 2026-06-19).
//
// The symmetry to Go's serializeProseBlock: each top-level prose node's CLEAN
// markdown (what serializeNode produces — native nodes never embed markers) is
// wrapped here in the paired `<!--s:ID-->…<!--/s:ID-->` delimiters so the block's
// identity survives a doc-update / save round-trip byte-for-byte. The closing tag
// is mandatory: a prose block's content can contain blank lines, so only the
// paired close unambiguously bounds it (structure comes from delimiters, never
// from blank lines). No aliases — the 2026-06-19 design cuts the prose alias path
// (split mints a fresh id; merge drops the absorbed id).

// wrapProseBlock returns one top-level prose node's markdown bracketed by its
// paired markers, or the bare content when the node has no id yet (not minted —
// Go mints on Open). Mirrors sieve/handle_anchor.go serializeProseBlock.
export function wrapProseBlock(id, content) {
  if (!id) return content
  return '<!--s:' + id + '-->\n' + content + '\n<!--/s:' + id + '-->'
}
