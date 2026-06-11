// diagram-renderer.js — Sieve block renderer for the 'diagram' kind.
//
// Edit mode: textarea + syntax-highlight overlay + line gutter (same pattern as code-renderer.js).
// Render mode: SVG from mermaid.js, lazy-loaded from vendor/mermaid.min.js.
// Mode and cursor position are persisted in YAML via sieve:block-update so they survive reloads.

import { getLowlight, hastToHtml } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap

  // ── Mermaid lazy-loader ───────────────────────────────────────────────────────

  var mermaidReady = null

  function ensureMermaid() {
    if (mermaidReady) return mermaidReady
    mermaidReady = new Promise(function (resolve, reject) {
      if (window.mermaid) { initMermaid(); resolve(); return }
      var s = document.createElement('script')
      s.src = '/static/vendor/mermaid.min.js'
      s.onload = function () { initMermaid(); resolve() }
      s.onerror = function () { mermaidReady = null; reject(new Error('Failed to load mermaid.min.js')) }
      document.head.appendChild(s)
    })
    return mermaidReady
  }
  T.ensureMermaid = ensureMermaid

  function buildMermaidTheme() {
    var s = getComputedStyle(document.documentElement)
    function v(name) { return s.getPropertyValue(name).trim() }
    var bgDark    = v('--theme-bgDark')        || '#0e0e0e'
    var bgAlt     = v('--theme-bgAlt')         || '#1a1a1a'
    var text      = v('--theme-text')          || '#cccccc'
    var textDim   = v('--theme-textDim')       || '#888888'
    var accent    = v('--theme-accentPrimary') || '#7aa2f7'
    var accentCy  = v('--theme-accentCyan')    || '#7dcfff'
    var accentGr  = v('--theme-accentGreen')   || '#9ece6a'
    var border    = v('--theme-border')        || '#2a2a2a'
    var border2   = v('--theme-border2')       || '#3a3a3a'

    return {
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        // Typography
        fontFamily:           v('--theme-monoFont') || 'monospace',
        fontSize:             '12px',

        // Nodes
        background:           bgDark,
        primaryColor:         accent,
        primaryBorderColor:   accent,
        primaryTextColor:     bgDark,
        secondaryColor:       accentCy,
        secondaryBorderColor: accentCy,
        secondaryTextColor:   bgDark,
        tertiaryColor:        accentGr,
        tertiaryBorderColor:  accentGr,
        tertiaryTextColor:    bgDark,

        // Edges & labels
        lineColor:            textDim,
        edgeLabelBackground:  'transparent',
        labelColor:           text,
        labelTextColor:       text,

        // Subgraphs / clusters
        clusterBkg:           bgAlt,
        clusterBorder:        border2,
        titleColor:           textDim,

        // Special shapes (diamonds, cylinders, circles)
        nodeBorder:           border2,
        mainBkg:              accent,
        specNodeLabelColor:   bgDark,
        attributeBackgroundColorOdd:  bgAlt,
        attributeBackgroundColorEven: bgDark,
      },
    }
  }

  function initMermaid() {
    if (!window.mermaid) return
    window.mermaid.initialize(buildMermaidTheme())
  }

  // All active NodeViews register a rerender fn so theme changes re-render live SVGs.
  var activeRenderers = []

  document.addEventListener('sse:settings:changed', function () {
    if (window.mermaid) {
      initMermaid()
      activeRenderers.forEach(function (r) { r() })
    }
  })

  // ── Helpers ───────────────────────────────────────────────────────────────────

  var renderCounter = 0

  function uniqueMermaidId(blockId) {
    return 'mermaid-' + (blockId || 'di') + '-' + (++renderCounter)
  }

  function updateGutter(gutter, source) {
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

  function applyHighlight(highlightCode, source) {
    var low = getLowlight()
    if (low && source) {
      try {
        var result = low.highlight('mermaid', source)
        highlightCode.innerHTML = hastToHtml(result.children) + '\n'
        highlightCode.className = 'language-mermaid hljs'
        return
      } catch (_) {
        // lowlight doesn't know mermaid — fall through to plain text
      }
    }
    highlightCode.textContent = (source ? source + '\n' : '\n')
    highlightCode.className = 'hljs'
  }

  // ── DiagramRenderer ───────────────────────────────────────────────────────────

  var DiagramRenderer = {

    // No nodeConfig overrides: all sieve blocks share the default schema
    // (atom + selectable + draggable) for a uniform, non-disjoint selection.
    // Clicks/typing inside the textarea are shielded from ProseMirror centrally
    // via the stopEvent hook in sieve-block-extension.js, so this block stays
    // selectable without editor interactions triggering a stray NodeSelection.

    attrs: {
      source:      { default: '', parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      diagramType: { default: 'mermaid', parseHTML: function (el) { return el.getAttribute('data-diagram-type') || 'mermaid' } },
      mode:        { default: 'render', parseHTML: function (el) { return el.getAttribute('data-mode')   || 'render' } },
      cursorPos:   { default: 0,        parseHTML: function (el) { return parseInt(el.getAttribute('data-cursor-pos'))  || 0 } },
    },

    getFriendlyName: function() { return 'Diagram' },

    asContentEntry: function(node) {
      if (!node.attrs.source) return null
      return  [{ mimeType: 'text/plain', content: node.attrs.source }]
    },

    parseAttrs: function (data) {
      return {
        source:      typeof data.source === 'string' ? data.source : '',
        diagramType: data.diagramType || 'mermaid',
        mode:        data.mode        || 'render',
        cursorPos:   typeof data.cursorPos === 'number' ? data.cursorPos : 0,
      }
    },

    makeNodeView: function (node, editor) {
      var nodeTypeName = node.type.name
      var currentAttrs = Object.assign({}, node.attrs)
      var destroyed    = false

      // ── DOM shell ─────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--diagram'
      dom.setAttribute('data-id', node.attrs.id || '')

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })

      // ── Header ────────────────────────────────────────────────────────────────

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      var badge = document.createElement('span')
      badge.className = 'sieve-block__badge'
      badge.textContent = 'diagram'

      var typeLabel = document.createElement('span')
      typeLabel.className = 'sieve-block__type-label'
      typeLabel.textContent = 'mermaid'

      var headerSpacer = document.createElement('div')
      headerSpacer.style.flex = '1'

      var toggle = document.createElement('div')
      toggle.className = 'diagram-block__toggle'

      var editBtn = document.createElement('button')
      editBtn.className = 'diagram-block__toggle-btn'
      editBtn.setAttribute('data-toggle', 'edit')
      editBtn.innerHTML =
        '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<path d="M1 7.5 L6 2 L8 4 L3 9 L1 9 Z"/><line x1="5" y1="3" x2="7" y2="5"/></svg> Edit'

      var renderBtn = document.createElement('button')
      renderBtn.className = 'diagram-block__toggle-btn'
      renderBtn.setAttribute('data-toggle', 'render')
      renderBtn.innerHTML =
        '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<ellipse cx="5" cy="5" rx="4" ry="2.5"/>' +
        '<circle cx="5" cy="5" r="1.2" fill="currentColor" stroke="none"/></svg> Render'

      toggle.appendChild(editBtn)
      toggle.appendChild(renderBtn)
      header.appendChild(badge)
      header.appendChild(typeLabel)
      header.appendChild(headerSpacer)
      header.appendChild(toggle)
      dom.appendChild(header)

      // ── Edit body ─────────────────────────────────────────────────────────────

      var editBody = document.createElement('div')
      editBody.className = 'sieve-block__body'

      var gutter = document.createElement('div')
      gutter.className = 'sieve-block__gutter'
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
      editBody.appendChild(gutter)
      editBody.appendChild(codeArea)

      // ── Render body ───────────────────────────────────────────────────────────

      var renderBody = document.createElement('div')
      renderBody.className = 'diagram-block__render'
      renderBody.setAttribute('tabindex', '0')
      renderBody.style.outline = 'none'

      // ── Helpers ───────────────────────────────────────────────────────────────

      function flushSource() {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: { source: editEl.value } },
        }))
      }

      // Dispatch a mode change. When switching to render, include the current
      // cursor position so it is persisted in YAML and survives document reloads.
      function switchMode(newMode) {
        var attrs = { mode: newMode }
        if (newMode === 'render') attrs.cursorPos = editEl.selectionStart
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: attrs },
        }))
      }

      function updateToggle(mode) {
        editBtn.className = 'diagram-block__toggle-btn' +
          (mode === 'edit' ? ' diagram-block__toggle-btn--active-edit' : '')
        renderBtn.className = 'diagram-block__toggle-btn' +
          (mode === 'render' ? ' diagram-block__toggle-btn--active-render' : '')
      }

      // ── Render functions ──────────────────────────────────────────────────────

      // showEdit detects whether this is a render→edit mode switch by checking
      // whether renderBody was in the DOM. If so, it auto-focuses the textarea and
      // restores the cursor position from attrs.cursorPos (persisted in YAML).
      function showEdit(attrs) {
        var comingFromRender = dom.contains(renderBody)
        if (comingFromRender) dom.removeChild(renderBody)
        if (!dom.contains(editBody)) dom.appendChild(editBody)
        if (document.activeElement !== editEl) {
          editEl.value = attrs.source || ''
          applyHighlight(highlightCode, attrs.source || '')
          updateGutter(gutter, attrs.source || '')
          if (comingFromRender) {
            editEl.focus()
            var pos = typeof attrs.cursorPos === 'number' ? attrs.cursorPos : 0
            editEl.selectionStart = editEl.selectionEnd = Math.min(pos, editEl.value.length)
          }
        }
      }

      function showRender(attrs) {
        var comingFromEdit = dom.contains(editBody)
        if (comingFromEdit) dom.removeChild(editBody)
        if (!dom.contains(renderBody)) dom.appendChild(renderBody)
        // Give the render area keyboard focus so Ctrl+Enter can flip back to edit.
        if (comingFromEdit) renderBody.focus()

        var src = (attrs.source || '').trim()

        if (!src) {
          renderBody.innerHTML =
            '<div class="diagram-block__loading" style="color:var(--theme-fg3);font-size:12px;padding:20px">' +
            'Add diagram source in Edit mode</div>'
          return
        }

        renderBody.innerHTML = '<div class="diagram-block__loading"><span class="diagram-block__spinner"></span>Rendering…</div>'

        ensureMermaid().then(function () {
          var id = uniqueMermaidId(attrs.id)
          return window.mermaid.render(id, src)
        }).then(function (result) {
          if (destroyed) return
          renderBody.innerHTML = result.svg
        }).catch(function (err) {
          if (destroyed) return
          var msg = (err && err.message) ? err.message : String(err)
          renderBody.innerHTML =
            '<div class="diagram-block__error">' +
            '<div class="diagram-block__error-icon">⚠</div>' +
            '<div>' +
            '<div class="diagram-block__error-title">Diagram syntax error</div>' +
            '<div class="diagram-block__error-msg">' + msg.replace(/</g, '&lt;') + '</div>' +
            '</div></div>'
        })
      }

      function render(attrs) {
        currentAttrs = attrs
        updateToggle(attrs.mode)
        if (attrs.mode === 'render') {
          showRender(attrs)
        } else {
          showEdit(attrs)
        }
      }

      render(node.attrs)

      // Register for theme-change re-renders; cleaned up in destroy().
      function rerender() {
        if (currentAttrs.mode === 'render') showRender(currentAttrs)
      }
      activeRenderers.push(rerender)

      // ── Events ────────────────────────────────────────────────────────────────

      editBtn.addEventListener('mousedown', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (currentAttrs.mode !== 'edit') {
          switchMode('edit')
        } else {
          editEl.focus()
        }
      })

      renderBtn.addEventListener('mousedown', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (currentAttrs.mode !== 'render') {
          flushSource()
          switchMode('render')
        }
      })

      var inputTimer = null
      var highlightTimer = null

      editEl.addEventListener('input', function () {
        updateGutter(gutter, editEl.value)
        clearTimeout(highlightTimer)
        highlightTimer = setTimeout(function () {
          applyHighlight(highlightCode, editEl.value)
        }, 50)
        clearTimeout(inputTimer)
        inputTimer = setTimeout(flushSource, 200)
      })

      editEl.addEventListener('blur', function () {
        clearTimeout(highlightTimer)
        clearTimeout(inputTimer)
        flushSource()
        applyHighlight(highlightCode, editEl.value)
        updateGutter(gutter, editEl.value)
      })

      editEl.addEventListener('paste', function (e) { e.stopPropagation() })

      editEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault()
          var start = editEl.selectionStart
          var end   = editEl.selectionEnd
          editEl.value = editEl.value.substring(0, start) + '  ' + editEl.value.substring(end)
          editEl.selectionStart = editEl.selectionEnd = start + 2
          updateGutter(gutter, editEl.value)
          clearTimeout(highlightTimer)
          highlightTimer = setTimeout(function () { applyHighlight(highlightCode, editEl.value) }, 50)
          clearTimeout(inputTimer)
          inputTimer = setTimeout(flushSource, 200)
          return
        }
        // Ctrl+Enter / Cmd+Enter: flush source and switch to render mode
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          flushSource()
          switchMode('render')
          return
        }
        if (e.metaKey || e.ctrlKey) return
        e.stopPropagation()
      })

      // Ctrl+Enter / Cmd+Enter in render mode: flip back to edit.
      // stopPropagation prevents the event bubbling to TipTap's root listener.
      renderBody.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          e.stopPropagation()
          switchMode('edit')
        }
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

        selectNode: function () {
          if (currentAttrs.mode === 'edit') editEl.focus()
        },

        ignoreMutation: function () { return true },

        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },

        destroy: function () {
          destroyed = true
          activeRenderers = activeRenderers.filter(function (r) { return r !== rerender })
          clearTimeout(inputTimer)
          clearTimeout(highlightTimer)
        },
      }
    },
  }

  // ── Context menu ──────────────────────────────────────────────────────────────
  // Ask AI, Explain, and Delete are injected by sieve-block-extension.js framework.

  DiagramRenderer.buildAiCtx = function () { return { contextLabel: 'Diagram' } }

  DiagramRenderer.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editor = ctx.editor, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function toggleMode() {
      var newMode = n.attrs.mode === 'render' ? 'edit' : 'render'
      document.dispatchEvent(new CustomEvent('sieve:block-update', {
        detail: { id: n.attrs.id, kind: 'diagram', attrs: { mode: newMode } },
      }))
    }

    function copySource() {
      if (n.attrs.source) navigator.clipboard.writeText(n.attrs.source)
    }

    var modeLabel = n.attrs.mode === 'render' ? 'Edit source' : 'Render'

    return [
      { icon: IC.edit, label: modeLabel, action: toggleMode },
      { icon: IC.copy, label: 'Copy source', action: copySource },
    ]
  }

  T.registerSieveRenderer('diagram', DiagramRenderer)

})()
