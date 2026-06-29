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
//   - save        → prose saves via granular block-op (raw markdown content, no
//                    markers); Go wraps in <!--s:id--> markers on its side.
//
// Depends on window.TipTap (vendor/tiptap.js) for Extension.

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
  // A TRANSIENT correlation token (not a durable id): the frontend never invents
  // durable block identity (B-A). The token rides the create-block round-trip; Go
  // mints the durable id and the insert-block ack swaps it in (editor.js).
  var mintToken = function () { return 'tok-' + Math.random().toString(16).slice(2, 10) }

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
          token: {
            default: '',
            rendered: false, // transient correlation handle: never in HTML or markdown
          },
        },
      }]
    },

    // The identity plugin (B-A / D-r.4). It is the PASSIVE half of "TipTap runs
    // the editor": PM creates/splits/merges nodes natively; we ensure each
    // content-bearing top-level prose node carries a TRANSIENT token so the block
    // observer can drive a single create-block. The plugin NEVER fills the durable
    // id — Go mints it; the insert-block ack (editor.js) swaps it in once Go acks.
    // On splitBlock (Enter), PM copies attrs so the new half is born with the
    // original's id AND token; we CLEAR the 2nd occurrence of each (never re-mint —
    // the frontend invents no durable identity); the cleared half re-acquires its
    // own token next pass → its own create round-trip. Runs in appendTransaction
    // (NOT onUpdate), history-excluded, only fills/clears attrs (creates no nodes)
    // so it converges; a runaway guard is the backstop.
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

          var isProse = window.TipTap.isNativeProseNodeName
          var ids = [], tokens = [], positions = []
          newState.doc.forEach(function (node, pos) {
            if (!isProse(node.type.name)) return // structured nodes own their id
            ids.push(node.attrs.id || '')
            tokens.push(node.attrs.token || '')
            positions.push(pos)
          })

          // Split defense: Enter copies attrs, so the new half is born with the
          // original's id AND token. CLEAR the 2nd occurrence of each (never re-mint —
          // the frontend invents no durable identity); the cleared half re-acquires a
          // fresh token below → its own create round-trip. First occurrence is kept.
          var clearId = {}, clearTok = {}
          window.TipTap.dedupeActions(ids).forEach(function (i) { clearId[i] = true })
          window.TipTap.dedupeActions(tokens).forEach(function (i) { clearTok[i] = true })

          var tr = null
          for (var idx = 0; idx < positions.length; idx++) {
            var pos = positions[idx]
            var node = newState.doc.nodeAt(pos)
            if (!node) continue
            var attrs = Object.assign({}, node.attrs)
            var changed = false
            if (clearId[idx]) { attrs.id = ''; changed = true }
            if (clearTok[idx]) { attrs.token = ''; changed = true }
            // Stamp a token on a content-bearing prose that has neither id nor token
            // (a freshly typed block). Empty surfaces stay bare (no churn); loaded /
            // acked nodes already carry an id, so they are left untouched — a LOAD
            // never triggers a create.
            if (!attrs.id && !attrs.token && node.textContent && node.textContent.length > 0) {
              attrs.token = mintToken(); changed = true
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

  var ProseBlock = {
    kind: 'prose',
    native: true,
    nodeTypes: PROSE_NODE_TYPES,
    identityAttr: 'id',
    identityExtension: BlockId,
    // load: a block's verbatim markdown → native HTML.
    fromBlock: function (b, mdRender) { return renderProseContent(proseContent(b), mdRender) },
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
    // Embed in Document: when the source is a diagram (or carries a ```mermaid fence),
    // render it to an SVG and INSERT that image entry (keeping the source). prose.Transform
    // then embeds the image (![](url)) instead of the mermaid fence. Render failure or a
    // non-diagram source → entries unchanged → the normal embed path (fence/markdown/text).
    resolveEntries: function (sourceNode, entries) {
      return T.renderMermaidSvgEntry(sourceNode, entries).then(function (svg) {
        return svg ? (entries || []).concat([svg]) : entries
      }).catch(function () {
        return entries
      })
    },
  }

  registerBlockKind(ProseBlock)

  T.ProseBlock = ProseBlock
  // Back-compat alias: editor.js adds T.BlockId to the extension list.
  T.BlockId = BlockId
})()
