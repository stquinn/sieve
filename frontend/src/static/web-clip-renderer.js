// web-clip-renderer.js — Web Clip block renderer.
// Registers window.TipTap.registerSieveRenderer('web-clip', WebClipRenderer)

import { renderMarkdown, applyHighlighting, isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  function isStale(createdAt, id) {
    return isJobStale(createdAt, id)
  }

  function makeRetryBtn(blkId) {
    var btn = document.createElement('button')
    btn.className = 'web-clip-block__retry'
    btn.textContent = 'Retry'
    btn.addEventListener('click', function () {
      document.dispatchEvent(new CustomEvent('sieve:block-retry', {
        detail: { id: blkId }
      }))
    })
    return btn
  }

  // Returns a human-readable summary of a web-clip node for AI context (Rule 14).
  function webClipSummary(n) {
    var parts = []
    if (n.attrs.title)   parts.push('**' + n.attrs.title + '**')
    if (n.attrs.source)  parts.push('Source: ' + n.attrs.source)
    if (n.attrs.content) parts.push(n.attrs.content.trim())
    return parts.join('\n\n')
  }

  var WebClipRenderer = {
    nodeConfig: {
      atom: true,
      selectable: true,
      draggable: false
    },

    attrs: {
      source:      { default: '',      parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      title:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-title')        || null } },
      mode:        { default: 'fetch', parseHTML: function (el) { return el.getAttribute('data-mode')         || 'fetch' } },
      model:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-model')        || null } },
      completedAt: { default: null,    parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      content:     { default: null,    parseHTML: function (el) { return el.getAttribute('data-content')      || null } },
      error:       { default: null,    parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        source:      data.source      || '',
        title:       data.title       || null,
        mode:        data.mode        || 'fetch',
        model:       data.model       || null,
        completedAt: data.completedAt || null,
        content:     data.content     || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editor) {

      var dom = document.createElement('div')
      dom.className = 'web-clip-block'
      dom.contentEditable = 'false'
      dom.setAttribute('draggable', 'false')
      dom.setAttribute('data-wc-id', node.attrs.id || '')
      dom.style.userSelect = 'text'

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

      // Reverse chain highlight: when hovering the web-clip, light up any AI blocks
      // that reference it via data-ai-ref. Forward direction (AI → web-clip) is in ai-block-extension.js.
      function applyReverseChain(action) {
        var id = dom.getAttribute('data-wc-id') || ''
        if (!id) return
        document.querySelectorAll('.ai-block').forEach(function (el) {
          var refs = (el.getAttribute('data-ai-ref') || '').split(',').map(function (r) { return r.trim() })
          if (refs.indexOf(id) !== -1) el.classList[action]('ai-block--chain-active')
        })
      }
      dom.addEventListener('mouseenter', function () { applyReverseChain('add') })
      dom.addEventListener('mouseleave', function () { applyReverseChain('remove') })

      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-wc-id', n.attrs.id || '')
        
        var outerBadge = document.createElement('span')
        outerBadge.className = 'web-clip-block__badge'
        outerBadge.textContent = 'WEB CLIP'
        dom.appendChild(outerBadge)

        var attrs = n.attrs
        var status = attrs.status || 'PENDING'
        var domain = attrs.source || ''
        var modeLabel = attrs.mode === 'summarise' ? 'Summarising' : 'Fetching'
        var completeModeLabel = attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'

        var header = document.createElement('div')
        header.className = 'web-clip-block__header'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          var stale = isStale(attrs.createdAt, attrs.id)
          if (stale) {
            header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--warn">⚠</span>' +
              '<span class="web-clip-block__label">' + modeLabel.replace('ing', '') + ' interrupted — ' + domain + '</span>'
            dom.appendChild(header)
            dom.appendChild(makeRetryBtn(attrs.id))
          } else {
            header.innerHTML = '<span class="web-clip-block__spinner"></span>' +
              '<span class="web-clip-block__label">' + modeLabel + ' from ' + domain + '…</span>'
            dom.appendChild(header)
          }

        } else if (status === 'COMPLETE') {
          var statusEl = document.createElement('span')
          statusEl.className = 'web-clip-block__status'
          statusEl.textContent = completeModeLabel + ' — '
          header.appendChild(statusEl)
          var srcLink = document.createElement('a')
          srcLink.className = 'web-clip-block__source-link'
          srcLink.href = attrs.source || ''
          srcLink.textContent = attrs.source || domain
          srcLink.target = '_blank'
          srcLink.rel = 'noopener noreferrer'
          header.appendChild(srcLink)
          if (attrs.title) {
            var titleEl = document.createElement('span')
            titleEl.className = 'web-clip-block__title'
            titleEl.textContent = attrs.title
            header.appendChild(titleEl)
          }
          dom.appendChild(header)
          if (attrs.content) {
            var contentEl = document.createElement('div')
            contentEl.className = 'web-clip-block__content'
            contentEl.innerHTML = renderMarkdown(attrs.content, editor)
            applyHighlighting(contentEl)
            dom.appendChild(contentEl)
          }

        } else if (status === 'TIMEOUT') {
          header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--warn">⚠</span>' +
            '<span class="web-clip-block__label">Timed out — ' + domain + '</span>'
          dom.appendChild(header)
          dom.appendChild(makeRetryBtn(attrs.id))

        } else if (status === 'ERROR') {
          var errMsg = (attrs.error || 'Unknown error').trim()
          header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--error">✕</span>' +
            '<span class="web-clip-block__label">' + errMsg + '</span>'
          dom.appendChild(header)
          dom.appendChild(makeRetryBtn(attrs.id))
        }
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-web-clip') return false
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

    buildContextMenuItems: function ({ node, editor, getPos }) {
      function yaml() {
        return node.attrs.serialisedForm || ''
      }

      function del() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      function promoteWebClip() {
        var content = (node.attrs.content || '').trim()
        if (!content) return
        var html = editor.storage.markdown.parser.md.render(content)
        var pos = getPos()
        editor.commands.insertContentAt({ from: pos, to: pos + node.nodeSize }, html + '<p></p>')
      }

      var status = node.attrs.status || 'PENDING'
      var isComplete = status === 'COMPLETE'

      var domain = ''
      try { domain = new URL(node.attrs.source || '').hostname } catch (_) { domain = node.attrs.source || '' }
      var modeLabel = node.attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'
      var headerLabel = isComplete ? (modeLabel + ' from ' + domain) : domain

      var IC = window.SieveIcons || {}

      var items = [
        { type: 'header', label: headerLabel },
        { icon: IC.copy,  label: 'Copy', action: function () { navigator.clipboard.writeText(yaml()).catch(console.error) } },
        { icon: IC.cut,   label: 'Cut',  action: function () { navigator.clipboard.writeText(yaml()).then(del).catch(console.error) } },
        { icon: IC.trash, label: 'Delete', action: del },
        { type: 'divider' },
        { icon: IC.promote, label: 'Promote to Document',
          disabled: !isComplete || !node.attrs.content,
          action: promoteWebClip
        },
      ]

      if (isComplete && node.attrs.content) {
        items.push({ type: 'divider' })
        items.push({ icon: IC.sparkle, label: 'Ask AI...', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          var ctx = { content: webClipSummary(node), history: '', blockRef: node.attrs.id, imageIds: [], contextLabel: 'Web Clip' }
          document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
        }})
        items.push({ icon: IC.info, label: 'Explain', action: function () {
          if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
          else editor.commands.focus()
          var ctx = { content: webClipSummary(node), history: '', blockRef: node.attrs.id, imageIds: [], contextLabel: 'Web Clip' }
          document.dispatchEvent(new CustomEvent('sieve:ai-explain', { detail: { precomputedCtx: ctx } }))
        }})
      }

      return items
    }
  }

  T.registerSieveRenderer('web-clip', WebClipRenderer)
})()
