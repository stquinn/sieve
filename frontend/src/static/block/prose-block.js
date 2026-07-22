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
// Depends on the vendor TipTap bundle (vendor/tiptap.js) for Extension.

import { renderProseContent, proseContent } from './block-render.js'
import { registerBlockKind, isNativeProseNodeName } from './block-kinds.js'
import { dedupeActions } from './block-sync.js'
import { serializeNode } from './sieve-block-extension.js'
import { T } from '../editor/surfaces/tiptap-vendor.js'

// Cross-file bindings the IIFE below assigns once it runs (the sieve-block-extension
// `export let` pattern, P4.E): the definitions stay inside the IIFE (it closes over
// its privates and needs the TipTap runtime); module evaluation order guarantees
// every importer sees the assigned value.
export let BlockId
export let ProseBlock

;(function () {
  'use strict'

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
              // block-node = "this is a top-level block" (rest padding + the AI
              // ref-chain accent), independent of whether the durable id has acked yet.
              // A pending top-level block carries a transient token (nested nodes never
              // do), so style it the SAME immediately — otherwise the block padding pops
              // in ~1s later when the backend id arrives (B-A) and the layout jumps.
              // data-id is emitted only once the durable id exists (a token is not an id).
              if (attrs.id) return { 'data-id': attrs.id, class: 'block-node' }
              if (attrs.token) return { class: 'block-node' }
              return {}
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
    // the editor": PM creates/splits/merges nodes natively; we ensure each REAL
    // top-level prose block carries a TRANSIENT token so the block observer can
    // drive a single create-block. A "real block" is either a content-bearing prose
    // node OR a STRUCTURAL blank — an empty paragraph that has a content-bearing
    // block after it (the user placed it deliberately). The TRAILING empty paragraph
    // (nothing after it) is the ephemeral editing surface and stays bare. Both
    // content-bearing and structural blanks sync through the same create-block path
    // as any block — no special case. The plugin NEVER fills the durable id — Go
    // mints it; the insert-block ack (editor.js) swaps it in once Go acks.
    // On splitBlock (Enter), PM copies attrs so the new half is born with the
    // original's id AND token; we CLEAR the 2nd occurrence of each (never re-mint —
    // the frontend invents no durable identity); the cleared half re-acquires its
    // own token in the same pass → its own create round-trip. Runs in appendTransaction
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

          var isProse = isNativeProseNodeName
          // Walk every top-level child once: collect prose nodes for identity stamping,
          // and compute lastContentIdx = the index of the LAST child that is a real
          // content-bearing block (anything that is NOT an empty prose paragraph — a
          // structured block always counts). A blank prose BEFORE lastContentIdx is a
          // STRUCTURAL blank (a real block); a blank prose AT/AFTER it is the trailing
          // editing surface. This mirrors computeBlockSync (block-sync.js).
          var ids = [], tokens = [], positions = [], childIdxs = []
          var lastContentIdx = -1, ci = -1
          newState.doc.forEach(function (node, pos) {
            ci++
            var emptyProse = isProse(node.type.name) && node.textContent.length === 0
            if (!emptyProse) lastContentIdx = ci
            if (!isProse(node.type.name)) return // structured nodes own their id
            ids.push(node.attrs.id || '')
            tokens.push(node.attrs.token || '')
            positions.push(pos)
            childIdxs.push(ci)
          })

          // Split defense: Enter copies attrs, so the new half is born with the
          // original's id AND token. CLEAR the 2nd occurrence of each (never re-mint —
          // the frontend invents no durable identity); the cleared half re-acquires a
          // fresh token below → its own create round-trip. First occurrence is kept.
          var clearId = {}, clearTok = {}
          dedupeActions(ids).forEach(function (i) { clearId[i] = true })
          dedupeActions(tokens).forEach(function (i) { clearTok[i] = true })

          var tr = null
          for (var idx = 0; idx < positions.length; idx++) {
            var pos = positions[idx]
            var node = newState.doc.nodeAt(pos)
            if (!node) continue
            var attrs = Object.assign({}, node.attrs)
            var changed = false
            if (clearId[idx]) { attrs.id = ''; changed = true }
            if (clearTok[idx]) { attrs.token = ''; changed = true }
            // Stamp a token on a REAL block with no identity: a content-bearing prose OR
            // a STRUCTURAL blank (an empty paragraph with a content-bearing block after
            // it → childIdx < lastContentIdx). Both sync through the SAME create-block
            // path as any block — no special case. The TRAILING empty surface
            // (childIdx >= lastContentIdx) stays bare. Loaded/acked nodes carry an id →
            // untouched (a LOAD never triggers a create).
            var isRealBlock = (node.textContent && node.textContent.length > 0) || childIdxs[idx] < lastContentIdx
            if (!attrs.id && !attrs.token && isRealBlock) {
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

  ProseBlock = {
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
      var md = (serializeNode(editor, node) || '').trim()
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
    // renderMermaidSvgEntry is diagram-renderer.js's — imported DYNAMICALLY (not a static
    // top-level import) so pulling in prose-block.js never eagerly evaluates a processor
    // module. Every processor calls registerSieveRenderer at ITS OWN top level (an
    // unconditional side effect that needs the vendor Node/mergeAttributes already on the
    // bus); a static import here would run that at prose-block.js's OWN import time — before
    // a narrow caller (e.g. a unit test importing just prose-block.js) has any vendor stub in
    // place. This mirrors the original bus read's timing: it only resolved at CALL time.
    resolveEntries: function (sourceNode, entries) {
      return import('../editor/surfaces/node-views/diagram-node-view.js').then(function (mod) {
        return mod.renderMermaidSvgEntry(sourceNode, entries)
      }).then(function (svg) {
        return svg ? (entries || []).concat([svg]) : entries
      }).catch(function () {
        return entries
      })
    },
  }

  registerBlockKind(ProseBlock)
})()
