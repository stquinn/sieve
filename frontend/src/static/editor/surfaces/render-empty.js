// render-empty.js — pure helper for the renderBlocksIntoEditor empty-reload decision.
//
// Extracted as a separate ES module (not inline in the IIFE editor.js) so that
// vitest can import and unit-test it without a live editor or DOM.

// NOTE: no bare-specifier imports — this file is served raw from /ui/static/ with no
// bundler or import-map. Fragment is intentionally NOT imported; replaceWith()
// already accepts a node array directly, so no Fragment wrapper is needed.

// reloadReplacement: given the PM nodes already built from the block list, the
// call-site opts, and the schema, returns either:
//   Node[]  — the replacement content (array) to apply to the editor document
//   null    — sentinel meaning "keep existing content; caller skips the replace"
//
// Decision table:
//   nodes.length > 0              → nodes array as-is (normal replace)
//   nodes.length === 0 + allowEmpty → [empty paragraph] (genuine clear)
//   nodes.length === 0 + !allowEmpty → null (parse-failure / transient empty → keep)
//
// "allowEmpty" is set only by softReloadContent — the caller that legitimately
// receives [] when the document is genuinely empty (user deleted all content,
// AI resolves to empty, version restore to an empty version). All other callers
// leave the flag absent so a transient empty keeps the existing surface.
export function reloadReplacement(nodes, opts, schema) {
  if (nodes.length > 0) {
    return nodes
  }
  if (opts && opts.allowEmpty) {
    return [schema.nodes.paragraph.create()]
  }
  return null
}
