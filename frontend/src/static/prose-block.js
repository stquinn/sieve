// prose-block.js — the PROSE block kind definition (node-granular, 2026-06-19).
//
// Prose is a first-class block kind, registered in the same block-kind registry
// as code/ai/diagram/web-clip/… (block-kinds.js) — restoring model-layer
// symmetry the user asked for. It differs from the structured kinds in ONE
// principled way, captured by `native:true`: its content is native TipTap nodes
// (paragraph/heading/list/table/blockquote/…) that TipTap edits/splits/merges
// natively, so it has NO sieve-<kind> NodeView and NO split/merge keymap (the
// approach reverted twice). Identity rides on a `blockId` global attribute.
//
// This module gathers the three things a block kind must provide into one place:
//   - identity    → the blockId global attr (addGlobalAttributes; here, not in a
//                    NodeView, because native nodes have no NodeView)
//   - load        → fromBlock: a block's markdown → native HTML (renderProseContent)
//   - save        → toMarkdown: one node's clean markdown → paired-delimiter block
//                    (wrapProseBlock — symmetry with Go's serializeProseBlock)
//
// Depends on window.TipTap (vendor/tiptap.js) for Extension.

import { wrapProseBlock } from './prose-markers.js'
import { renderProseContent, proseContent } from './block-render.js'
import { registerBlockKind } from './block-kinds.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // The native top-level node types that are prose blocks. Nested instances
  // (a paragraph inside a list/table/blockquote) carry an empty blockId — only
  // the doc's TOP-LEVEL nodes are treated as blocks.
  var PROSE_NODE_TYPES = [
    'paragraph', 'heading', 'blockquote',
    'bulletList', 'orderedList', 'taskList',
    'table', 'image', 'horizontalRule', 'codeBlock',
  ]

  // id: the identity carrier (D-r.7: unified blockId → id, so prose and
  // structured sieve-* blocks are both addressed by `attrs.id`). A global
  // attribute (not a NodeView attr, because native nodes have no NodeView) added
  // to the prose node types. It renders to / parses from `data-id` — a literal
  // HTML `id=` is intentionally NOT emitted, to avoid DOM duplicate-id collisions
  // — so renderBlocksIntoEditor can stamp a loaded block's id straight onto its
  // native node and topBlockTriple can read it back. The durable identity lives
  // in the on-disk paired markers; this attr is only the in-editor carrier
  // (attrs don't survive markdown).
  var mintProseId = function () { return 'pr-' + Math.random().toString(16).slice(2, 6) }

  var BlockId = T.Extension.create({
    name: 'blockId',
    addGlobalAttributes: function () {
      return [{
        types: PROSE_NODE_TYPES,
        attributes: {
          id: {
            default: '',
            parseHTML: function (el) { return el.getAttribute('data-id') || '' },
            renderHTML: function (attrs) {
              // Bind to data-id (never a literal id=); omit when empty so
              // nested/unminted nodes stay clean. Also tag top-level prose blocks
              // with the shared `block-node` class so they participate in the same
              // block styling as structured sieve blocks (rest padding + the AI
              // ref-chain-active accent/highlight) — one class hook for every block.
              return attrs.id ? { 'data-id': attrs.id, class: 'block-node' } : {}
            },
          },
        },
      }]
    },

    // The minting plugin (D-r.4). It is the PASSIVE half of "TipTap runs the
    // editor": PM creates/splits/merges nodes natively; we only ensure each
    // top-level prose node carries a UNIQUE blockId, so PM's N nodes == N blocks.
    // A node needs an id when its blockId is empty (paste, gap-cursor paragraph)
    // OR duplicated — the splitBlock attr-copy trap: Enter copies the node's
    // attrs, so the new half is born with the original's id (mintActions flags the
    // second occurrence → re-mint → original keeps its id, new half gets a fresh
    // one → exactly one create-block). Runs in appendTransaction (NOT onUpdate),
    // history-excluded, and ONLY fills ids (creates no nodes) so it converges; a
    // runaway guard is the backstop.
    addProseMirrorPlugins: function () {
      var Plugin = T.Plugin, PluginKey = T.PluginKey
      var calls = 0, last = 0
      return [new Plugin({
        key: new PluginKey('blockIdMint'),
        appendTransaction: function (trs, _oldState, newState) {
          var now = Date.now()
          if (now - last > 100) calls = 0   // edits are spaced out → reset
          last = now
          if (++calls > 100) {
            console.error('[blockId] RUNAWAY mint pass — disabling to avoid a freeze')
            return null
          }
          if (!trs.some(function (t) { return t.docChanged })) return null

          var isProse = window.TipTap.isNativeProseNodeName
          var ids = [], positions = []
          newState.doc.forEach(function (node, pos) {
            if (!isProse(node.type.name)) return   // structured nodes own their id
            ids.push(node.attrs.id || '')
            positions.push(pos)
          })
          var need = window.TipTap.mintActions(ids)
          if (!need.length) return null

          // setNodeMarkup changes attrs only (no size change) → positions are
          // stable across the loop. History-excluded so minting is never undone.
          var tr = newState.tr
          need.forEach(function (i) {
            var pos = positions[i]
            var node = newState.doc.nodeAt(pos)
            if (!node) return
            tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs, { id: mintProseId() }))
          })
          tr.setMeta('addToHistory', false)
          return tr
        },
      })]
    },
  })

  var ProseBlock = {
    kind: 'prose',
    native: true,
    nodeTypes: PROSE_NODE_TYPES,
    identityAttr: 'id',
    identityExtension: BlockId,
    // load: a block's verbatim markdown → native HTML.
    fromBlock: function (b, mdRender) { return renderProseContent(proseContent(b), mdRender) },
    // save: one top-level native node's clean markdown → paired-delimiter block.
    toMarkdown: function (id, content) { return wrapProseBlock(id, content) },
    // copy: a prose block's ContentEntry views for a slice — a `sieve/prose` view
    // (so ProseProcessor claims it server-side and creates a prose block) plus a
    // plain-text view. The content is the node's clean markdown (Go re-parses it).
    asContentEntry: function (node, editor) {
      var md = (T.serializeNode(editor, node) || '').trim()
      if (!md) return null
      return [
        { mimeType: 'sieve/prose', content: JSON.stringify({ content: md }) },
        { mimeType: 'text/plain', content: md },
      ]
    },
  }

  registerBlockKind(ProseBlock)

  T.ProseBlock = ProseBlock
  // Back-compat alias: editor.js adds T.BlockId to the extension list.
  T.BlockId = BlockId
})()
