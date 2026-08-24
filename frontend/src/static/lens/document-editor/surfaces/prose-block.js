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
//   - identity    → the id global attr (addGlobalAttributes; here, not in a
//                    NodeView, because native nodes have no NodeView). A prose
//                    block is BORN with its durable id: the lens mints a real
//                    UUIDv7 (issue #96), because a v7 is unique without
//                    coordination and so does not need Go's permission to
//                    exist. Go validates it; Go does not mint it.
//   - load        → fromBlock: a block's markdown → native HTML (renderProseContent)
//   - save        → prose saves via granular block-op (raw markdown content, no
//                    markers); Go wraps in <!--s:id--> markers on its side.
//
// Depends on the vendor TipTap bundle (vendor/tiptap.js) for Extension.

import { renderProseContent, proseContent } from './block-render.js'
import { registerBlockKind, isNativeProseNodeName } from '../../../renderers/block-kinds.js'
import { dedupeActions } from '../block-sync.js'
import { serializeNode } from './sieve-block-extension.js'
import { Ident } from '../../../ident/ident.js'
import { T } from './tiptap-vendor.js'

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
  // — so a loaded block's id is stamped straight onto its native node and read
  // back off it. The durable identity lives in the on-disk paired markers; this
  // attr is the in-editor carrier (attrs don't survive markdown).
  //
  // The id is REAL from the first keystroke (issue #96). There is no transient
  // handle and no swap-on-ack: a UUIDv7 is unique without coordination, so a
  // block born in the editor can carry the same name Go will know it by, and the
  // create op simply states that name. Everything downstream got simpler for it —
  // data-id exists from birth (no late layout shift when an id lands), the
  // create's echo is recognised by plain id, and a node deleted mid-flight is
  // deleted by the id everyone already has.

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
              // ref-chain accent). Only a REAL block carries an id — the trailing
              // empty editing surface deliberately does not — so the two travel
              // together and there is no pending state to style differently.
              if (attrs.id) return { 'data-id': attrs.id, class: 'block-node' }
              return {}
            },
          },
        },
      }]
    },

    // The identity plugin (D-r.4). It is the PASSIVE half of "TipTap runs the
    // editor": PM creates/splits/merges nodes natively; this pass ensures each
    // REAL top-level prose block carries an id, so the block observer can drive a
    // single create-block for it. A "real block" is either a content-bearing
    // prose node OR a STRUCTURAL blank — an empty paragraph that has a
    // content-bearing block after it (the user placed it deliberately). The
    // TRAILING empty paragraph (nothing after it) is the ephemeral editing
    // surface and stays bare.
    //
    // THE SPLIT TRAP, fixed at source: PM's Enter copies the split node's attrs,
    // so the new half is born wearing the original's id. That duplicate is not
    // cleared and re-acquired later — it is RE-MINTED here, in the same pass, so
    // the doc never holds two nodes with one id for even a transaction. The
    // first occurrence keeps the id (it is the block Go already knows); every
    // later one becomes a new block with a new name.
    //
    // Runs in appendTransaction (NOT onUpdate), history-excluded, and only writes
    // attrs (it creates no nodes) so it converges; a runaway guard is the
    // backstop.
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

          // Split defense: the 2nd-and-later occurrences of a duplicated id are
          // the halves PM copied it onto. They are re-minted below; the first
          // keeps the name Go already knows.
          var reMint = {}
          dedupeActions(ids).forEach(function (i) { reMint[i] = true })

          var tr = null
          for (var idx = 0; idx < positions.length; idx++) {
            var pos = positions[idx]
            var node = newState.doc.nodeAt(pos)
            if (!node) continue
            var attrs = Object.assign({}, node.attrs)
            var changed = false
            // A REAL block with no identity gets one: a content-bearing prose node
            // OR a STRUCTURAL blank (an empty paragraph with a content-bearing
            // block after it → childIdx < lastContentIdx). Both sync through the
            // SAME create-block path as any block — no special case. The TRAILING
            // empty surface (childIdx >= lastContentIdx) stays bare. A loaded node
            // already carries its id → untouched, so a LOAD never triggers a create.
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
    // Prose is a block like any other, so it DECLARES what it opts into rather
    // than inheriting behaviour by being "the default". Surround-selection only:
    // autoclose belongs to literal source text (typing `(` mid-sentence and
    // getting `()` is the first thing anyone turns off), and `'` would fight
    // every apostrophe. Surround never indexes the block text, so it is safe
    // over marked-up ranges — it inserts around them, preserving bold/links.
    interactionPolicy: { surroundSelection: true },
    // Prose is a block, so it answers getSieveIcon like every other kind. Without
    // this it took the registry's generic fallback — the CODE icon — and any
    // surface that draws a kind marker called a paragraph a code block.
    getIcon: function () { return window.SieveIcons && window.SieveIcons.blockquote },
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
    // renderDiagramSvgEntry is diagram-renderer.js's — imported DYNAMICALLY (not a static
    // top-level import) so pulling in prose-block.js never eagerly evaluates a processor
    // module. Every processor calls registerSieveRenderer at ITS OWN top level (an
    // unconditional side effect that needs the vendor Node/mergeAttributes already on the
    // bus); a static import here would run that at prose-block.js's OWN import time — before
    // a narrow caller (e.g. a unit test importing just prose-block.js) has any vendor stub in
    // place. This mirrors the original bus read's timing: it only resolved at CALL time.
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
