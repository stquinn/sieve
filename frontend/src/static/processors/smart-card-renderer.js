// smart-card-renderer.js — Sieve NodeView ADAPTER for the 'smart-card' kind
// (the PM half of the renderer/NodeView split, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Look-and-feel (the card shell, OG-style layout,
// loading chrome, this kind's stylesheet) lives in SmartCardRenderer
// (frontend/src/static/block/renderers/smart-card-renderer.js — a DIFFERENT
// class, deliberately same basename, different directory). This file HOLDS a
// SmartCardRenderer instance by COMPOSITION and owns everything that
// genuinely speaks ProseMirror: schema data (nodeConfig/attrs/parseAttrs),
// chrome-host click shielding, click-to-edit-when-no-href (dispatches
// `sieve:smart-card-edit` carrying `getPos`), and Mod+Click to open the URL
// via the Wails runtime — all of which need `getPos()`/the NodeView's
// closure, so per the PM-specificity sorting test they stay adapter-side.
//
// A9 readiness note (migration survey): the edit-popup dialog below stays
// adapter-side for now, same as its twin smart-link's (unmigrated) —
// revisit hoisting a shared EditPopup once smart-link migrates.

import { registerSieveRenderer } from '../block/sieve-block-extension.js'
import { updateBlockOp } from '../block/block-sync.js'
import { SmartCardRenderer } from '../block/renderers/smart-card-renderer.js'

;(function () {
  'use strict'

  var SmartCardNodeAdapter = {

    getIcon: function() { return window.SieveIcons && window.SieveIcons.smartFile },
    getFriendlyName: function(node) { return 'Card' },

    asContentEntry: function(node) {
      if (!node.attrs.href) return null
      return [{ mimeType: 'text/uri-list', content: node.attrs.href }]
    },

    interactionPolicy: { caretStop: true },

    // Pure display-only metadata card — no editable body. A true atom: the framework
    // forces contentEditable=false (no contentDOM), so there is no phantom caret region.
    nodeConfig: {
      atom: true,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false
    },

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

    makeNodeView: function (node, editorPane, getPos) {
      var nodeTypeName = 'sieve-smart-card'

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). All look-and-feel (shell,
      // OG-style layout, loading chrome) is its job; this adapter only
      // supplies PM-only click/interaction concerns around it.
      var renderer = new SmartCardRenderer()
      var dom = renderer.mount(node.attrs)

      // The block-chrome host (gutter line number + drag handle) is injected as the
      // card's first child, so its events bubble here.  Ignore them: a handle click
      // is a block selection, and a handle drag is a reorder — neither should
      // activate/navigate the card or be cancelled.
      function fromChrome(e) { return e.target && e.target.closest && e.target.closest('.block-chrome-host') }

      dom.addEventListener('dragstart', function (e) {
        if (fromChrome(e)) return        // let the gutter handle start its reorder drag
        e.preventDefault()
      })

      dom.addEventListener('click', function (e) {
        if (fromChrome(e)) return        // gutter/handle click selects the block, not the card
        if (!node.attrs.href) {
          if (typeof getPos !== 'function') return
          document.dispatchEvent(new CustomEvent('sieve:smart-card-edit', {
            detail: { id: node.attrs.id, href: '', title: '', getPos: getPos, editor: editorPane }
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

      return {
        dom: dom,
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode
          renderer.update(dom, updatedNode.attrs)
          return true
        },
      }
    },

    buildContextMenuItems: function (opts) {
      var node   = opts.node
      var editorPane = opts.editorPane
      var getPos = opts.getPos
      var IC     = window.SieveIcons || {}
      var href   = node.attrs.href  || ''
      var title  = node.attrs.title || href
      var id     = node.attrs.id    || ''

      return [
        { type: 'header', label: 'Link Card' },
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
          icon: IC.edit,
          label: 'Edit Link…',
          action: function () {
            document.dispatchEvent(new CustomEvent('sieve:smart-card-edit', {
              detail: { id: id, href: href, title: title, getPos: getPos, editor: editorPane }
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
      ]
    },
  }

  registerSieveRenderer('smart-card', SmartCardNodeAdapter)

  // ── Edit dialog (A9 — stays adapter-side; see file header) ──────────────

  var editDialog = null

  function getEditDialog() {
    if (editDialog) return editDialog

    var dlg = document.createElement('dialog')
    dlg.className = 'ask-popup smart-card-edit-popup'

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

  document.addEventListener('sieve:smart-card-edit', function (e) {
    var detail = e.detail
    var dlg = getEditDialog()
    var inputs = dlg.querySelectorAll('.smart-link-edit-popup__input')
    inputs[0].value = detail.href  || ''
    inputs[1].value = detail.title || ''

    dlg._save = function () {
      var newHref  = inputs[0].value.trim()
      var newTitle = inputs[1].value.trim() || newHref
      if (!newHref) return
      // The edit dialog is a module-level singleton driven by an event that threads
      // the block's editorPane (detail.editor); reach the held Editor through the pane
      // the surface stamped (editorPane.sieveHost) — never the backend directly.
      var host = detail.editor && detail.editor.sieveHost
      if (host) host.applyBlockOps([updateBlockOp({ id: detail.id, kind: 'smart-card', attrs: { href: newHref, title: newTitle } })])
      dlg.close()
    }

    dlg.showModal()
    requestAnimationFrame(function () { inputs[0].select() })
  })

})()
