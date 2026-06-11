// smart-link-renderer.js — Smart Link inline renderer.
// Registers window.TipTap.registerSieveRenderer('smart-link', SmartLinkRenderer)
// Renders as an inline <a> in flowing text. Go's RunJob fetches the page title;
// the label updates in place when the job completes.

import { isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  var SmartLinkRenderer = {

    getFriendlyName: function(node) { return 'Link' },

    asContentEntry: function(node) {
      if (!node.attrs.href) return null
      return [{ mimeType: 'text/uri-list', content: node.attrs.href }]
    },


    nodeConfig: { selectable: true, draggable: false, inline: true, group: "inline" },

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
      var dom = document.createElement('a')
      dom.className = 'smart-link-node'
      dom.setAttribute('data-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('click', function (e) {
        e.preventDefault()
        if (window.isMod && window.isMod(e)) {
          var href = dom.getAttribute('href')
          if (href && window.runtime && window.runtime.BrowserOpenURL) {
            window.runtime.BrowserOpenURL(href)
          }
        }
      })

      function render(n) {
        dom.setAttribute('data-id', n.attrs.id || '')
        var status = n.attrs.status || 'PENDING'
        var href   = n.attrs.href  || '#'
        var label  = n.attrs.label || n.attrs.href || '…'

        dom.href = href
        dom.title = 'Ctrl+Click to open'
        dom.removeAttribute('data-pending')
        dom.removeAttribute('data-error')

        if (status === 'PENDING' || status === 'DISPATCHED') {
          dom.textContent = label || href
          dom.setAttribute('data-pending', '')
          if (isJobStale(n.attrs.createdAt, n.attrs.id)) {
            dom.setAttribute('data-stale', '')
          }
        } else if (status === 'COMPLETE') {
          dom.textContent = label || href
        } else {
          dom.textContent = label || href
          dom.setAttribute('data-error', '')
        }
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

      return [
        { type: 'header', label: 'Link' },
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
        {
          icon: IC.edit,
          label: 'Edit…',
          action: function () {
            if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
            document.dispatchEvent(new CustomEvent('sieve:smart-link-edit', {
              detail: { id: node.attrs.id, href: href, label: label, getPos: getPos, editor: editor }
            }))
          },
        },

      ]
    },
  }

  T.registerSieveRenderer('smart-link', SmartLinkRenderer)

  // ── Edit dialog ───────────────────────────────────────────────────────────────
  // Opened via sieve:smart-link-edit. Re-uses ask-popup styling.

  var editDialog = null

  function getEditDialog() {
    if (editDialog) return editDialog

    var dlg = document.createElement('dialog')
    dlg.className = 'ask-popup smart-link-edit-popup'

    var header = document.createElement('div')
    header.className = 'ask-popup__header'
    var title = document.createElement('span')
    title.className = 'ask-popup__label'
    title.textContent = 'Edit Link'
    var closeBtn = document.createElement('button')
    closeBtn.className = 'ask-popup__close'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', function () { dlg.close() })
    header.appendChild(title)
    header.appendChild(closeBtn)

    var hrefInput = document.createElement('input')
    hrefInput.type = 'url'
    hrefInput.className = 'smart-link-edit-popup__input'
    hrefInput.placeholder = 'URL (https://…)'

    var labelInput = document.createElement('input')
    labelInput.type = 'text'
    labelInput.className = 'smart-link-edit-popup__input'
    labelInput.placeholder = 'Display label'

    var footer = document.createElement('div')
    footer.className = 'ask-popup__footer'
    var saveBtn = document.createElement('button')
    saveBtn.className = 'ask-popup__send'
    saveBtn.textContent = 'Save'
    footer.appendChild(saveBtn)

    dlg.appendChild(header)
    dlg.appendChild(hrefInput)
    dlg.appendChild(labelInput)
    dlg.appendChild(footer)
    document.body.appendChild(dlg)

    dlg.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); dlg.close() }
      if (e.key === 'Enter')  { e.preventDefault(); dlg._save() }
    })
    saveBtn.addEventListener('click', function () { dlg._save() })

    editDialog = dlg
    return dlg
  }

  document.addEventListener('sieve:smart-link-edit', function (e) {
    var detail  = e.detail
    var dlg     = getEditDialog()
    var hrefEl  = dlg.querySelector('.smart-link-edit-popup__input')
    var labelEl = dlg.querySelectorAll('.smart-link-edit-popup__input')[1]

    hrefEl.value  = detail.href  || ''
    labelEl.value = detail.label || ''

    dlg._save = function () {
      var newHref  = hrefEl.value.trim()
      var newLabel = labelEl.value.trim() || newHref
      if (!newHref) return
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: detail.id, kind: 'smart-link', attrs: { href: newHref, label: newLabel } }
      }))
      dlg.close()
    }

    dlg.showModal()
    requestAnimationFrame(function () { hrefEl.select() })
  })

})()
