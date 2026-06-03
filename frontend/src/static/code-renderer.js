// code-renderer.js — Sieve block renderer for the 'code' kind.
//
// Rendering: textarea + syntax-highlight overlay in the same CSS Grid cell.
//   - textarea (.sieve-block__edit)    transparent text, handles all input natively
//   - pre>code (.sieve-block__highlight)  highlighted HTML, pointer-events:none, sits behind
//
// The textarea's value is the authoritative source — no innerText tricks,
// no div/br newline issues, no cursor-restoration needed.
// Highlight re-applies on input (debounced 50ms) by updating the overlay innerHTML.

import { esc, isStaleByTime, isJobActive, getLowlight, hastToHtml } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // ── CodeRenderer ─────────────────────────────────────────────────────────────

  var CodeRenderer = {

    nodeConfig: {
      atom:       true,
      selectable: false,  // prevents TipTap creating a NodeSelection on click
      draggable:  false,  // mouse drag selects text, not moves the block
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
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)

      // ── DOM ──────────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code'
      dom.setAttribute('data-block-id', node.attrs.id || '')
      dom.contentEditable = 'false'

      // Header + badge
      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      header.contentEditable = 'false'
      var badge = document.createElement('span')
      badge.className = 'sieve-block__badge'
      header.appendChild(badge)
      dom.appendChild(header)

      // Body: flex row — gutter + code-area
      var body = document.createElement('div')
      body.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
      gutter.contentEditable = 'false'

      // CSS Grid cell — highlight layer (behind) + textarea layer (in front)
      var codeArea = document.createElement('div')
      codeArea.className = 'sieve-block__code-area'

      var highlightPre = document.createElement('pre')
      highlightPre.className = 'sieve-block__highlight'
      var highlightCode = document.createElement('code')
      highlightPre.appendChild(highlightCode)

      var editEl = document.createElement('textarea')
      editEl.className = 'sieve-block__edit'
      editEl.spellcheck = false
      editEl.setAttribute('autocorrect', 'off')
      editEl.setAttribute('autocapitalize', 'off')
      editEl.setAttribute('autocomplete', 'off')

      codeArea.appendChild(highlightPre)
      codeArea.appendChild(editEl)
      body.appendChild(gutter)
      body.appendChild(codeArea)
      dom.appendChild(body)

      // ── Helpers ───────────────────────────────────────────────────────────────

      function updateGutter(source) {
        var lines = (source || '').split('\n')
        var count = Math.max(lines.length, 1)
        if (gutter.childElementCount === count) return
        gutter.innerHTML = ''
        for (var i = 1; i <= count; i++) {
          var span = document.createElement('span')
          span.textContent = String(i)
          gutter.appendChild(span)
        }
      }

      function applyHighlight(source, lang) {
        // The trailing space prevents the last line collapsing in the overlay
        var display = source ? source + '\n' : '\n'
        highlightCode.textContent = display
        highlightCode.className = (lang && lang !== 'unknown') ? 'language-' + lang + ' hljs' : 'hljs'
        var low = getLowlight()
        if (low && lang && lang !== 'unknown' && lang !== 'text' && source) {
          try {
            highlightCode.innerHTML = hastToHtml(low.highlight(lang, source).children) + '\n'
          } catch (_) {}
        }
      }

      function updateBadge(attrs) {
        var isPending     = attrs.status === 'PENDING' || attrs.status === 'DISPATCHED'
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

      // Skip DOM content update if the user is actively editing — their typed
      // content (in editEl.value) takes precedence over an incoming AI update.
      function render(attrs) {
        currentAttrs = attrs
        updateBadge(attrs)
        if (document.activeElement !== editEl) {
          editEl.value = attrs.source || ''
          applyHighlight(attrs.source || '', attrs.language || '')
          updateGutter(attrs.source || '')
        }
      }

      render(node.attrs)

      // ── Events ────────────────────────────────────────────────────────────────

      var inputTimer    = null
      var highlightTimer = null

      function flushSource() {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'code', attrs: { source: editEl.value } },
        }))
      }

      editEl.addEventListener('input', function () {
        // Immediate gutter update
        updateGutter(editEl.value)

        // Highlight overlay update — 50ms debounce is imperceptible to humans
        clearTimeout(highlightTimer)
        highlightTimer = setTimeout(function () {
          applyHighlight(editEl.value, currentAttrs.language || '')
        }, 50)

        // Flush to Go shadow
        clearTimeout(inputTimer)
        inputTimer = setTimeout(flushSource, 200)
      })

      editEl.addEventListener('blur', function () {
        clearTimeout(highlightTimer)
        clearTimeout(inputTimer)
        flushSource()
        applyHighlight(editEl.value, currentAttrs.language || '')
        updateGutter(editEl.value)
      })

      editEl.addEventListener('paste', function (e) {
        e.stopPropagation()
      })

      editEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault()
          var start = editEl.selectionStart
          var end   = editEl.selectionEnd
          editEl.value = editEl.value.substring(0, start) + '  ' + editEl.value.substring(end)
          editEl.selectionStart = editEl.selectionEnd = start + 2
          updateGutter(editEl.value)
          clearTimeout(highlightTimer)
          highlightTimer = setTimeout(function () {
            applyHighlight(editEl.value, currentAttrs.language || '')
          }, 50)
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
          if (updatedNode.type.name !== nodeTypeName) return false
          render(updatedNode.attrs)
          return true
        },

        selectNode: function () { editEl.focus() },

        ignoreMutation: function () { return true },

        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },

        destroy: function () {
          clearTimeout(inputTimer)
          clearTimeout(highlightTimer)
        },
      }
    },
  }

  CodeRenderer.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editor = ctx.editor, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

    function codeCtx() {
      return {
        content:      n.attrs.source || '',
        blockRef:     n.attrs.id || 'doc',
        history:      '',
        contextLabel: 'Code Block',
        imageIds:     [],
      }
    }

    var isRetryable = n.attrs.status !== 'PENDING' && n.attrs.status !== 'DISPATCHED'

    return [
      { icon: IC.trash,        label: 'Delete',             action: del },
      { type: 'divider' },
      { icon: IC.sparkle,      label: 'Ask AI…',            action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: codeCtx() } }))
      }},
      { icon: IC.info,         label: 'Explain',            action: function () {
        document.dispatchEvent(new CustomEvent('sieve:ai-explain', { detail: { precomputedCtx: codeCtx() } }))
      }},
      { type: 'divider' },
      { icon: IC.refresh,      label: isRetryable ? 'Replay' : 'Retry',
        disabled: !n.attrs.source,
        action: function () {
          document.dispatchEvent(new CustomEvent('sieve:block-retry', { detail: { id: n.attrs.id } }))
        },
      },
    ]
  }

  T.registerSieveRenderer('code', CodeRenderer)

})()
