// ai-block-renderer.js — SieveBlock renderer for the ai-block kind.
import { isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'
  var T = window.TipTap
  var IC = window.SieveIcons || {}

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

  var AiBlockRenderer = {
    nodeConfig: {
      atom: false,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false,
      content: 'block+'
    },

    // HEADER (metadata) = the question; CONTENT (data) = the response, or a
    // status line while it is not yet complete. The framework renders the header
    // as its own region with a divider, hidden when empty (an EXPLAIN has no
    // question → header collapses, no divider). The badge carries the type.
    headerProvider: 'question',
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
      type:     { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-type') || 'ASK' } },
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
        type:     data.type     || 'ASK',
        model:    data.model    || null,
        question: data.question || '',
        response: data.response || null,
        error:    data.error    || null,
      }
    },

    makeNodeView: function (node, editor, getPos) {
      var nodeTypeName = 'sieve-ai-block'
      var dom = document.createElement('div')
      dom.className = 'sieve-ai-block ai-block'
      dom.setAttribute('data-id', node.attrs.id || '')
      dom.setAttribute('data-ai-ref', node.attrs.ref || 'doc')

      var badge = document.createElement('span')
      badge.className = 'ai-block__badge'
      badge.contentEditable = 'false'

      // contentDOM holds the WHOLE composed body (question + divider + response or
      // status line) as real PM nodes, filled by the framework markdownProvider seam.
      var contentDOM = document.createElement('div')
      contentDOM.className = 'sieve-block__content tiptap' // Use tiptap class for internal styling

      dom.appendChild(badge)
      dom.appendChild(contentDOM)

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
        // PM decoration instead (T.setRefChain), so PM renders block-ref-active and
        // it survives. Harmless no-op on the structured ids handled above.
        if (T && editor && editor.view) {
          if (action === 'add' && T.setRefChain) {
            var proseIds = []
            chain.forEach(function (cid) { if (cid !== id) proseIds.push(cid) })
            T.setRefChain(editor.view, proseIds)
          } else if (T.clearRefChain) {
            T.clearRefChain(editor.view)
          }
        }
      }

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mouseenter', function () {
        if (editor.view.dom.classList.contains('has-selection')) return
        applyChain('add')
      })
      dom.addEventListener('mouseleave', function () { applyChain('remove') })

      // render maintains only the badge (the visual status indicator) and the
      // data attributes the chain-glow reads. All textual content — question,
      // response, AND the thinking/timeout/error line — is the composed body in
      // contentDOM, owned by the markdownProvider seam.
      function render(attrs) {
        dom.setAttribute('data-id', attrs.id || '')
        dom.setAttribute('data-ai-ref', attrs.ref || 'doc')
        var status = attrs.status || 'PENDING'
        var cls = 'ai-block__badge'
        if (status === 'PENDING' || status === 'DISPATCHED') {
          cls += isJobStale(attrs.createdAt, attrs.id) ? ' ai-block__badge--error' : ' ai-block__badge--thinking'
        } else if (status !== 'COMPLETE') {
          cls += ' ai-block__badge--error'
        }
        badge.className = cls
        badge.textContent = attrs.type === 'EXPLAIN' ? 'EXPLAIN' : 'ASK'
      }

      render(node.attrs)

      return {
        dom:        dom,
        contentDOM: contentDOM,

        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode
          render(node.attrs)
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
      var Plugin = window.TipTap.Plugin
      
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

  T.registerSieveRenderer('ai-block', AiBlockRenderer)
})()
