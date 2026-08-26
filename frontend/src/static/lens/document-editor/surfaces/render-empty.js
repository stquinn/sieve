// The renderBlocksIntoEditor empty-reload decision, as a pure helper.
//
// Given the PM nodes already built from the block list, the call-site opts and
// the schema, returns either the replacement Node[] or null — the sentinel
// meaning "keep existing content, skip the replace":
//   nodes.length > 0                → nodes as-is (normal replace)
//   nodes.length === 0 + allowEmpty  → [empty paragraph] (genuine clear)
//   nodes.length === 0 + !allowEmpty → null (parse failure / transient empty)
//
// `allowEmpty` belongs to the whole-container repaint alone — the one caller that
// legitimately receives [] for a genuinely empty document. Every other caller
// leaves it absent, so a transient empty keeps the existing surface.
export function reloadReplacement(nodes, opts, schema) {
  if (nodes.length > 0) {
    return nodes
  }
  if (opts && opts.allowEmpty) {
    return [schema.nodes.paragraph.create()]
  }
  return null
}
