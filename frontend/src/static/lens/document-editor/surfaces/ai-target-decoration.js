// Ephemeral glow for the live Ask AI target. NOT a doc mutation: a single
// Decoration.node class driven by plugin state, set via meta. It is a separate
// plugin from blockChrome on purpose — it must NOT be suppressed by
// block-chrome's has-selection rule, since the target frequently IS the selection.
import { T as VENDOR } from './tiptap-vendor.js'
import { proseChainHits } from '../../../renderers/block-kinds.js'

var Extension = VENDOR.Extension
var Plugin = VENDOR.Plugin
var PluginKey = VENDOR.PluginKey
var Decoration = VENDOR.Decoration
var DecorationSet = VENDOR.DecorationSet

  var aiTargetKey = new PluginKey('aiTarget')
  // Ref-chain hover glow. A native prose <p> is owned by ProseMirror, which
  // reconciles away any class set on it from outside, so prose chain-members get
  // `block-ref-active` through a decoration rather than classList. (Structured
  // blocks are NodeViews with opaque DOM, so applyChain toggles theirs directly.)
  var refChainKey = new PluginKey('refChain')

  export var AiTargetDecoration = Extension.create({
    name: 'aiTargetDecoration',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: refChainKey,
          state: {
            init: function () { return { ids: [] } },
            apply: function (tr, prev) {
              var meta = tr.getMeta(refChainKey)
              if (meta && meta.ids) return { ids: meta.ids }
              if (meta && meta.clear) return { ids: [] }
              return prev
            },
          },
          props: {
            decorations: function (state) {
              var ps = refChainKey.getState(state)
              if (!ps || !ps.ids || !ps.ids.length) return DecorationSet.empty
              var hits = proseChainHits(state.doc, ps.ids)
              if (!hits.length) return DecorationSet.empty
              var decos = hits.map(function (h) {
                return Decoration.node(h.from, h.to, { class: 'block-ref-active' })
              })
              return DecorationSet.create(state.doc, decos)
            },
          },
        }),
        new Plugin({
          key: aiTargetKey,
          state: {
            init: function () { return { range: null } },
            apply: function (tr, prev) {
              var meta = tr.getMeta(aiTargetKey)
              if (meta && Object.prototype.hasOwnProperty.call(meta, 'range')) {
                return { range: meta.range }
              }
              if (prev.range && tr.docChanged) {
                // keep the glow valid across edits
                try {
                  return { range: { from: tr.mapping.map(prev.range.from), to: tr.mapping.map(prev.range.to) } }
                } catch (e) { return { range: null } }
              }
              return prev
            },
          },
          props: {
            decorations: function (state) {
              var ps = aiTargetKey.getState(state)
              if (!ps || !ps.range) return DecorationSet.empty
              var from = ps.range.from, to = ps.range.to
              if (to <= from) return DecorationSet.empty
              // A block target's range wraps exactly one node → node glow (box +
              // rail). A text selection is a sub-span → inline glow, so the visual
              // cue survives once the native browser selection clears on blur.
              var nodeAt = state.doc.nodeAt(from)
              var isWholeNode = nodeAt && (from + nodeAt.nodeSize === to)
              var deco = isWholeNode
                ? Decoration.node(from, to, { class: 'block-ai-target' })
                : Decoration.inline(from, to, { class: 'block-ai-target-inline' })
              return DecorationSet.create(state.doc, [deco])
            },
          },
        }),
      ]
    },
  })

  // Ref-chain glow for native prose blocks (structured blocks use classList in
  // applyChain). ids = the chain's block ids; prose members get block-ref-active.
  export var setRefChain = function (view, ids) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(refChainKey, { ids: ids || [] }))
  }
  export var clearRefChain = function (view) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(refChainKey, { clear: true }))
  }
