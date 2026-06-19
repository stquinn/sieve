// block-kinds.js — the shared block-kind registry (model-layer symmetry).
//
// Every block kind — prose included — is a registered definition here, so prose
// is a first-class kind alongside code/ai/diagram/web-clip/… rather than "the one
// kind we forgot to give a renderer." A kind's definition records how it loads,
// saves, and carries identity. The ONE genuine difference between prose and the
// structured kinds is captured by a single `native` flag:
//
//   - native: true  (prose) → its content is native TipTap nodes
//     (paragraph/heading/list/table/blockquote/…); TipTap owns editing/split/merge
//     and identity rides on a `blockId` global attr. No sieve-<kind> NodeView.
//   - native: false (structured) → a sieve-<kind> atom NodeView renders a payload
//     (source/response/yaml) from its attrs; identity is the `id` attr.
//
// This registry is intentionally a pure data structure (no TipTap/DOM deps) so it
// is unit-testable and shared by both registration paths: registerSieveRenderer
// (structured) and prose-block.js (native).

var registry = {}

// registerBlockKind records a kind definition and returns it. Definitions are
// keyed by `kind`; re-registering replaces. A native definition supplies
// { native:true, nodeTypes, identityAttr, fromBlock, toMarkdown }; a structured
// one supplies { native:false, renderer }.
export function registerBlockKind(def) {
  registry[def.kind] = def
  return def
}

export function getBlockKind(kind) {
  return registry[kind] || null
}

export function listBlockKinds() {
  return Object.keys(registry)
}

// isNativeProseNodeName is the structural discriminator used by the editor wiring:
// structured sieve blocks are named `sieve-<kind>`; every other top-level node is
// a native prose node. (The registry carries the richer per-kind metadata; this is
// the fast node-name test the load/save/observe paths use.)
export function isNativeProseNodeName(name) {
  return String(name).indexOf('sieve-') !== 0
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.registerBlockKind = registerBlockKind
  window.TipTap.getBlockKind = getBlockKind
  window.TipTap.listBlockKinds = listBlockKinds
  window.TipTap.isNativeProseNodeName = isNativeProseNodeName
}
