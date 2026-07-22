// smart-card-node-view.js — Sieve NodeView ADAPTER for the 'smart-card' kind
// (the PM half of the renderer/NodeView split; NORMATIVE contract:
// docs/design/specs/2026-07-21-block-renderer-contract.md). Look-and-feel (the
// card shell, OG-style layout, loading chrome, this kind's stylesheet) lives
// in SmartCardRenderer (frontend/src/static/block/renderers/smart-card-renderer.js
// — a DIFFERENT class). This
// file HOLDS a SmartCardRenderer instance by COMPOSITION and owns everything
// that genuinely speaks ProseMirror: schema data (nodeConfig/attrs/parseAttrs),
// chrome-host click shielding, click-to-edit-when-no-href (dispatches
// `sieve:smart-card-edit`), Mod+Click to open the URL via the Wails runtime,
// and the v1 BlockService applier (where the renderer's semantic verbs land as
// tracked PM transactions via ctx.updateAttributes) — all of which need the
// NodeView's closure, so per the PM-specificity sorting test they stay
// adapter-side.
//
// A9 readiness note (migration survey): the edit-popup dialog below stays
// adapter-side for now, same as its twin smart-link's (unmigrated) —
// revisit hoisting a shared EditPopup once smart-link migrates.

import { registerSieveRenderer, sieveBlockFor } from '../../../block/sieve-block-extension.js'
import { SmartCardRenderer } from '../../../block/renderers/smart-card-renderer.js'

;(function () {
  'use strict'

  // liveRenderers — id → live SmartCardRenderer instance. The edit dialog (a
  // module-level singleton driven by `sieve:smart-card-edit`) resolves the
  // block's renderer here so its SAVE lands on the renderer's own semantic
  // verb (setLink) — never on wire ops from this file.
  /** @type {Record<string, any>} */
  var liveRenderers = {}

  var SmartCardNodeView = {

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

    makeNodeView: function (node, editorPane, getPos, ctx) {
      var nodeTypeName = 'sieve-smart-card'
      var currentAttrs = Object.assign({}, node.attrs)

      // The renderer instance this NodeView HOLDS by composition (never
      // inheritance — see the file header). It builds itself from the typed
      // envelope (no live overlay — this kind has no lens-supplied fields);
      // this adapter only supplies PM-only click/interaction concerns around
      // it, and its semantic verbs (setLink) effect through the BlockService.
      var renderer = new SmartCardRenderer(sieveBlockFor(node), ctx.blockService || null)

      // v1 APPLIER — today's PM-transaction behaviour behind the service
      // boundary: the renderer's verbs arrive here and become tracked attr
      // transactions via ctx.updateAttributes. A true atom has no content
      // channel, so setContent is a no-op.
      var unregisterApplier = ctx.blockService ? ctx.blockService.registerApplier({
        owns: function (id) { return !!id && id === (currentAttrs.id || '') },
        updateAttributes: function (_id, patch) { ctx.updateAttributes(patch) },
        setContent: function () {},
        retry: function () { ctx.retry() },
      }) : null

      var dom = renderer.render()
      if (currentAttrs.id) liveRenderers[currentAttrs.id] = renderer

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
            detail: { id: node.attrs.id, href: '', title: '' }
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
        renderer: renderer,   // marks this a MIGRATED kind for the seam's branch
        update: function (updatedNode) {
          if (updatedNode.type.name !== nodeTypeName) return false
          node = updatedNode
          currentAttrs = updatedNode.attrs
          // Late-id hardening: a block whose id lands via attr update on THIS
          // NodeView still reaches the policy/menu triggers.
          if (currentAttrs.id && !liveRenderers[currentAttrs.id]) liveRenderers[currentAttrs.id] = renderer
          renderer.update(sieveBlockFor(updatedNode))
          return true
        },
        destroy: function () {
          if (unregisterApplier) unregisterApplier()
          if (currentAttrs.id && liveRenderers[currentAttrs.id] === renderer) delete liveRenderers[currentAttrs.id]
          renderer.destroy()
        },
      }
    },

    buildContextMenuItems: function (opts) {
      var node   = opts.node
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
              detail: { id: id, href: href, title: title }
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

  registerSieveRenderer('smart-card', SmartCardNodeView)

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
      // SAVE = the live renderer's semantic verb. The dialog is a module-level
      // singleton, so it resolves the block's renderer by id (liveRenderers)
      // and calls setLink — the patch reaches the document as a tracked PM
      // transaction via the BlockService applier the NodeView registered.
      var r = detail.id && liveRenderers[detail.id]
      if (r) r.setLink(newHref, newTitle)
      dlg.close()
    }

    dlg.showModal()
    requestAnimationFrame(function () { inputs[0].select() })
  })

})()
