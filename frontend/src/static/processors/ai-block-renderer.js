// ai-block-renderer.js — Sieve NodeView ADAPTER for the 'ai-block' kind (the
// PM half of the renderer/NodeView split, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 3 / issue #46). Look-and-feel (the block shell, the badge, this
// kind's stylesheet) lives in AiBlockRenderer
// (frontend/src/static/block/renderers/ai-block-renderer.js — a DIFFERENT
// class, deliberately same basename, different directory). This file HOLDS an
// AiBlockRenderer instance by COMPOSITION and owns everything that genuinely
// speaks ProseMirror or is cross-block: contentDOM binding/ignoreMutation,
// the framework schema data (nodeConfig/attrs/parseAttrs/titleProvider/
// contentProvider — consumed by createSieveNode + sieve-block-extension.js's
// title/content slot seam, which does the actual question/response
// rendering into contentDOM as live PM nodes; see AiBlockRenderer's header
// comment for why that stays out of the renderer), the read-only-container
// guard plugin (isInsideAiBlock + handleTextInput/KeyDown/Paste/Drop), and
// chain-glow hover (gatherChain/applyChain) — cross-block DOM querying +
// a PM decoration for native prose peers, framework-layer material for the
// future X-D framework extraction, deliberately left untouched here.

import { isJobStale } from '../base/fenced-block-base.js'
import { T } from '../base/tiptap-vendor.js'
import { registerSieveRenderer } from '../block/sieve-block-extension.js'
import { setRefChain, clearRefChain } from '../ai/ai-target-decoration.js'
import { AiBlockRenderer } from '../block/renderers/ai-block-renderer.js'

;(function () {
  'use strict'

  function gatherChain(startId, refAttr) {
    var ids = new Set()
    function visit(id) {
      if (!id || id === 'doc' || ids.has(id)) return
      ids.add(id)
      var el = document.querySelector('.sieve-ai-block[data-id="' + id + '"]')
      if (el) {
        var refs = el.getAttribute('data-ai-ref') || ''
        refs.split(',').forEach(function (r) { visit(r.trim()) })
      }
    }
    visit(startId)
    if (refAttr) refAttr.split(',').forEach(function (r) { visit(r.trim()) })
    return ids
  }

  // ── AiBlockNodeAdapter ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes. Named distinctly from the imported
  // AiBlockRenderer CLASS above — same word, two different layers (this is the
  // PM-adapter descriptor object; AiBlockRenderer is the look-and-feel class it
  // holds by composition) — to keep the two unambiguous in this file.

  var AiBlockNodeAdapter = {
    // Read-only container: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false,
      content: 'block+'
    },

    // TITLE (metadata) = the question; CONTENT (data) = the response, or a
    // status line while it is not yet complete. The framework renders the title
    // as its own region with a divider, hidden when empty (an EXPLAIN has no
    // question → title collapses, no divider). The badge carries the type.
    titleProvider: 'question',
    contentProvider: function (a) {
      var status = a.status || 'PENDING'
      if (status === 'COMPLETE') return (a.response || '').trim()
      if (status === 'PENDING' || status === 'DISPATCHED') {
        return isJobStale(a.createdAt, a.id) ? 'Request timed out. (Right-click to Retry)' : '*(thinking…)*'
      }
      return (a.error || 'Request failed. (Right-click to Retry)').trim()
    },

    getInitialContentHTML: function() { return '<p></p>' },

    attrs: {
      supportsEmbedding: { default: true },
      ref:      { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
      type:     { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-ai-type') || 'ASK' } },
      model:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-model') || null } },
      question: { default: '',    parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
      response: { default: null,  parseHTML: function (el) { return el.getAttribute('data-response') || null } },
      error:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-error') || null } },
    },

    getIcon: function(node) { return window.SieveIcons && window.SieveIcons.sparkle },
    getFriendlyName: function(node) { return node.attrs.type == 'EXPLAIN' ? 'Explain' : 'Ask AI' },

    asContentEntry: function(node) {
      if (!node.attrs.source) return null
      return  [{ mimeType: 'text/plain', content: node.attrs.source }]
    },

    parseAttrs: function (data) {
      return {
        ref:      data.ref      || 'doc',
        // emitted as data-ai-type (buildSieveBlockHTML kebabs the key); the `type`
        // attr's parseHTML reads data-ai-type. Avoids the data-type node-marker clash.
        aiType:   data.type     || 'ASK',
        model:    data.model    || null,
        question: data.question || '',
        response: data.response || null,
        error:    data.error    || null,
      }
    },

    makeNodeView: function (node, editorPane, getPos) {
      var nodeTypeName = 'sieve-ai-block'

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). All look-and-feel (shell,
      // badge, stylesheet) is its job; this adapter only supplies PM-only
      // and cross-block concerns around it.
      var renderer = new AiBlockRenderer()
      var dom = renderer.mount(node.attrs)
      var contentDOM = renderer.contentDOM

      function applyChain(action) {
        var id = dom.getAttribute('data-id') || ''
        var ref = dom.getAttribute('data-ai-ref') || ''
        var chain = gatherChain(id, ref)
        chain.forEach(function (cid) {
          if (cid === id) return
          // Structured blocks are NodeViews — their DOM is opaque to ProseMirror,
          // so a directly-toggled class persists.
          var blockEl = document.querySelector('[data-id="' + cid + '"], [data-block-id="' + cid + '"]')
          if (blockEl) blockEl.classList[action]('block-ref-active')
          var aiEl = document.querySelector('.sieve-ai-block[data-id="' + cid + '"]')
          if (aiEl) aiEl.classList[action]('ai-block--chain-active')
          var wcEl = document.querySelector('.web-clip-block[data-id="' + cid + '"]')
          if (wcEl) wcEl.classList[action]('web-clip-block--chain-active')
        })
        // Native prose <p> blocks are owned by ProseMirror, which reverts any
        // externally-set class on its next view update. Drive their glow through a
        // PM decoration instead (setRefChain), so PM renders block-ref-active and
        // it survives. Harmless no-op on the structured ids handled above.
        if (editorPane && editorPane.view) {
          if (action === 'add') {
            var proseIds = []
            chain.forEach(function (cid) { if (cid !== id) proseIds.push(cid) })
            setRefChain(editorPane.view, proseIds)
          } else {
            clearRefChain(editorPane.view)
          }
        }
      }

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mouseenter', function () {
        if (editorPane.view.dom.classList.contains('has-selection')) return
        applyChain('add')
      })
      dom.addEventListener('mouseleave', function () { applyChain('remove') })

      return {
        dom:        dom,
        contentDOM: contentDOM,
        // Exposed so sieve-block-extension.js's title seam (syncBlockTitle)
        // can delegate to this renderer's fillTitle instead of writing
        // innerHTML itself — the body/title pull-back (DEFECT SEC-B, #48).
        renderer:   renderer,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          renderer.update(dom, updatedNode.attrs)
          // Body (attrs.response) is synced into contentDOM by the framework markdown seam.
          return true
        },

        ignoreMutation: function (mutation) {
          // Allow PM to handle native content
          return !contentDOM.contains(mutation.target)
        },
      }
    },

    // ── Plugins ───────────────────────────────────────────────────────────────

    buildPlugins: function(nodeType) {
      var Plugin = T.Plugin

      function isInsideAiBlock(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      // deleteEditsAiBody decides whether a Backspace/Delete would EDIT an ai-block's
      // read-only response text (block it) versus remove the WHOLE block (allow it —
      // the block is an atom, keyboard delete == context-menu Delete, and a mistake
      // is undoable). Delete IS a text-modifying op, so we can't just wave it through;
      // we wave through only the whole-block cases:
      //   • a NodeSelection on the block, or
      //   • a selection that fully CONTAINS the block (multi-block range).
      // A selection that overlaps the block only PARTIALLY would cut into its text —
      // that we still block.
      function deleteEditsAiBody(state) {
        var sel = state.selection
        if (sel.node && sel.node.type === nodeType) return false // whole-block NodeSelection
        var edits = false
        state.doc.descendants(function(node, pos) {
          if (node.type !== nodeType) return
          var start = pos, end = pos + node.nodeSize
          var contained = sel.from <= start && sel.to >= end       // selection swallows whole block
          var overlaps  = sel.from < end && sel.to > start          // touches the block at all
          if (overlaps && !contained) edits = true                  // partial → would edit body text
        })
        return edits
      }

      return [
        new Plugin({
          props: {
            handleTextInput: function(view, from, to, text) {
              return isInsideAiBlock(view.state, from, to)
            },
            handleKeyDown: function(view, event) {
              // Backspace/Delete: allowed to remove the whole block (undoable),
              // blocked only when they would edit the read-only response body.
              if (event.key === 'Backspace' || event.key === 'Delete') {
                return deleteEditsAiBody(view.state)
              }
              // Enter and ordinary typing would replace/insert text — never allowed
              // when the selection touches an ai-block at all.
              if (event.key === 'Enter') {
                return isInsideAiBlock(view.state, view.state.selection.from, view.state.selection.to)
              }
              if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                return isInsideAiBlock(view.state, view.state.selection.from, view.state.selection.to)
              }
              return false
            },
            handlePaste: function(view, event, slice) {
              return isInsideAiBlock(view.state, view.state.selection.from, view.state.selection.to)
            },
            handleDrop: function(view, event, slice, moved) {
              var pos = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (pos && isInsideAiBlock(view.state, pos.pos, pos.pos)) return true
              return false
            }
          }
        })
      ]
    },

    // Context label reflects whether this was an Ask or Explain block.
    // Chain resolution (following ref back to the original source) is handled by Go's RunJob.
    buildAiCtx: function (node) {
      return { contextLabel: node.attrs.type === 'EXPLAIN' ? 'Explain' : 'Ask AI' }
    },

    buildContextMenuItems: function (ctx) {
      var node = ctx.node
      var items = [{ type: 'header', label: node.attrs.type === 'EXPLAIN' ? 'Explain' : 'Ask AI' }]

      return items
    },
  }

  registerSieveRenderer('ai-block', AiBlockNodeAdapter)
})()
