// smart-image-renderer.js — Renderer for the smart-image Sieve Block.
// Matches the visual structure of the old ImageWithAttrs NodeView so existing
// image CSS (.image-block, .node-image, .image-resizer) works unchanged.

import { isJobStale } from '../base/fenced-block-base.js'
import { registerSieveRenderer } from '../block/sieve-block-extension.js'
import { renderMermaidSvgEntry } from './diagram-renderer.js'

;(function () {
  'use strict'

  function resolveSrc(src) {
    if (!src) return ''
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
    }
    if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/')) return src
    if (src.startsWith('.assets/')) src = src.substring(8)
    return '/sieve/' + (window.__stashActiveTabUuid || '') + '/' + src.split('/').pop()
  }

  

  function makeNodeView(node, editor) {
    var currentAttrs = Object.assign({}, node.attrs)

    // dom matches old ImageWithAttrs: inline-block wrapper that owns selection CSS
    var nodeTypeName = 'sieve-smart-image'
    var dom = document.createElement('div')
    dom.className = 'image-block node-image'
    dom.style.display = 'inline-block'

    var img = document.createElement('img')
    img.style.maxWidth = '100%'
    img.style.display = 'block'

    var resizer = document.createElement('div')
    resizer.className = 'image-resizer'

    // Status badge — shows "Processing…" while PENDING, hidden when COMPLETE
    var badge = document.createElement('span')
    badge.className = 'smart-image-status'
    badge.style.cssText = 'position:absolute;top:6px;left:6px;font-size:10px;padding:2px 6px;border-radius:4px;pointer-events:none;display:none'

    dom.appendChild(img)
    dom.appendChild(resizer)
    dom.appendChild(badge)

    function applyAttrs(attrs) {
      currentAttrs = attrs
      img.src = resolveSrc(attrs.src || '')
      img.alt = attrs.alt || ''
      var w = attrs.width  || ''
      var h = attrs.height || ''
      img.style.width  = w ? (String(w).match(/^\d+$/) ? w + 'px' : w) : ''
      img.style.height = h ? (String(h).match(/^\d+$/) ? h + 'px' : h) : ''
      if (attrs.summary) dom.setAttribute('data-tooltip', attrs.summary)
      else dom.removeAttribute('data-tooltip')
      if (attrs.id) dom.setAttribute('data-id', attrs.id)

      // Badge visibility.
      // DISPATCHED = job is actively running → always show Processing.
      // PENDING = waiting to dispatch → stale if createdAt > 15s ago.
      var status = attrs.status || 'PENDING'
      var isStale = status === 'PENDING' && isJobStale(attrs.createdAt, attrs.id)
      if ((status === 'PENDING' || status === 'DISPATCHED') && !isStale) {
        badge.textContent = 'Processing…'
        badge.style.display = 'block'
        badge.style.background = 'rgba(0,0,0,0.55)'
        badge.style.color = '#fff'
      } else if (isStale || status === 'ERROR' || status === 'TIMEOUT') {
        // Surface the framework's specific error text (classifyJobError writes
        // {status, error}); fall back to a generic label. TIMEOUT mirrors
        // web-clip-renderer's timeout state.
        var errText = (attrs.error || '').trim()
        badge.textContent = errText || (status === 'TIMEOUT' ? 'Timed out' : 'Failed')
        badge.style.display = 'block'
        badge.style.background = 'rgba(180,0,0,0.75)'
        badge.style.color = '#fff'
        if (errText) dom.setAttribute('data-tooltip', errText)
      } else {
        badge.style.display = 'none'
      }
    }

    applyAttrs(node.attrs)

    // Resize drag — maintains aspect ratio
    var isResizing = false, startX, startW, startH, ratio

    resizer.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation()
      isResizing = true; startX = e.clientX
      startW = img.clientWidth; startH = img.clientHeight
      ratio = startH > 0 ? startW / startH : 1
      document.body.style.cursor = 'nwse-resize'

      function onMove(e) {
        if (!isResizing) return
        var w = Math.max(40, startW + (e.clientX - startX))
        var h = Math.round(w / ratio)
        img.style.width = w + 'px'; img.style.height = h + 'px'
      }

      function onUp() {
        if (!isResizing) return
        isResizing = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'smart-image', attrs: {
            width:  String(Math.round(img.offsetWidth)),
            height: String(Math.round(img.offsetHeight)),
          }}
        }))
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })

    return {
      dom: dom,
      update: function (updatedNode) {
        if (updatedNode.type.name !== nodeTypeName) return false
        applyAttrs(updatedNode.attrs)
        return true
      },
    }
  }

  var SmartImageRenderer = {
    getIcon: function() { return window.SieveIcons && window.SieveIcons.image },
    getFriendlyName: function() { return 'Image' },

    // Atom: arrows treat it as a single caret stop.
    interactionPolicy: { caretStop: true },

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
          var src = resolveSrc(n.attrs.src)
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

  registerSieveRenderer('smart-image', SmartImageRenderer)

})()
