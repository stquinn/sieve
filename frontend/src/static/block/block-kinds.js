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
// { native:true, nodeTypes, identityAttr, fromBlock }; a structured
// one supplies { native:false, renderer }.
export function registerBlockKind(def) {
  registry[def.kind] = def
  return def
}

export function getBlockKind(kind) {
  return registry[kind] || null
}

// containsChildBlocks reports whether a node holds block-level CHILDREN (schema
// content 'block+') — a true container (ai-block, web-clip) — versus a leaf that holds
// its own text ('text*': code, diagram) or nothing (atom: smart-image). This is the
// structural signal for "a real nested child was clicked" vs "the block's own content":
// clicking content inside a container is a child (stamp parentId so an in-place
// TRANSFORM can't clobber siblings); clicking a leaf's content IS the block itself.
// Derived from the schema (the single source of truth) — no separate flag to drift.
export function containsChildBlocks(node) {
  return !!node && !node.type.isLeaf && !node.type.inlineContent
}

// getBlockBehaviour returns the object that holds a kind's behaviour hooks
// (asContentEntry, resolveEntries, …) for ANY block — uniform across native and
// structured. A native def (prose) IS its own behaviour holder; a structured def
// delegates to its `renderer`. Callers ask for "the behaviour for kind X" and never
// branch on native-vs-structured themselves — prose is a block like any other.
export function getBlockBehaviour(kind) {
  var def = registry[kind]
  if (!def) return null
  return def.native ? def : def.renderer || null
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

// proseChainHits returns the {from,to,id} ranges of the top-level NATIVE PROSE
// nodes whose id is in `ids` — the nodes the AI ref-chain hover-glow decorates.
// Structured sieve blocks are deliberately EXCLUDED: they are NodeViews whose DOM
// is opaque to ProseMirror, so ai-block-renderer's applyChain toggles their class
// via classList. A native prose <p> is owned by PM (which reverts a directly-set
// class on its next view update), so it gets `block-ref-active` via a PM
// decoration instead — and this is the pure selection that decoration is built
// from. Pure (walks the doc, no TipTap/DOM deps) so it is unit-testable.
export function proseChainHits(doc, ids) {
  var want = {}
  ;(ids || []).forEach(function (id) { if (id) want[id] = true })
  var hits = []
  doc.forEach(function (node, offset) {
    var id = node.attrs && node.attrs.id
    if (id && want[id] && isNativeProseNodeName(node.type.name)) {
      hits.push({ from: offset, to: offset + node.nodeSize, id: id })
    }
  })
  return hits
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.registerBlockKind = registerBlockKind
  window.TipTap.getBlockKind = getBlockKind
  window.TipTap.getBlockBehaviour = getBlockBehaviour
  window.TipTap.containsChildBlocks = containsChildBlocks
  window.TipTap.listBlockKinds = listBlockKinds
  window.TipTap.isNativeProseNodeName = isNativeProseNodeName
  window.TipTap.proseChainHits = proseChainHits
}
