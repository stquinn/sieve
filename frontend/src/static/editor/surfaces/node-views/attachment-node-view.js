// attachment-node-view.js — Sieve NodeView ADAPTER for the 'attachment' kind
// (the PM half of the renderer/NodeView split; NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md; the kind's
// design: docs/design/specs/2026-08-19-attachment-block-design.md).
//
// Look-and-feel — the chip, its detail text, the chevron and the summary it
// reveals — lives in AttachmentRenderer
// (frontend/src/static/block/renderers/attachment-renderer.js, a DIFFERENT
// class). This file HOLDS one by COMPOSITION and owns what genuinely speaks
// ProseMirror or the app: schema data (nodeConfig/attrs/parseAttrs), the
// interaction policy, the context menu, and the ANSWER to the renderer's open
// intent.
//
// ── THE OPEN GESTURE, AND WHY IT SPLITS IN TWO PLACES ───────────────────────
// The renderer fans out "the user opened this attachment" with the block's
// target and names no mechanism. Here that becomes:
//
//   points (uri) → the container, via window.sieveWorkspace.openAddress — which
//     asks Go to resolve the address (MentionService.resolve → Router.Target).
//     The uri is OPAQUE on this side: no scheme test, no split, no pin rule.
//     This is the SAME path ai-block's footer chips take; reused, not rebuilt.
//
//   holds (src) → a `sieve:attachment-open-asset` INTENT on document, answered
//     at the bottom of this file by the DESKTOP realisation (reveal in the OS
//     file manager). The intent is not ceremony: the desktop is not the
//     destination (docs/design/vision-go-server-s3.md), and a hosted build with
//     no file manager must be able to answer the same gesture with a download or
//     a viewer without reopening the block's design. Same shape as
//     `sieve:ai-ask`/`sieve:ai-explain` — the surface fires, a handler decides.
//
// ── `kind` IS RESERVED; THIS KIND USES `targetKind` ─────────────────────────
// BASE_ATTRS declares `kind` on every sieve-* node as the BLOCK's kind, so no
// processor may name an attr that. The thing this block points at or holds is
// described by `targetKind` instead. The collision was silent when it existed:
// WysiwygSurface#applyBlockAttrsUpdated copies any wire key present in
// node.attrs, so Go's "yaml" overwrote the node's own "attachment" as soon as a
// job completed. That handler now also refuses `kind` outright, since a block's
// kind changes by replace-block and never by an attrs update.

import { registerSieveRenderer, sieveBlockFor } from '../../../block/sieve-block-extension.js'
import { AttachmentRenderer } from '../../../block/renderers/attachment-renderer.js'

;(function () {
  'use strict'

  // The open-an-asset INTENT. Fired by this adapter, answered by whatever
  // realisation the build ships (below: the desktop one).
  var OPEN_ASSET_EVENT = 'sieve:attachment-open-asset'

  /** The document a block belongs to. Both callers (the NodeView's ctx and the
   *  context menu's opts) carry a getEditor; the active-editor fallback covers
   *  neither having one — a document is only ever open in the single active tab,
   *  so the active editor IS this block's editor (the same reasoning
   *  smart-image's getExpandContent already relies on). */
  function uuidOf(host) {
    var ed = (host && typeof host.getEditor === 'function') ? host.getEditor() : null
    if (ed && ed.uuid) return ed.uuid
    var active = window.sieveWorkspace && window.sieveWorkspace.activeEditor
    return (active && active.uuid) || ''
  }

  /** The ONE place a target becomes an action. @param {{uri: string, src: string, title: string}} target */
  function openTarget(target, uuid) {
    if (!target) return
    if (target.uri) {
      if (window.sieveWorkspace) window.sieveWorkspace.openAddress(target.uri)
      return
    }
    if (!target.src) return
    document.dispatchEvent(new CustomEvent(OPEN_ASSET_EVENT, {
      detail: { src: target.src, title: target.title || '', uuid: uuid || '' },
    }))
  }

  function fromChrome(e) {
    return e.target && e.target.closest && e.target.closest('.block-chrome-host')
  }

  function makeNodeView(node, editorPane, getPos, ctx) {
    var nodeTypeName = 'sieve-attachment'

    // The renderer instance this NodeView HOLDS by composition (never
    // inheritance — see the file header). No live overlay: this kind has no
    // lens-supplied field, and the envelope's own `kind` handling is the
    // renderer's (see the header's note).
    var renderer = new AttachmentRenderer(
      sieveBlockFor(node, undefined, ctx && ctx.blockService),
      (ctx && ctx.blockService) || null)

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
        renderer.update(sieveBlockFor(updatedNode, undefined, ctx && ctx.blockService))
        return true
      },

      // The renderer REWRITES this subtree on every redraw (a chip is immutable,
      // so a chevron toggle or a render-back rebuilds the line). PM's default for
      // a contentDOM-less node view already ignores those, but this kind states
      // it: nothing inside is ProseMirror's, and a mutation must never cost the
      // NodeView its recreation.
      ignoreMutation: function () { return true },

      destroy: function () { renderer.destroy() },
    }
  }

  var AttachmentNodeView = {

    getIcon: function () { return window.SieveIcons && window.SieveIcons.smartFile },
    getFriendlyName: function () { return 'Attachment' },

    // A chip has no editable text, so the arrows select it as ONE stop — joining
    // ai-block, web-clip, smart-image and smart-card.
    interactionPolicy: { caretStop: true },

    // Pure display-only chip — no editable body. A true atom: the framework
    // forces contentEditable=false (no contentDOM), so there is no phantom caret
    // region.
    nodeConfig: {
      atom: true,
      selectable: true,
      draggable: false,
    },

    // `kind` is ABSENT on purpose — see the file header.
    attrs: {
      src:     { default: '', parseHTML: function (el) { return el.getAttribute('data-src')     || '' } },
      uri:     { default: '', parseHTML: function (el) { return el.getAttribute('data-uri')     || '' } },
      title:   { default: '', parseHTML: function (el) { return el.getAttribute('data-title')   || '' } },
      targetKind: { default: '', parseHTML: function (el) { return el.getAttribute('data-target-kind') || '' } },
      summary: { default: '', parseHTML: function (el) { return el.getAttribute('data-summary') || '' } },
      bytes:   { default: '', parseHTML: function (el) { return el.getAttribute('data-bytes')   || '' } },
      mime:    { default: '', parseHTML: function (el) { return el.getAttribute('data-mime')    || '' } },
      error:   { default: '', parseHTML: function (el) { return el.getAttribute('data-error')   || '' } },
    },

    parseAttrs: function (data) {
      return {
        src:     data.src     || '',
        uri:     data.uri     || '',
        title:   data.title   || '',
        targetKind: data.targetKind || '',
        summary: data.summary || '',
        bytes:   String(data.bytes == null ? '' : data.bytes),
        mime:    data.mime    || '',
        error:   data.error   || '',
      }
    },

    // A citation copies as its coordinate — which the processor claims back as a
    // TRANSFORM when it is pasted, so a copied chip becomes a chip again. A held
    // file has no text form: its bytes live in the document directory.
    asContentEntry: function (node) {
      var uri = (node.attrs.uri || '').trim()
      return uri ? [{ mimeType: 'text/plain', content: uri }] : null
    },

    makeNodeView: makeNodeView,

    buildContextMenuItems: function (opts) {
      var node = opts.node
      var IC = window.SieveIcons || {}
      var target = AttachmentRenderer.targetFor(node.attrs)
      var items = [{ type: 'header', label: 'Attachment' }]
      if (!target) return items

      items.push({
        icon: IC.externalLink,
        label: target.uri ? 'Open Reference' : 'Show in Files',
        action: function () { openTarget(target, uuidOf(opts)) },
      })
      items.push({
        icon: IC.copy,
        label: target.uri ? 'Copy Address' : 'Copy Filename',
        action: function () {
          var text = AttachmentRenderer.copyTextFor(node.attrs)
          if (text) navigator.clipboard.writeText(text).catch(function () {})
        },
      })
      return items
    },
  }

  registerSieveRenderer('attachment', AttachmentNodeView)

  // ── The DESKTOP realisation of the open-an-asset intent ──────────────────
  //
  // A Sieve block opens in Sieve; anything that is not a Sieve block is the
  // filesystem's — even when that filesystem sits inside Sieve's own Library.
  // Revealing in an OS file manager is the desktop half of that, and the only
  // one that exists today: ShowInFilesByID resolves the document to its
  // directory and reveals it, which IS where a held asset lives (a document is a
  // directory). Nothing here LAUNCHES the file — Sieve declines that capability
  // deliberately (a dropped .desktop would be executed, not viewed); reading the
  // asset in place is the chevron's job.
  document.addEventListener(OPEN_ASSET_EVENT, function (e) {
    var uuid = (e.detail && e.detail.uuid) || ''
    if (!uuid) return
    if (window.sieveShowInFiles) window.sieveShowInFiles(uuid)
  })

})()
