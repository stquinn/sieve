// The NodeView adapter for the 'smart-card' kind. Look-and-feel — the card
// shell, OG-style layout, loading chrome, this kind's stylesheet — belongs to
// SmartCardRenderer, which this file holds by composition. What lives here is
// everything that speaks ProseMirror: schema data (nodeConfig/attrs/parseAttrs),
// chrome-host click shielding, click-to-edit when there is no href (dispatches
// `sieve:smart-card-edit`), and Mod+Click to open the URL via the Wails runtime —
// all of which need the NodeView's closure.
//
// The edit dialog itself is NOT here: the "URL + display title" popup is shared
// with prose links and lives in ui/link-edit-dialog.js. What stays adapter-side
// is the PM-bound half — resolving the block id to its live renderer and landing
// the save on the renderer's own setLink.

import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { SmartCardRenderer } from '../../../../renderers/smart-card-renderer.js'
import { openLinkEditor } from '../../../../ui/link-edit-dialog.js'

;(function () {
  'use strict'

  // id → live SmartCardRenderer instance. The edit dialog, a module-level
  // singleton driven by `sieve:smart-card-edit`, resolves the block's renderer
  // here so its SAVE lands on setLink and never on a wire op from this file.
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
      draggable: false
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

      var renderer = new SmartCardRenderer(sieveBlockFor(node, undefined, ctx && ctx.provider), ctx.provider || null)

      var dom = renderer.render()
      if (currentAttrs.id) liveRenderers[currentAttrs.id] = renderer

      // The block-chrome host (gutter line number + drag handle) is injected as
      // the card's first child, so its events bubble here. Ignore them: a handle
      // click is a block selection and a handle drag is a reorder, so neither
      // should navigate the card or be cancelled.
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
          renderer.update(sieveBlockFor(updatedNode, undefined, ctx && ctx.provider))
          return true
        },
        destroy: function () {
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

  //
  // SAVE = the live renderer's semantic verb. The shared dialog is a singleton
  // that knows nothing about blocks, so this binding resolves the block's renderer
  // by id and calls setLink; the patch reaches the document as an update-block op,
  // never a wire op from this file.
  document.addEventListener('sieve:smart-card-edit', function (e) {
    var detail = e.detail || {}
    openLinkEditor({
      href: detail.href || '',
      label: detail.title || '',
      onSave: function (href, label) {
        var r = detail.id && liveRenderers[detail.id]
        if (r) r.setLink(href, label)
      },
    })
  })

})()
