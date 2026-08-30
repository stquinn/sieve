// block-kinds.js — the shared block-kind registry. Every block kind — prose
// included — is a registered definition here, so prose is a first-class kind
// alongside code/ai/diagram/web-clip/… A kind's definition records how it loads,
// saves and carries identity, and the ONE genuine difference between prose and
// the structured kinds is a single `native` flag:
//
//   - native: true  (prose) → its content is native TipTap nodes
//     (paragraph/heading/list/…); TipTap owns editing/split/merge and identity
//     rides on a `blockId` global attr. No sieve-<kind> NodeView.
//   - native: false (structured) → a sieve-<kind> atom NodeView renders a payload
//     (source/answer/yaml) from its attrs; identity is the `id` attr.
//
// A pure data structure (no TipTap/DOM deps), shared by both registration paths:
// registerSieveRenderer (structured) and prose-block.js (native).

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

// ── The PM-free renderer class, by kind ──────────────────────────────────────
// The look-and-feel half of the same all-blocks registry: what DRAWS a block of
// a given kind, for any consumer that has a block and no lens — a question's
// elements, a popup, a bare page. It is separate from the definition above
// because a NATIVE kind (prose) has no NodeView adapter and still has a renderer,
// and because this half must be reachable from renderers/ with no lens loaded.
//
// A kind registers a THUNK, not the class: a renderer that composes this
// registry is itself in it, and a thunk is read at draw time rather than at
// module evaluation, so the cycle that creates costs nothing.
var renderers = {}

// registerBlockRenderer records how a kind is drawn. Each renderer module calls
// it for its own kind, at the bottom of its own file, so the declaration sits
// with the class rather than in a table that can drift from it.
export function registerBlockRenderer(kind, factory) {
  renderers[kind] = factory
  return factory
}

// getBlockRenderer returns a kind's renderer CLASS, or null when nothing has
// registered one. A caller draws the miss itself — never guesses a substitute.
export function getBlockRenderer(kind) {
  var factory = renderers[kind]
  return factory ? factory() : null
}

// containsChildBlocks reports whether a node holds block-level CHILDREN (schema
// content 'block+') — a true container (ai-block, web-clip) — versus a leaf that
// holds its own text ('text*': code, diagram) or nothing (atom: smart-image).
// The structural signal for "a real nested child was clicked" vs "the block's
// own content": clicking content inside a container stamps parentId so an
// in-place TRANSFORM cannot clobber siblings. Derived from the schema, so there
// is no separate flag to drift.
export function containsChildBlocks(node) {
  return !!node && !node.type.isLeaf && !node.type.inlineContent
}

// getBlockBehaviour returns the object that holds a kind's behaviour hooks
// (asContentEntry, resolveEntries, …) for ANY block. A native def (prose) IS its
// own behaviour holder; a structured def delegates to its `renderer`. Callers
// never branch on native-vs-structured themselves.
export function getBlockBehaviour(kind) {
  var def = registry[kind]
  if (!def) return null
  return def.native ? def : def.renderer || null
}

export function listBlockKinds() {
  return Object.keys(registry)
}

// isNativeProseNodeName is the structural discriminator: structured sieve blocks
// are named `sieve-<kind>`; every other top-level node is a native prose node.
export function isNativeProseNodeName(name) {
  return String(name).indexOf('sieve-') !== 0
}

// proseChainHits returns the {from,to,id} ranges of the top-level NATIVE PROSE
// nodes whose id is in `ids` — the nodes the AI ref-chain hover-glow decorates.
// Structured sieve blocks are deliberately EXCLUDED: their DOM is opaque to
// ProseMirror and their class is toggled directly, while a native prose node is
// owned by PM (which reverts a directly-set class) and must be decorated
// instead. Pure — it walks the doc with no TipTap/DOM deps.
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

// getSieveIcon returns a kind's icon: its behaviour's getIcon() if it declares
// one, else the generic code-icon fallback.
export function getSieveIcon(kind) {
  var r = getBlockBehaviour(kind)
  if (r && typeof r.getIcon === 'function') return r.getIcon()
  return (typeof window !== 'undefined' && window.SieveIcons) ? window.SieveIcons.code : '' // fallback
}

// listInsertableKinds returns the kinds a keystroke can make from nothing —
// { kind, label, description, icon, defaults } per kind, in registration order.
// A kind is in the list because ITS RENDERER CLASS declares a static
// insertSpec(); a kind born some other way (typed, pasted, asked for) declares
// nothing and is absent. The answer therefore covers whichever renderers have
// been loaded — block-renderers.js is the manifest that loads them all.
//
// `defaults` is what the block starts as, and each entry gets its OWN copy: the
// create path adds to the attrs it is handed.
export function listInsertableKinds() {
  var insertable = []
  Object.keys(renderers).forEach(function (kind) {
    var rendererClass = getBlockRenderer(kind)
    if (!rendererClass || typeof rendererClass.insertSpec !== 'function') return
    var spec = rendererClass.insertSpec()
    insertable.push({
      kind: kind,
      label: spec.label || kind,
      description: spec.description || '',
      icon: getSieveIcon(kind) || '',
      defaults: Object.assign({}, spec.defaults),
    })
  })
  return insertable
}
