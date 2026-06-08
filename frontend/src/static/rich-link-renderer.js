// rich-link-renderer.js — Rich Link Card block renderer.
// Registers window.TipTap.registerSieveRenderer('rich-link', RichLinkRenderer)
// Renders OG metadata as a visual card block. Display-only (no editable content).

import { isJobStale } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  var RichLinkRenderer = {

    nodeConfig: { atom: true, selectable: true, draggable: false },

    attrs: {
      href:        { default: '',   parseHTML: function (el) { return el.getAttribute('data-href')        || '' } },
      title:       { default: '',   parseHTML: function (el) { return el.getAttribute('data-title')       || '' } },
      description: { default: '',   parseHTML: function (el) { return el.getAttribute('data-description') || '' } },
      image:       { default: '',   parseHTML: function (el) { return el.getAttribute('data-image')       || '' } },
      siteName:    { default: '',   parseHTML: function (el) { return el.getAttribute('data-site-name')   || '' } },
      fetchedAt:   { default: null, parseHTML: function (el) { return el.getAttribute('data-fetched-at')  || null } },
      completedAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
      error:       { default: null, parseHTML: function (el) { return el.getAttribute('data-error')        || null } },
    },

    parseAttrs: function (data) {
      return {
        href:        data.href        || '',
        title:       data.title       || '',
        description: data.description || '',
        image:       data.image       || '',
        siteName:    data.siteName    || '',
        fetchedAt:   data.fetchedAt   || null,
        completedAt: data.completedAt || null,
        error:       data.error       || null,
      }
    },

    makeNodeView: function (node, editor) {
      var dom = document.createElement('div')
      dom.className = 'rich-link-card'
      dom.contentEditable = 'false'
      dom.setAttribute('data-rich-link-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })
      dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

      dom.addEventListener('click', function (e) {
        if (!node.attrs.href) {
          if (typeof getPos !== 'function') return
          document.dispatchEvent(new CustomEvent('sieve:rich-link-edit', {
            detail: { id: node.attrs.id, href: '', title: '', getPos: getPos, editor: editor }
          }))
          return
        }

        if (window.isMod && window.isMod(e)) {
          var href = node.attrs.href
          if (href && window.runtime && window.runtime.BrowserOpenURL) {
            window.runtime.BrowserOpenURL(href)
          }
        }
      })

      function render(n) {
        dom.innerHTML = ''
        dom.setAttribute('data-rich-link-id', n.attrs.id || '')

        var status = n.attrs.status || 'PENDING'
        var isPending = status === 'PENDING' || status === 'DISPATCHED'
        var stale = isPending && isJobStale(n.attrs.createdAt, n.attrs.id)

        dom.classList.toggle('rich-link-card--pending', isPending && !stale)

        // Row 1: link icon + site name
        var meta = document.createElement('div')
        meta.className = 'rich-link-card__meta'
        var icon = document.createElement('span')
        icon.className = 'rich-link-card__icon'
        icon.textContent = '🔗'
        var site = document.createElement('span')
        site.className = 'rich-link-card__site'
        site.textContent = isPending ? extractDomain(n.attrs.href || '') : (n.attrs.siteName || extractDomain(n.attrs.href || ''))
        meta.appendChild(icon)
        meta.appendChild(site)
        dom.appendChild(meta)

        // Row 2: thumbnail + content
        var body = document.createElement('div')
        body.className = 'rich-link-card__body'

        // Thumbnail column
        var thumb = document.createElement('div')
        thumb.className = 'rich-link-card__thumb'
        if (isPending) {
          thumb.classList.add('rich-link-card__thumb--spinner')
          var spinner = document.createElement('span')
          spinner.className = 'rich-link-card__spinner'
          thumb.appendChild(spinner)
        } else if (n.attrs.image) {
          thumb.classList.add('rich-link-card__thumb--placeholder')
          var img = document.createElement('img')
          img.src = n.attrs.image
          img.alt = n.attrs.title || ''
          img.className = 'rich-link-card__thumb'
          img.style.cssText = 'width:72px;height:72px;object-fit:cover;border-radius:5px;'
          // Replace the div with the img
          body.appendChild(img)
          thumb = null
        } else {
          thumb.classList.add('rich-link-card__thumb--placeholder')
          thumb.textContent = '🔗'
        }
        if (thumb) body.appendChild(thumb)

        // Text content column
        var content = document.createElement('div')
        content.className = 'rich-link-card__content'

        var titleEl = document.createElement('div')
        titleEl.className = 'rich-link-card__title'
        titleEl.textContent = isPending ? (n.attrs.href || '…') : (n.attrs.title || n.attrs.href || '…')
        content.appendChild(titleEl)

        if (!isPending && n.attrs.description) {
          var descEl = document.createElement('div')
          descEl.className = 'rich-link-card__description'
          descEl.textContent = n.attrs.description
          content.appendChild(descEl)
        }

        var urlEl = document.createElement('div')
        urlEl.className = 'rich-link-card__url'
        urlEl.textContent = n.attrs.href || ''
        content.appendChild(urlEl)

        body.appendChild(content)
        dom.appendChild(body)
      }

      render(node)

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-rich-link') return false
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
      var title  = node.attrs.title || href
      var id     = node.attrs.id    || ''

      function deleteBlock() {
        if (typeof getPos === 'function') {
          var pos = getPos()
          editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize))
        }
      }

      return [
        { type: 'header', label: 'Rich Link' },
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
          icon: IC.globe,
          label: 'Upgrade to Web Clip (Fetch)',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var size = node.nodeSize
            document.dispatchEvent(new CustomEvent('sieve:upgrade-to-web-clip', {
              detail: { href: href, fromPos: pos, fromSize: size, mode: 'fetch' }
            }))
          },
        },
        {
          icon: IC.globe,
          label: 'Upgrade to Web Clip (Summarise)',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var size = node.nodeSize
            document.dispatchEvent(new CustomEvent('sieve:upgrade-to-web-clip', {
              detail: { href: href, fromPos: pos, fromSize: size, mode: 'summarise' }
            }))
          },
        },
        { type: 'divider' },
        {
          icon: IC.edit,
          label: 'Edit Link…',
          action: function () {
            document.dispatchEvent(new CustomEvent('sieve:rich-link-edit', {
              detail: { id: id, href: href, title: title, getPos: getPos, editor: editor }
            }))
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
        {
          icon: IC.arrowDown,
          label: 'Downgrade to Smart Link',
          action: function () {
            if (typeof getPos !== 'function') return
            var pos = getPos()
            var size = node.nodeSize
            editor.chain()
              .command(function (props) {
                props.tr.delete(pos, pos + size)
                return true
              })
              .insertContentAt(pos, {
                type: 'paragraph',
                content: [{
                  type: 'sieve-smart-link',
                  attrs: {
                    href: href,
                    label: title,
                    status: 'COMPLETE',
                    completedAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    error: null,
                  }
                }]
              })
              .run()
          },
        },

        { type: 'divider' },
        { icon: IC.trash, label: 'Delete', action: deleteBlock },
      ]
    },
  }

  T.registerSieveRenderer('rich-link', RichLinkRenderer)

  // ── Edit dialog ──────────────────────────────────────────────────────────────

  var editDialog = null

  function getEditDialog() {
    if (editDialog) return editDialog

    var dlg = document.createElement('dialog')
    dlg.className = 'ask-popup rich-link-edit-popup'

    var header = document.createElement('div')
    header.className = 'ask-popup__header'
    var titleLabel = document.createElement('span')
    titleLabel.className = 'ask-popup__label'
    titleLabel.textContent = 'Edit Link'
    var closeBtn = document.createElement('button')
    closeBtn.className = 'ask-popup__close'
    closeBtn.textContent = '✕'
    closeBtn.addEventListener('click', function () { dlg.close() })
    header.appendChild(titleLabel)
    header.appendChild(closeBtn)

    var hrefInput = document.createElement('input')
    hrefInput.type = 'url'
    hrefInput.className = 'smart-link-edit-popup__input'
    hrefInput.placeholder = 'URL (https://…)'

    var labelInput = document.createElement('input')
    labelInput.type = 'text'
    labelInput.className = 'smart-link-edit-popup__input'
    labelInput.placeholder = 'Display title'

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

  document.addEventListener('sieve:rich-link-edit', function (e) {
    var detail = e.detail
    var dlg = getEditDialog()
    var inputs = dlg.querySelectorAll('.smart-link-edit-popup__input')
    inputs[0].value = detail.href  || ''
    inputs[1].value = detail.title || ''

    dlg._save = function () {
      var newHref  = inputs[0].value.trim()
      var newTitle = inputs[1].value.trim() || newHref
      if (!newHref) return
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: detail.id, kind: 'rich-link', attrs: { href: newHref, title: newTitle } }
      }))
      dlg.close()
    }

    dlg.showModal()
    requestAnimationFrame(function () { inputs[0].select() })
  })

  function extractDomain(url) {
    try { return new URL(url).hostname } catch (_) { return url }
  }

})()
