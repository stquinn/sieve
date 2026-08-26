// The PROSE block kind. Its content is native TipTap nodes
// (paragraph/heading/list/table/blockquote/…) that TipTap edits, splits and
// merges itself — so prose has no NodeView and no split/merge keymap, and its
// identity rides on an `id` global attribute instead. Marked `native:true` in
// the registry; otherwise it is a block kind like any other.

import { renderProseContent, proseContent } from './block-render.js'
import { registerBlockKind, isNativeProseNodeName } from '../../../renderers/block-kinds.js'
import { dedupeActions } from '../block-sync.js'
import { serializeNode } from './sieve-block-extension.js'
import { Ident } from '../../../ident/ident.js'
import { T } from './tiptap-vendor.js'

export let BlockId
export let ProseBlock

;(function () {
  'use strict'

  // The native node types that are prose blocks. Only a TOP-LEVEL instance is a
  // block — a paragraph nested in a list, table or blockquote carries no id.
  var PROSE_NODE_TYPES = [
    'paragraph', 'heading', 'blockquote',
    'bulletList', 'orderedList', 'taskList',
    'table', 'image', 'horizontalRule', 'codeBlock',
  ]

  // The identity carrier: a global attribute (native nodes have no NodeView to
  // hold one), rendered to and parsed from `data-id`. It deliberately does not
  // emit a literal HTML `id=`, which would collide in the DOM. The durable id
  // lives in the on-disk paired markers; this attr carries it in-editor, because
  // attrs do not survive markdown. The lens mints a real UUIDv7 from the first
  // keystroke — Go validates ids, it does not mint them.

  BlockId = T.Extension.create({
    name: 'blockId',
    addGlobalAttributes: function () {
      return [{
        types: PROSE_NODE_TYPES,
        attributes: {
          id: {
            default: '',
            parseHTML: function (el) { return el.getAttribute('data-id') || '' },
            renderHTML: function (attrs) {
              // Only a real block carries an id; the trailing empty editing
              // surface deliberately does not, so the class marks exactly the blocks.
              if (attrs.id) return { 'data-id': attrs.id, class: 'block-node' }
              return {}
            },
          },
        },
      }]
    },

    // The identity pass: ensures each REAL top-level prose block carries an id,
    // so the block observer can drive a single create-block for it. A "real
    // block" is either a content-bearing prose node OR a STRUCTURAL blank — an
    // empty paragraph with a content-bearing block after it. The TRAILING empty
    // paragraph is the ephemeral editing surface and stays bare.
    //
    // THE SPLIT TRAP: PM's Enter copies the split node's attrs, so the new half
    // is born wearing the original's id. Duplicates are re-minted here in the
    // same pass, so the doc never holds two nodes with one id for even a
    // transaction; the first occurrence keeps the id Go already knows.
    //
    // Runs in appendTransaction (NOT onUpdate), history-excluded, and only writes
    // attrs (it creates no nodes) so it converges; a runaway guard is the backstop.
    addProseMirrorPlugins: function () {
      var Plugin = T.Plugin, PluginKey = T.PluginKey
      var calls = 0, last = 0
      return [new Plugin({
        key: new PluginKey('blockIdMint'),
        appendTransaction: function (trs, _oldState, newState) {
          var now = Date.now()
          if (now - last > 100) calls = 0
          last = now
          if (++calls > 100) {
            console.error('[blockId] RUNAWAY identity pass — disabling to avoid a freeze')
            return null
          }
          if (!trs.some(function (t) { return t.docChanged })) return null

          var isProse = isNativeProseNodeName
          // One walk of the top-level children: collect prose nodes for stamping,
          // and compute lastContentIdx = the index of the LAST child that is not
          // an empty prose paragraph. A blank prose BEFORE it is a structural
          // blank (a real block); one at or after it is the trailing surface.
          var ids = [], positions = [], childIdxs = []
          var lastContentIdx = -1, ci = -1
          newState.doc.forEach(function (node, pos) {
            ci++
            var emptyProse = isProse(node.type.name) && node.textContent.length === 0
            if (!emptyProse) lastContentIdx = ci
            if (!isProse(node.type.name)) return // structured nodes own their id
            ids.push(node.attrs.id || '')
            positions.push(pos)
            childIdxs.push(ci)
          })

          var reMint = {}
          dedupeActions(ids).forEach(function (i) { reMint[i] = true })

          var tr = null
          for (var idx = 0; idx < positions.length; idx++) {
            var pos = positions[idx]
            var node = newState.doc.nodeAt(pos)
            if (!node) continue
            var attrs = Object.assign({}, node.attrs)
            var changed = false
            // A loaded node already carries its id, so a LOAD never mints and
            // never triggers a create.
            var isRealBlock = (node.textContent && node.textContent.length > 0) || childIdxs[idx] < lastContentIdx
            if (reMint[idx] || (!attrs.id && isRealBlock)) {
              attrs.id = isRealBlock ? Ident.mint() : ''
              changed = true
            }
            if (changed) {
              if (!tr) tr = newState.tr
              tr.setNodeMarkup(pos, undefined, attrs)
            }
          }
          if (!tr) return null
          tr.setMeta('addToHistory', false)
          return tr
        },
      })]
    },
  })

  ProseBlock = {
    kind: 'prose',
    native: true,
    nodeTypes: PROSE_NODE_TYPES,
    identityAttr: 'id',
    identityExtension: BlockId,
    // Surround-selection only: autoclose belongs to literal source text, where a
    // `'` does not have to fight every apostrophe.
    interactionPolicy: { surroundSelection: true },
    getIcon: function () { return window.SieveIcons && window.SieveIcons.blockquote },
    fromBlock: function (b, mdRender) { return renderProseContent(proseContent(b), mdRender) },
    // A prose block's clipboard views: `sieve/prose` (so ProseProcessor claims it
    // server-side) plus plain text, both carrying the node's clean markdown.
    asContentEntry: function (node, editor) {
      var md = (serializeNode(editor, node) || '').trim()
      if (!md) return null
      return [
        { mimeType: 'sieve/prose', content: JSON.stringify({ content: md }) },
        { mimeType: 'text/plain', content: md },
      ]
    },
    // When the source is a diagram (or carries a ```mermaid fence), render it to
    // an SVG and add that image entry, keeping the source; prose.Transform then
    // embeds the image instead of the fence. Failure or a non-diagram source
    // leaves entries untouched. The diagram module is imported DYNAMICALLY: every
    // processor calls registerSieveRenderer at its own top level, which needs the
    // vendor bundle already on the bus, so a static import here would fire that at
    // prose-block.js's import time.
    resolveEntries: function (sourceNode, entries) {
      return import('./node-views/diagram-node-view.js').then(function (mod) {
        return mod.renderDiagramSvgEntry(sourceNode, entries)
      }).then(function (svg) {
        return svg ? (entries || []).concat([svg]) : entries
      }).catch(function () {
        return entries
      })
    },
  }

  registerBlockKind(ProseBlock)
})()
