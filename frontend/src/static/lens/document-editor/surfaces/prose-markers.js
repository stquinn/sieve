// Save-direction prose handle markers, the symmetry to Go's serializeProseBlock:
// a prose node's CLEAN markdown is wrapped in paired `<!--s:ID-->…<!--/s:ID-->`
// delimiters so the block's identity survives a save round-trip byte-for-byte.
// The closing tag is mandatory — a prose block's content can contain blank lines,
// so only the paired close unambiguously bounds it.

// Returns the bare content when the node has no id yet; Go mints on Open.
export function wrapProseBlock(id, content) {
  if (!id) return content
  return '<!--s:' + id + '-->\n' + content + '\n<!--/s:' + id + '-->'
}
