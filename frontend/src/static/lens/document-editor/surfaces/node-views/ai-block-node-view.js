// ai-block-node-view.js — Sieve NodeView ADAPTER for the 'ai-block' kind (the
// PM half of the renderer/NodeView split; NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md
// Phase 3 / issue #46). Look-and-feel (the block shell, the badge, this
// kind's stylesheet) lives in AiBlockRenderer
// (frontend/src/static/renderers/ai-block-renderer.js — a DIFFERENT
// class). This file HOLDS an
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

import { isJobStale } from '../../../../renderers/job-status.js'
import { T } from '../tiptap-vendor.js'
import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { REGION } from '../../../../renderers/block-renderer.js'
import { setRefChain, clearRefChain } from '../ai-target-decoration.js'
import { AiBlockRenderer } from '../../../../renderers/ai-block-renderer.js'

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

  // ── AiBlockNodeView ────────────────────────────────────────────────────────
  // The registered descriptor sieve-block-extension.js's duck-typed
  // registerSieveRenderer() consumes. Named distinctly from the imported
  // AiBlockRenderer CLASS above — same word, two different layers (this is the
  // PM-adapter descriptor object; AiBlockRenderer is the look-and-feel class it
  // holds by composition) — to keep the two unambiguous in this file.

  var AiBlockNodeView = {
    // Read-only container: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      content: 'block+'
    },

    // TITLE (the question) and BODY (response/status) are rendered by
    // AiBlockRenderer now — the question via its title region, the body-markdown
    // decision via its bodyMarkdown(). The seam authors the projected body via
    // FRESH scratch AiBlockRenderer instances (contract chain of custody).

    getInitialContentHTML: function() { return '<p></p>' },

    attrs: {
      supportsEmbedding: { default: true },
      ref:      { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
      type:     { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-ai-type') || 'ASK' } },
      model:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-model') || null } },
      question: { default: '',    parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
      response: { default: null,  parseHTML: function (el) { return el.getAttribute('data-response') || null } },
      error:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-error') || null } },
      // Attachments (#74) are a LIST, so they ride the data-* costume as JSON —
      // every other attr here is a scalar String()s cleanly. The renderer reads
      // them off the ContainerTransport's block cache in the ordinary case; this is the
      // PM-resurrect fallback, and it must not lose them silently.
      attachments: {
        default: [],
        parseHTML: function (el) {
          try { return JSON.parse(el.getAttribute('data-attachments') || '[]') } catch (e) { return [] }
        }
      },
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
        attachments: JSON.stringify(data.attachments || []),
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = 'sieve-ai-block'

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). This lens CLAIMS the BODY region
      // via the handleBuild interceptor (contract: decorate · own · default):
      // PM owns the claimed container as its contentDOM while the badge/title
      // still render renderer-side; the seam authors body content via fresh
      // scratch instances. This adapter supplies PM-only/cross-block concerns.
      var bodyContainer = null
      var handleBuild = function (_r, region, container) {
        if (region !== REGION.BODY) return true
        container.className = 'sieve-block__content tiptap'
        bodyContainer = container
        return false
      }
      var renderer = new AiBlockRenderer(sieveBlockFor(node, undefined, ctx && ctx.provider), ctx.provider || null, handleBuild)

      // Whether an attachment's target still EXISTS is the EDITOR's knowledge
      // (#82): it holds the one cache, and that cache dying with it is what
      // makes a reopened document ask again. Wired here for the same reason the
      // chip click is — the adapter is the only layer that sees both sides.
      //
      // Deferred, not eager: the surface stamps sieveHost onto the pane only
      // after the pane is built, so a NodeView created during that build finds
      // nothing yet and the first update() is where it arrives.
      var addressesWired = false
      function wireAddresses() {
        var addresses = ctx && ctx.addressStatus
        if (addressesWired || !addresses) return
        addressesWired = true
        renderer.probeAttachmentsWith(addresses)
      }
      wireAddresses()

      var dom = renderer.render()
      var contentDOM = bodyContainer   // the claimed body container PM binds as its contentDOM

      // Click-to-open on an attachment chip. The RENDERER reports the address and
      // knows nothing else — opening one is a workspace verb, so the reach lives
      // here, in the adapter.
      //
      // The uri is OPAQUE: no scheme test, no split, no pin rule. The grammar is
      // Go's, and openAddress asks.
      renderer.onOpenAttachment(function (uri) {
        if (window.sieveWorkspace) window.sieveWorkspace.openAddress(uri)
      })
      // The renderer's verbs (retry) leave through the ContainerTransport, the wire
      // owner (the ai-block body is server-written — no outbound content
      // channel; issue #49 Phase 1 retired the v1 appliers).

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
        // Marks this a MIGRATED kind for the seam's branch; the seam reads
        // renderer.bodyMarkdown(attrs) to project live PM nodes into the body.
        renderer:   renderer,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode
          wireAddresses()
          renderer.update(sieveBlockFor(updatedNode, undefined, ctx && ctx.provider))  // badge + question title; body is PM's (claimed region)
          return true
        },

        ignoreMutation: function (mutation) {
          // Allow PM to handle native content
          return !contentDOM.contains(mutation.target)
        },

        destroy: function () {
          renderer.destroy()
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

  registerSieveRenderer('ai-block', AiBlockNodeView)
})()
