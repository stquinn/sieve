// ai-block-renderer.js — SieveBlock renderer for the ai-block kind.
import { renderMarkdown, applyHighlighting, isJobStale } from './fenced-block-base.js'

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

    nodeConfig: { atom: true, selectable: true, draggable: false },

    attrs: {
      ref:      { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
      type:     { default: 'ASK', parseHTML: function (el) { return el.getAttribute('data-type') || 'ASK' } },
      model:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-model') || null } },
      question: { default: '',    parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
      response: { default: null,  parseHTML: function (el) { return el.getAttribute('data-response') || null } },
      error:    { default: null,  parseHTML: function (el) { return el.getAttribute('data-error') || null } },
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

    makeNodeView: function (node, editor) {
      var dom = document.createElement('div')
      dom.className = 'sieve-ai-block ai-block'
      dom.contentEditable = 'false'
      dom.setAttribute('data-id', node.attrs.id || '')
      dom.setAttribute('data-ai-ref', node.attrs.ref || 'doc')

      var badge = document.createElement('span')
      badge.className = 'ai-block__badge'
      var contentEl = document.createElement('div')
      contentEl.className = 'ai-block__content'
      contentEl.style.userSelect = 'text'
      dom.appendChild(badge)
      dom.appendChild(contentEl)

      function applyChain(action) {
        var id = dom.getAttribute('data-id') || ''
        var ref = dom.getAttribute('data-ai-ref') || ''
        gatherChain(id, ref).forEach(function (cid) {
          if (cid === id) return
          var blockEl = document.querySelector('[data-id="' + cid + '"], [data-block-id="' + cid + '"]')
          if (blockEl) blockEl.classList[action]('block-ref-active')
          var aiEl = document.querySelector('.sieve-ai-block[data-id="' + cid + '"]')
          if (aiEl) aiEl.classList[action]('ai-block--chain-active')
          var wcEl = document.querySelector('.web-clip-block[data-id="' + cid + '"]')
          if (wcEl) wcEl.classList[action]('web-clip-block--chain-active')
        })
      }

      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })
      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mouseenter', function () { applyChain('add') })
      dom.addEventListener('mouseleave', function () { applyChain('remove') })

      function renderQuestion(n) {
        if (!n.attrs.question) return
        var qEl = document.createElement('div')
        qEl.className = 'ai-question'
        var qLabel = document.createElement('strong')
        qLabel.textContent = (n.attrs.type === 'EXPLAIN') ? 'Explain: ' : 'Ask: '
        qEl.appendChild(qLabel)
        qEl.appendChild(document.createTextNode(n.attrs.question))
        contentEl.appendChild(qEl)
      }

      function render(n) {
        contentEl.innerHTML = ''
        dom.setAttribute('data-id', n.attrs.id || '')
        dom.setAttribute('data-ai-ref', n.attrs.ref || 'doc')
        var status = n.attrs.status || 'PENDING'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          if (isJobStale(n.attrs.createdAt, n.attrs.id)) {
            badge.className = 'ai-block__badge ai-block__badge--error'
            badge.textContent = 'AI'
            renderQuestion(n)
            var errEl = document.createElement('p')
            errEl.className = 'ai-block__timeout'
            errEl.textContent = 'Request timed out. (Right-click to Retry)'
            contentEl.appendChild(errEl)
          } else {
            badge.className = 'ai-block__badge ai-block__badge--thinking'
            badge.textContent = 'AI'
            renderQuestion(n)
            var thinking = document.createElement('p')
            var em = document.createElement('em')
            em.textContent = '(thinking…)'
            thinking.appendChild(em)
            contentEl.appendChild(thinking)
          }
        } else if (status === 'COMPLETE') {
          badge.className = 'ai-block__badge'
          badge.textContent = 'AI'
          renderQuestion(n)
          if (n.attrs.response) {
            var responseEl = document.createElement('div')
            responseEl.className = 'ai-block__response'
            responseEl.innerHTML = renderMarkdown(n.attrs.response, editor)
            applyHighlighting(responseEl)
            contentEl.appendChild(responseEl)
          }
        } else {
          badge.className = 'ai-block__badge ai-block__badge--error'
          badge.textContent = 'AI'
          renderQuestion(n)
          var errEl2 = document.createElement('p')
          errEl2.className = 'ai-block__timeout'
          errEl2.textContent = n.attrs.error || 'Request failed. (Right-click to Retry)'
          contentEl.appendChild(errEl2)
        }
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-ai-block') return false
          node = updatedNode
          render(updatedNode)
          return true
        },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
      }
    },

    buildContextMenuItems: function (ctx) {
      var node = ctx.node, editor = ctx.editor, getPos = ctx.getPos

      function del() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      var status = node.attrs.status || 'PENDING'
      var isStale = status === 'PENDING' && isJobStale(node.attrs.createdAt, node.attrs.id)
      var isError = status === 'ERROR' || status === 'TIMEOUT' || isStale
      var isComplete = status === 'COMPLETE'

      var items = [{ type: 'header', label: node.attrs.type === 'EXPLAIN' ? 'Explain' : 'Ask AI' }]

      if (isComplete && node.attrs.response) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          var ref = (node.attrs.ref && node.attrs.ref !== 'doc')
            ? node.attrs.ref + ',' + node.attrs.id
            : node.attrs.id
          document.dispatchEvent(new CustomEvent('sieve:ai-ask', {
            detail: { precomputedCtx: { content: '', blockRef: ref, history: '', contextLabel: 'Follow-up', imageIds: [] } }
          }))
        }})
      } else {
        items.push({ type: 'divider' })
        items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          document.dispatchEvent(new CustomEvent('sieve:ai-ask'))
        }})
      }

      items.push({ icon: IC.info, label: 'Explain', action: function () {
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        document.dispatchEvent(new CustomEvent('sieve:ai-explain'))
      }})

      items.push({ type: 'divider' })
      items.push({ icon: IC.trash, label: 'Delete', action: del })
      return items
    },
  }

  T.registerSieveRenderer('ai-block', AiBlockRenderer)
})()
