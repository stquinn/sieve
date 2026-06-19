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
import { renderProseContent } from './block-render.js'
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

  // blockId: the identity carrier. A global attribute (not a NodeView attr,
  // because native nodes have no NodeView) added to the prose node types. It
  // renders to / parses from `data-id`, so renderBlocksIntoEditor can stamp a
  // loaded block's id straight onto its native node and topBlockTriple can read
  // it back. The durable identity lives in the on-disk paired markers; this attr
  // is only the in-editor carrier (attrs don't survive markdown).
  var BlockId = T.Extension.create({
    name: 'blockId',
    addGlobalAttributes: function () {
      return [{
        types: PROSE_NODE_TYPES,
        attributes: {
          blockId: {
            default: '',
            parseHTML: function (el) { return el.getAttribute('data-id') || '' },
            renderHTML: function (attrs) {
              // Omit data-id when empty so nested/unminted nodes stay clean.
              return attrs.blockId ? { 'data-id': attrs.blockId } : {}
            },
          },
        },
      }]
    },
  })

  var ProseBlock = {
    kind: 'prose',
    native: true,
    nodeTypes: PROSE_NODE_TYPES,
    identityAttr: 'blockId',
    identityExtension: BlockId,
    // load: a block's verbatim markdown → native HTML.
    fromBlock: function (b, mdRender) { return renderProseContent((b && b.content) || '', mdRender) },
    // save: one top-level native node's clean markdown → paired-delimiter block.
    toMarkdown: function (id, content) { return wrapProseBlock(id, content) },
  }

  registerBlockKind(ProseBlock)

  T.ProseBlock = ProseBlock
  // Back-compat alias: editor.js adds T.BlockId to the extension list.
  T.BlockId = BlockId
})()
