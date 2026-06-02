// code-renderer.js — Sieve block renderer for the 'code' kind.
//
// Renderer interface implemented:
//   nodeConfig   selectable:false, draggable:false — mouse drag selects text, not moves block
//   attrs        source, language, detectionMethod
//   parseAttrs   extracts source/language/detectionMethod from YAML on fence parse
//   makeNodeView gutter (line numbers) + contenteditable code element
//
// On focus:  highlight spans stripped → plain text for clean cursor behaviour
// On blur:   lowlight syntax highlighting re-applied + gutter updated
// On input:  gutter line count updated + debounced sieve:block-update to Go shadow
// Tab:       inserts two spaces via Selection API
// selectNode: focuses codeEl when TipTap selects the atom via keyboard,
//             preventing TipTap from deleting the node on the next keypress

import { esc, isStaleByTime, isJobActive } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // ── Shared lowlight instance (lazy) ──────────────────────────────────────────

  var _low = null
  function getLow() {
    if (!_low && T && T.createLowlight && T.common) _low = T.createLowlight(T.common)
    return _low
  }

  function hastToHtml(nodes) {
    return (nodes || []).map(function (n) {
      if (n.type === 'text') {
        return n.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      }
      if (n.type === 'element') {
        var cls = (n.properties && n.properties.className || []).join(' ')
        return '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + hastToHtml(n.children) + '</span>'
      }
      return ''
    }).join('')
  }

  // ── CodeRenderer ─────────────────────────────────────────────────────────────

  var CodeRenderer = {

    nodeConfig: {
      atom:       true,
      selectable: false,  // prevents click creating a NodeSelection over the whole block
      draggable:  false,  // mouse drag selects text; block moved only via explicit handle
    },

    attrs: {
      source:          { default: '', parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
      language:        { default: '', parseHTML: function (el) { return el.getAttribute('data-language')         || '' } },
      detectionMethod: { default: '', parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
    },

    parseAttrs: function (data) {
      return {
        language:        data.language        || '',
        source:          typeof data.source === 'string' ? data.source : '',
        detectionMethod: data.detectionMethod || '',
      }
    },

    makeNodeView: function (node) {
      var currentAttrs = Object.assign({}, node.attrs)

      // ── DOM ──────────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code'
      dom.setAttribute('data-block-id', node.attrs.id || '')
      dom.contentEditable = 'false'

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      header.contentEditable = 'false'

      var badge = document.createElement('span')
      badge.className = 'sieve-block__badge'
      header.appendChild(badge)
      dom.appendChild(header)

      var body = document.createElement('div')
      body.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
      gutter.contentEditable = 'false'

      var pre = document.createElement('pre')
      pre.className = 'sieve-block__pre'

      var codeEl = document.createElement('code')
      codeEl.className = 'sieve-block__source'
      codeEl.contentEditable = 'true'
      codeEl.spellcheck = false
      codeEl.setAttribute('autocorrect', 'off')
      codeEl.setAttribute('autocapitalize', 'off')

      pre.appendChild(codeEl)
      body.appendChild(gutter)
      body.appendChild(pre)
      dom.appendChild(body)

      // ── Gutter ────────────────────────────────────────────────────────────────

      function updateGutter(source) {
        var lines = (source || '').split('\n')
        var count = Math.max((lines[lines.length - 1] === '') ? lines.length - 1 : lines.length, 1)
        if (gutter.childElementCount === count) return
        gutter.innerHTML = ''
        for (var i = 1; i <= count; i++) {
          var span = document.createElement('span')
          span.textContent = String(i)
          gutter.appendChild(span)
        }
      }

      // ── Highlighting ──────────────────────────────────────────────────────────

      function applyHighlight(source, lang) {
        codeEl.textContent = source || ''
        var langClass = (lang && lang !== 'unknown') ? 'language-' + lang : 'language-text'
        codeEl.className = 'sieve-block__source hljs ' + langClass
        var low = getLow()
        if (low && lang && lang !== 'unknown' && lang !== 'text' && source) {
          try { codeEl.innerHTML = hastToHtml(low.highlight(lang, source).children) } catch (_) {}
        }
      }

      // ── Badge ─────────────────────────────────────────────────────────────────

      function updateBadge(attrs) {
        var isPending     = attrs.status === 'PENDING'
        var isStale       = isPending && !isJobActive(attrs.id) && isStaleByTime(attrs.createdAt)
        var showDetecting = isPending && !isStale && (!attrs.language || attrs.language === '')

        if (showDetecting) {
          badge.textContent = 'detecting…'
          badge.className   = 'sieve-block__badge sieve-block__badge--pending'
        } else if (attrs.language && attrs.language !== 'unknown') {
          badge.textContent = attrs.language
          badge.className   = 'sieve-block__badge'
        } else {
          badge.textContent = attrs.language || ''
          badge.className   = 'sieve-block__badge sieve-block__badge--unknown'
        }

        if (attrs.detectionMethod) {
          badge.setAttribute('data-detection-method', attrs.detectionMethod)
          badge.title = 'Detected via ' + attrs.detectionMethod
        } else {
          badge.removeAttribute('data-detection-method')
          badge.removeAttribute('title')
        }
      }

      // ── Render ────────────────────────────────────────────────────────────────

      function render(attrs) {
        currentAttrs = attrs
        updateBadge(attrs)
        if (document.activeElement !== codeEl) {
          applyHighlight(attrs.source || '', attrs.language || '')
          updateGutter(attrs.source || '')
        }
      }

      render(node.attrs)

      // ── Events ────────────────────────────────────────────────────────────────

      var inputTimer = null

      function rawSource() {
        var s = codeEl.innerText || ''
        return s.endsWith('\n') ? s.slice(0, -1) : s
      }

      function flushSource() {
        clearTimeout(inputTimer)
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'code', attrs: { source: rawSource() } },
        }))
      }

      codeEl.addEventListener('focus', function () {
        // Strip highlight spans on focus so cursor positions map to plain characters.
        var src = rawSource()
        codeEl.textContent = src
        codeEl.className = 'sieve-block__source'
      })

      codeEl.addEventListener('input', function () {
        updateGutter(codeEl.innerText || '')
        clearTimeout(inputTimer)
        inputTimer = setTimeout(flushSource, 200)
      })

      codeEl.addEventListener('blur', function () {
        flushSource()
        var src = rawSource()
        applyHighlight(src, currentAttrs.language || '')
        updateGutter(src)
      })

      codeEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault()
          var sel = window.getSelection()
          if (sel && sel.rangeCount) {
            var range = sel.getRangeAt(0)
            range.deleteContents()
            range.insertNode(document.createTextNode('  '))
            range.collapse(false)
            sel.removeAllRanges()
            sel.addRange(range)
          }
          updateGutter(codeEl.innerText || '')
          clearTimeout(inputTimer)
          inputTimer = setTimeout(flushSource, 200)
          return
        }
        if (e.metaKey || e.ctrlKey) return
        e.stopPropagation()
      })

      // ── NodeView ──────────────────────────────────────────────────────────────

      return {
        dom:        dom,
        contentDOM: null,

        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-code') return false
          render(updatedNode.attrs)
          return true
        },

        // When TipTap selects this atom via keyboard navigation, focus the code
        // element immediately so the next keypress types rather than deletes the node.
        selectNode: function () { codeEl.focus() },

        ignoreMutation: function () { return true },

        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },

        destroy: function () { clearTimeout(inputTimer) },
      }
    },
  }

  // Self-register. sieve-block-extension.js must appear before this script in index.html.
  T.registerSieveRenderer('code', CodeRenderer)

})()
