// smart-image-renderer.js — Sieve NodeView ADAPTER for the 'smart-image' kind
// (the PM half of the renderer/NodeView split, docs/design/specs/2026-07-20-block-renderer-extraction.md
// Phase 4 / issue #47). Look-and-feel (the image wrapper, resize handle,
// status badge, this kind's stylesheet) lives in SmartImageRenderer
// (frontend/src/static/block/renderers/smart-image-renderer.js — a DIFFERENT
// class, deliberately same basename, different directory). This file HOLDS a
// SmartImageRenderer instance by COMPOSITION and owns the genuinely
// PM/framework-side pieces: schema data (nodeConfig/attrs/parseAttrs), the
// resize-commit write path (ctx.updateAttributes), and resolving `src` +
// `parsedAssetRef`-shaped asset URLs against the held Editor's document uuid
// — SmartImageRenderer.resolveSrc itself is a pure (src, uuid) function with
// no ctx dependency (see that class for why).

import { registerSieveRenderer } from '../block/sieve-block-extension.js'
import { renderMermaidSvgEntry } from './diagram-renderer.js'
import { SmartImageRenderer } from '../block/renderers/smart-image-renderer.js'

;(function () {
  'use strict'

  function makeNodeView(node, editorPane, getPos, ctx) {
    var nodeTypeName = 'sieve-smart-image'

    // The renderer instance this NodeView HOLDS by composition (never
    // inheritance — see the file header). All look-and-feel (wrapper,
    // resizer, badge) is its job; this adapter only supplies PM-only
    // concerns (schema data, the resize-commit write, src resolution)
    // around it.
    var renderer = new SmartImageRenderer()
    renderer.onResize(function (dims) { ctx.updateAttributes(dims) })

    function effectiveAttrs(attrs) {
      return Object.assign({}, attrs, { src: SmartImageRenderer.resolveSrc(attrs.src || '', ctx && ctx.getEditor() && ctx.getEditor().uuid) })
    }

    var dom = renderer.mount(effectiveAttrs(node.attrs))

    return {
      dom: dom,
      update: function (updatedNode) {
        if (updatedNode.type.name !== nodeTypeName) return false
        renderer.update(dom, effectiveAttrs(updatedNode.attrs))
        return true
      },
    }
  }

  var SmartImageNodeAdapter = {
    getIcon: function() { return window.SieveIcons && window.SieveIcons.image },
    getFriendlyName: function() { return 'Image' },

    // Atom: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true, expandable: true },

    // Pure display-only image — no editable body. A true atom (no contentDOM), so the
    // framework forces contentEditable=false and there is no phantom caret region.
    nodeConfig: {
      atom: true,
      selectable: true,
      draggable: false,
      group: 'block',
      inline: false
    },

    attrs: {
      src:     { default: '', parseHTML: function (el) { return el.getAttribute('data-src')     || '' } },
      alt:     { default: '', parseHTML: function (el) { return el.getAttribute('data-alt')     || '' } },
      summary: { default: '', parseHTML: function (el) { return el.getAttribute('data-summary') || '' } },
      detect:  { default: '', parseHTML: function (el) { return el.getAttribute('data-detect')  || '' } },
      width:   { default: '', parseHTML: function (el) { return el.getAttribute('data-width')   || '' } },
      height:  { default: '', parseHTML: function (el) { return el.getAttribute('data-height')  || '' } },
      error:   { default: '', parseHTML: function (el) { return el.getAttribute('data-error')   || '' } },
    },

    asContentEntry: function(node) {
      if (!node.attrs.src) return null
      return [{ mimeType: 'text/uri-list', content: node.attrs.src }]
    },

    makeNodeView: makeNodeView,

    buildAiCtx: function(node) {
      return { contextLabel: 'Image', imageIds: node.attrs.id ? [node.attrs.id] : [] }
    },

    // getExpandContent — a fresh <img> at the resolved src. Null while the asset
    // job is PENDING/DISPATCHED or errored (nothing meaningful to show yet).
    getExpandContent: function (node, _dom) {
      if (!node || !node.attrs || !node.attrs.src) return null
      var status = node.attrs.status || 'PENDING'
      if (status === 'PENDING' || status === 'DISPATCHED' || status === 'ERROR' || status === 'TIMEOUT') return null
      var img = document.createElement('img')
      // resolveSrc is pure (src, uuid) — no ctx. getExpandContent gets (node, dom)
      // not the block ctx, so reach the active editor the same way other
      // view-layer code does — window.sieveWorkspace.activeEditor (has .uuid). A
      // document is only ever open in the single active tab, so activeEditor is
      // THIS block's editor.
      var activeEditor = window.sieveWorkspace && window.sieveWorkspace.activeEditor
      img.src = SmartImageRenderer.resolveSrc(node.attrs.src, activeEditor && activeEditor.uuid)
      img.alt = node.attrs.alt || ''
      return { element: img, title: node.attrs.alt || 'Image', mode: 'media' }
    },


    parseAttrs: function (data) {
      return {
        src:     data.src     || '',
        alt:     data.alt     || '',
        summary: data.summary || '',
        detect:  data.detect  || '',
        width:   String(data.width  || ''),
        height:  String(data.height || ''),
        error:   data.error   || '',
      }
    },
    buildContextMenuItems: function(ctx) {
      var n = ctx.node
      return [
        { type: 'header', label: "Image"},
        { icon: window.SieveIcons.copy, label: 'Copy Image', action: function () {
          var src = SmartImageRenderer.resolveSrc(n.attrs.src, ctx && ctx.getEditor() && ctx.getEditor().uuid)
          if (!src) return
          fetch(src)
            .then(function (res) { return res.blob() })
            .then(function (blob) {
              if (navigator.clipboard && navigator.clipboard.write) {
                var item = {}
                item[blob.type] = blob
                navigator.clipboard.write([new ClipboardItem(item)])
              }
            }).catch(function (err) { console.error('Failed to copy image', err) })
        }},

      ]
    },
    // Extract → Image: render the diagram's mermaid to SVG and REPLACE the entries with
    // it, so Transform's saveSVG writes the image. Shared render helper lives in
    // diagram-renderer.js; null = no mermaid here (pass entries through unchanged).
    resolveEntries: function(sourceNode, entries) {
      return renderMermaidSvgEntry(sourceNode, entries).then(function (svg) {
        return svg ? [svg] : entries
      }).catch(function (err) {
        console.error('[smart-image] mermaid render failed for extraction', err)
        window.alert('Failed to extract diagram: ' + err.message)
        return entries
      })
    }
  }

  registerSieveRenderer('smart-image', SmartImageNodeAdapter)

})()
