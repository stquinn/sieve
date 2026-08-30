// The NodeView adapter for the 'ai-block' kind. Look-and-feel — the block shell,
// the badge, this kind's stylesheet — belongs to AiBlockRenderer, which this file
// holds by composition. What lives here is everything that speaks ProseMirror or
// is cross-block: the contentDOM binding and ignoreMutation, the framework schema
// data (nodeConfig/attrs/parseAttrs/titleProvider/contentProvider, consumed by
// createSieveNode and the title/content slot seam that renders the
// question/answer into contentDOM as live PM nodes), the read-only-container
// guard plugin, and chain-glow hover (gatherChain/applyChain).

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

  // The descriptor sieve-block-extension.js's registerSieveRenderer() consumes.
  // Named distinctly from the imported AiBlockRenderer CLASS: this is the
  // PM-adapter descriptor, that is the look-and-feel class it holds.

  var AiBlockNodeView = {
    // Read-only container: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

    // The body holds the ANSWER, and an answer is a list of blocks — so its
    // content admits sieve blocks alongside native prose, exactly as the document
    // top level does. A projected element is drawn by its kind's own NodeView;
    // what makes it an ELEMENT rather than a block is that it lives here.
    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      content: '(block | sieveBlock)+'
    },

    // The title (question) and body (answer/status) are rendered by
    // AiBlockRenderer; the seam authors the projected body via fresh scratch
    // instances of it.

    getInitialContentHTML: function() { return '<p></p>' },

    attrs: {
      supportsEmbedding: { default: true },
      ref:      { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
      type:     { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-ai-type') || 'ASK' } },
      model:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-model') || null } },
      // The question is a LIST OF BLOCKS, so like attachments it rides the data-*
      // costume as JSON where the scalars around it ride as text. This parse is
      // the PM-resurrect fallback — ordinarily the renderer reads the list off the
      // block cache — and it must not lose it silently.
      question: {
        default: [],
        parseHTML: function (el) {
          try { return JSON.parse(el.getAttribute('data-question') || '[]') } catch (e) { return [] }
        }
      },
      // The answer is a list of blocks in the same encoding as the question, and
      // rides the same costume for the same reason.
      answer: {
        default: [],
        parseHTML: function (el) {
          try { return JSON.parse(el.getAttribute('data-answer') || '[]') } catch (e) { return [] }
        }
      },
      error:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-error') || null } },
      // Attachments are a LIST, so they ride the data-* costume as JSON where
      // every other attr here is a scalar. This parse is the PM-resurrect
      // fallback — ordinarily the renderer reads them off the block cache — and it
      // must not lose them silently.
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
        question: JSON.stringify(data.question || []),
        answer:   JSON.stringify(data.answer || []),
        error:    data.error    || null,
        attachments: JSON.stringify(data.attachments || []),
      }
    },

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = 'sieve-ai-block'

      // This lens CLAIMS the BODY region through the handleBuild interceptor: PM
      // owns the claimed container as its contentDOM, while the badge and title
      // still render renderer-side.
      var bodyContainer = null
      var handleBuild = function (_r, region, container) {
        if (region !== REGION.BODY) return true
        container.className = 'sieve-block__content tiptap'
        bodyContainer = container
        return false
      }
      var renderer = new AiBlockRenderer(sieveBlockFor(node, undefined, ctx && ctx.provider), ctx.provider || null, handleBuild, ctx.renderOptions)

      // Whether an attachment's target still EXISTS is the EDITOR's knowledge: it
      // holds the one cache, and that cache dying with it is what makes a reopened
      // document ask again.
      //
      // Deferred, not eager: the surface stamps sieveHost onto the pane only after
      // the pane is built, so a NodeView created during that build finds nothing
      // yet and the first update() is where it arrives.
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

      // Click-to-open on an attachment chip. Opening an address is a workspace
      // verb, so the reach lives here rather than in the renderer. The uri is
      // OPAQUE: no scheme test, no split, no pin rule — openAddress asks.
      renderer.onOpenAttachment(function (uri) {
        if (window.sieveWorkspace) window.sieveWorkspace.openAddress(uri)
      })

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
        // class set on them from outside, so their glow goes through a PM
        // decoration. Harmless no-op on the structured ids handled above.
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

    buildPlugins: function(nodeType) {
      var Plugin = T.Plugin

      function isInsideAiBlock(state, from, to) {
        var inside = false
        state.doc.nodesBetween(from, to, function(node) {
          if (node.type === nodeType) inside = true
        })
        return inside
      }

      // Whether a Backspace/Delete would EDIT an ai-block's read-only answer
      // text (block it) or remove the WHOLE block (allow it — keyboard delete is
      // the context-menu Delete, and a mistake is undoable). Only the whole-block
      // cases pass: a NodeSelection on the block, or a selection that fully
      // CONTAINS it. A partial overlap would cut into its text, so it is blocked.
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
              // blocked only when they would edit the read-only answer body.
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
