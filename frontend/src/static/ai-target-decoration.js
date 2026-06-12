// ai-target-decoration.js — AiTargetDecoration extension.
// Ephemeral glow for the live Ask AI target. NOT a doc mutation: a single
// Decoration.node class driven by plugin state, set via meta. Cleared at SEND
// when the committed == highlight / blockRef takes over. Separate plugin from
// blockChrome on purpose: it must NOT be suppressed by block-chrome's
// has-selection rule (the target frequently IS the selection).
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'
  var T = window.TipTap
  var Extension = T.Extension
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey
  var Decoration = T.Decoration
  var DecorationSet = T.DecorationSet

  var aiTargetKey = new PluginKey('aiTarget')

  var AiTargetDecoration = Extension.create({
    name: 'aiTargetDecoration',
    addProseMirrorPlugins: function () {
      return [
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

  // Imperative helpers used by editor.js.
  T.AiTargetDecoration = AiTargetDecoration
  T.setAiTargetGlow = function (view, range) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(aiTargetKey, { range: range || null }))
  }
  T.clearAiTargetGlow = function (view) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(aiTargetKey, { range: null }))
  }
})()
