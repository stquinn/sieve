// The NodeView adapter for the 'reference' kind. Look-and-feel — the chip, its
// detail text, the chevron and the summary it reveals — belongs to
// ReferenceRenderer, which this file holds by composition. What is owned here is
// what speaks ProseMirror or the app: schema data (nodeConfig/attrs/parseAttrs),
// the interaction policy, the context menu, and the ANSWER to the renderer's
// open intent.
//
// THE OPEN GESTURE. The renderer fans out "the user opened this reference" with
// the block's target and names no mechanism. Here that becomes:
//
//   points (uri, not held) → the container, via window.sieveWorkspace.openAddress,
//     which asks Go to resolve the address. The uri is OPAQUE on this side: no
//     scheme test, no split, no pin rule.
//
//   holds (a non-`sieve/*` mime — a file this block itself holds) → a
//     `sieve:reference-open-asset` INTENT on document, answered at the bottom of
//     this file by the DESKTOP realisation (reveal in the OS file manager). A
//     hosted build answers the same gesture with a download or a viewer.
//
// `kind` IS RESERVED. BASE_ATTRS declares `kind` on every sieve-* node as the
// BLOCK's kind, so no processor may name an attr that: the collision would be
// silent, since applyBlockAttrsUpdated copies any wire key present in node.attrs
// and a target's own noun would overwrite "reference" as soon as a job completed.
// The noun a reference wears is derived from `mime` instead.

import { registerSieveRenderer, sieveBlockFor } from '../sieve-block-extension.js'
import { ReferenceRenderer } from '../../../../renderers/reference-renderer.js'

;(function () {
  'use strict'

  var OPEN_ASSET_EVENT = 'sieve:reference-open-asset'

  /** The document a block belongs to. The active-editor fallback covers a host
   *  with no getEditor: a document is only ever open in the single active tab,
   *  so the active editor IS this block's editor. */
  function uuidOf(host) {
    var ed = (host && typeof host.getEditor === 'function') ? host.getEditor() : null
    if (ed && ed.uuid) return ed.uuid
    var active = window.sieveWorkspace && window.sieveWorkspace.activeEditor
    return (active && active.uuid) || ''
  }

  /** The ONE place a target becomes an action. @param {{uri: string, title: string, held: boolean}} target */
  function openTarget(target, uuid) {
    if (!target) return
    if (!target.held) {
      if (window.sieveWorkspace) window.sieveWorkspace.openAddress(target.uri)
      return
    }
    document.dispatchEvent(new CustomEvent(OPEN_ASSET_EVENT, {
      detail: { uri: target.uri, title: target.title || '', uuid: uuid || '' },
    }))
  }

  function fromChrome(e) {
    return e.target && e.target.closest && e.target.closest('.block-chrome-host')
  }

  function makeNodeView(node, editorPane, getPos, ctx) {
    var nodeTypeName = 'sieve-reference'

    var renderer = new ReferenceRenderer(
      sieveBlockFor(node, undefined, ctx && ctx.provider),
      (ctx && ctx.provider) || null)

    var dom = renderer.render()

    renderer.onOpen(function (target) { openTarget(target, uuidOf(ctx)) })

    // The block-chrome host (gutter line number + drag handle) is injected as the
    // block's first child, so its events bubble here. A handle drag is a reorder;
    // everything else must not start a native node drag.
    dom.addEventListener('dragstart', function (e) {
      if (fromChrome(e)) return
      e.preventDefault()
    })

    return {
      dom: dom,
      renderer: renderer,   // marks this a MIGRATED kind for the seam's branch

      update: function (updatedNode) {
        if (updatedNode.type.name !== nodeTypeName) return false
        node = updatedNode
        renderer.update(sieveBlockFor(updatedNode, undefined, ctx && ctx.provider))
        return true
      },

      // The renderer REWRITES this subtree on every redraw. Nothing inside is
      // ProseMirror's, and a mutation here must never cost the NodeView its
      // recreation.
      ignoreMutation: function () { return true },

      destroy: function () { renderer.destroy() },
    }
  }

  var ReferenceNodeView = {

    getIcon: function () { return window.SieveIcons && window.SieveIcons.smartFile },
    getFriendlyName: function () { return 'Reference' },

    // A chip has no editable text, so the arrows select it as ONE stop — joining
    // ai-block, web-clip, smart-image and smart-card.
    interactionPolicy: { caretStop: true },

    // A true atom: no editable body, so the framework forces
    // contentEditable=false and there is no phantom caret region.
    nodeConfig: {
      atom: true,
      selectable: true,
      draggable: false,
    },

    // `kind` is ABSENT on purpose — see the file header. The face is ONE `cache`
    // attr, a map of what the resolve took from the target (title, summary,
    // mime, bytes, cachedAt) — root attrs describe the POINTING. A map rides the
    // data-* costume as JSON, the ai-block attachments pattern.
    attrs: {
      uri: { default: '', parseHTML: function (el) { return el.getAttribute('data-uri') || '' } },
      cache: {
        default: null,
        parseHTML: function (el) {
          try { return JSON.parse(el.getAttribute('data-cache') || 'null') } catch (e) { return null }
        },
      },
      error: { default: '', parseHTML: function (el) { return el.getAttribute('data-error') || '' } },
    },

    parseAttrs: function (data) {
      return {
        uri:   data.uri || '',
        cache: JSON.stringify(data.cache || null),
        error: data.error || '',
      }
    },

    // A reference copies as its coordinate — which the processor claims back as
    // a TRANSFORM when it is pasted, so a copied chip becomes a chip again.
    asContentEntry: function (node) {
      var uri = (node.attrs.uri || '').trim()
      return uri ? [{ mimeType: 'text/plain', content: uri }] : null
    },

    makeNodeView: makeNodeView,

    buildContextMenuItems: function (opts) {
      var node = opts.node
      var IC = window.SieveIcons || {}
      var target = ReferenceRenderer.targetFor(node.attrs)
      var items = [{ type: 'header', label: 'Reference' }]
      if (!target) return items

      items.push({
        icon: IC.externalLink,
        label: target.held ? 'Show in Files' : 'Open Reference',
        action: function () { openTarget(target, uuidOf(opts)) },
      })
      items.push({
        icon: IC.copy,
        label: target.held ? 'Copy Filename' : 'Copy Address',
        action: function () {
          var text = ReferenceRenderer.copyTextFor(node.attrs)
          if (text) navigator.clipboard.writeText(text).catch(function () {})
        },
      })
      return items
    },
  }

  registerSieveRenderer('reference', ReferenceNodeView)

  // ShowInFilesByID resolves the document to its directory and reveals it, which
  // is where a held asset lives. Nothing here LAUNCHES the file — Sieve declines
  // that capability deliberately, since a dropped .desktop would be executed
  // rather than viewed; reading the asset in place is the chevron's job.
  document.addEventListener(OPEN_ASSET_EVENT, function (e) {
    var uuid = (e.detail && e.detail.uuid) || ''
    if (!uuid) return
    if (window.sieveShowInFiles) window.sieveShowInFiles(uuid)
  })

})()
