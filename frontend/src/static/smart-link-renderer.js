// smart-link-renderer.js — Smart Link block renderer.
// Registers window.TipTap.registerSieveRenderer('smart-link', SmartLinkRenderer)
// A smart-link block is created by pasting a bare URL. Go's RunJob fetches the
// page title; the renderer shows a compact link card.

import { isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  var SmartLinkRenderer = {

    nodeConfig: { atom: true, selectable: true, draggable: false },

    attrs: {
      href:        { default: '',   parseHTML: function (el) { return el.getAttribute('data-href')         || '' } },
      label:       { default: '',   parseHTML: function (el) { return el.getAttribute('data-label')        || '' } },
      completedAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      error:       { default: null, parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        href:        data.href        || '',
        label:       data.label       || '',
        completedAt: data.completedAt || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editor) {
      var dom = document.createElement('div')
      dom.className = 'smart-link-block'
      dom.contentEditable = 'false'
      dom.setAttribute('data-sl-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

      function openURL(href) {
        if (href && window.runtime && window.runtime.BrowserOpenURL) {
          window.runtime.BrowserOpenURL(href)
        }
      }

      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-sl-id', n.attrs.id || '')
        dom.className = 'smart-link-block'

        var status = n.attrs.status || 'PENDING'
        var href   = n.attrs.href  || ''
        var label  = n.attrs.label || href

        var icon = document.createElement('span')
        icon.className = 'smart-link-block__icon'
        icon.textContent = '🔗'

        var textWrap = document.createElement('div')
        textWrap.className = 'smart-link-block__text'

        if (status === 'PENDING' || status === 'DISPATCHED') {
          dom.classList.add('smart-link-block--loading')
          var titleEl = document.createElement('span')
          titleEl.className = 'smart-link-block__title'
          titleEl.textContent = label || href || 'Fetching…'
          var statusEl = document.createElement('span')
          statusEl.className = 'smart-link-block__url'
          statusEl.textContent = 'Fetching title…'
          textWrap.appendChild(titleEl)
          textWrap.appendChild(statusEl)

          if (isJobStale(n.attrs.createdAt, n.attrs.id)) {
            dom.classList.remove('smart-link-block--loading')
            var retryBtn = document.createElement('button')
            retryBtn.className = 'smart-link-block__retry'
            retryBtn.textContent = 'Retry'
            retryBtn.addEventListener('click', function () {
              document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
            })
            textWrap.appendChild(retryBtn)
          }
        } else if (status === 'COMPLETE') {
          var titleLink = document.createElement('a')
          titleLink.className = 'smart-link-block__title'
          titleLink.href = href || '#'
          titleLink.textContent = label || href
          titleLink.title = 'Ctrl+Click to open'
          titleLink.addEventListener('click', function (e) {
            e.preventDefault()
            if (window.isMod && window.isMod(e)) openURL(href)
          })
          var urlEl = document.createElement('span')
          urlEl.className = 'smart-link-block__url'
          urlEl.textContent = href
          textWrap.appendChild(titleLink)
          textWrap.appendChild(urlEl)
        } else {
          dom.classList.add('smart-link-block--error')
          var errLink = document.createElement('a')
          errLink.className = 'smart-link-block__title'
          errLink.href = href || '#'
          errLink.textContent = label || href
          errLink.addEventListener('click', function (e) {
            e.preventDefault()
            if (window.isMod && window.isMod(e)) openURL(href)
          })
          var errMsg = document.createElement('span')
          errMsg.className = 'smart-link-block__url smart-link-block__url--error'
          errMsg.textContent = (n.attrs.error || 'Could not fetch title').trim()
          textWrap.appendChild(errLink)
          textWrap.appendChild(errMsg)
        }

        dom.appendChild(icon)
        dom.appendChild(textWrap)
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-smart-link') return false
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

    buildContextMenuItems: function (opts) {
      var node   = opts.node
      var editor = opts.editor
      var getPos = opts.getPos
      var IC     = window.SieveIcons || {}
      var href   = node.attrs.href  || ''
      var label  = node.attrs.label || href

      function del() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      var items = [
        { type: 'header', label: 'Smart Link' },
        {
          icon: IC.externalLink,
          label: 'Open URL',
          action: function () {
            if (href && window.runtime && window.runtime.BrowserOpenURL) {
              window.runtime.BrowserOpenURL(href)
            }
          },
        },
        {
          icon: IC.copy,
          label: 'Copy URL',
          action: function () {
            if (href) navigator.clipboard.writeText(href).catch(function () {})
          },
        },
        { type: 'divider' },
        { icon: IC.trash, label: 'Delete', action: del },
      ]

      if (node.attrs.status === 'COMPLETE' && href) {
        items.push({ type: 'divider' })
        items.push({
          icon: IC.sparkle,
          label: 'Ask AI…',
          action: function () {
            if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
            else editor.commands.focus()
            var ctx = {
              content:      label !== href ? '[' + label + '](' + href + ')' : href,
              history:      '',
              blockRef:     node.attrs.id,
              imageIds:     [],
              contextLabel: 'Smart Link',
            }
            document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
          },
        })
      }

      return items
    },
  }

  T.registerSieveRenderer('smart-link', SmartLinkRenderer)
})()
