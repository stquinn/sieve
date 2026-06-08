// diagram-renderer.js — Sieve block renderer for the 'diagram' kind.
//
// Edit mode: textarea + syntax-highlight overlay + line gutter (same pattern as code-renderer.js).
// Render mode: SVG from mermaid.js, lazy-loaded from vendor/mermaid.min.js.
// Mode is persisted in YAML via sieve:block-update so it survives document reload.

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

  function buildMermaidTheme() {
    var s = getComputedStyle(document.documentElement)
    function v(name) { return s.getPropertyValue(name).trim() }
    return {
      startOnLoad: false,
      theme: 'base',
      themeVariables: {
        background:          v('--theme-bgDark')  || '#0e0e0e',
        primaryColor:        v('--theme-bgAlt')   || '#1a1a1a',
        primaryTextColor:    v('--theme-text')     || '#cccccc',
        lineColor:           v('--theme-fg3')      || '#555555',
        edgeLabelBackground: v('--theme-bgDark')  || '#0e0e0e',
        nodeBorder:          v('--theme-border2')  || '#3a3a3a',
        clusterBkg:          v('--theme-bgAlt')   || '#1a1a1a',
      },
    }
  }

  function initMermaid() {
    if (!window.mermaid) return
    window.mermaid.initialize(buildMermaidTheme())
  }

  // Re-theme on settings change
  document.addEventListener('sse:settings:changed', function () {
    if (window.mermaid) initMermaid()
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
    var display = source ? source + '\n' : '\n'
    highlightCode.textContent = display
    highlightCode.className = 'hljs'
    // mermaid syntax may not be available in lowlight — fall back to plain text
    var low = getLowlight()
    if (low && source) {
      try {
        var result = low.highlight('mermaid', source)
        highlightCode.innerHTML = hastToHtml(result.children) + '\n'
        highlightCode.className = 'language-mermaid hljs'
      } catch (_) {
        // lowlight doesn't know mermaid — plain text overlay is fine
      }
    }
  }

  // ── DiagramRenderer ───────────────────────────────────────────────────────────

  var DiagramRenderer = {

    nodeConfig: {
      atom:       true,
      selectable: false,  // textarea in edit mode needs mouse to select text, not the node
      draggable:  false,
    },

    attrs: {
      source:      { default: '', parseHTML: function (el) { return el.getAttribute('data-source')       || '' } },
      diagramType: { default: 'mermaid', parseHTML: function (el) { return el.getAttribute('data-diagram-type') || 'mermaid' } },
      mode:        { default: 'render', parseHTML: function (el) { return el.getAttribute('data-mode')   || 'render' } },
    },

    parseAttrs: function (data) {
      return {
        source:      typeof data.source === 'string' ? data.source : '',
        diagramType: data.diagramType || 'mermaid',
        mode:        data.mode        || 'render',
      }
    },

    makeNodeView: function (node, editor) {
      var nodeTypeName   = node.type.name
      var currentAttrs   = Object.assign({}, node.attrs)

      // ── DOM shell ─────────────────────────────────────────────────────────────

      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--diagram'
      dom.setAttribute('data-id', node.attrs.id || '')
      dom.contentEditable = 'false'

      dom.addEventListener('dragstart', function (e) { e.preventDefault() })

      // ── Header ────────────────────────────────────────────────────────────────

      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      header.contentEditable = 'false'

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
      gutter.contentEditable = 'false'

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

      // ── State helpers ─────────────────────────────────────────────────────────

      function flushSource() {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: { source: editEl.value } },
        }))
      }

      function switchMode(newMode) {
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'diagram', attrs: { mode: newMode } },
        }))
      }

      function updateToggle(mode) {
        editBtn.className = 'diagram-block__toggle-btn' +
          (mode === 'edit' ? ' diagram-block__toggle-btn--active-edit' : '')
        renderBtn.className = 'diagram-block__toggle-btn' +
          (mode === 'render' ? ' diagram-block__toggle-btn--active-render' : '')
      }

      // ── Render function ───────────────────────────────────────────────────────

      function showEdit(attrs) {
        if (dom.contains(renderBody)) dom.removeChild(renderBody)
        if (!dom.contains(editBody)) dom.appendChild(editBody)
        if (document.activeElement !== editEl) {
          editEl.value = attrs.source || ''
          applyHighlight(highlightCode, attrs.source || '')
          updateGutter(gutter, attrs.source || '')
        }
      }

      function showRender(attrs) {
        if (dom.contains(editBody)) dom.removeChild(editBody)
        if (!dom.contains(renderBody)) dom.appendChild(renderBody)

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
          renderBody.innerHTML = ''
          renderBody.innerHTML = result.svg
        }).catch(function (err) {
          var msg = (err && err.message) ? err.message : String(err)
          renderBody.innerHTML =
            '<div class="diagram-block__error">' +
            '<div class="diagram-block__error-icon">⚠</div>' +
            '<div>' +
            '<div class="diagram-block__error-title">Diagram syntax error</div>' +
            '<div class="diagram-block__error-msg">' + msg.replace(/</g, '&lt;') + '</div>' +
            '</div></div>'
          // flip back to edit mode
          switchMode('edit')
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

      // ── Events ────────────────────────────────────────────────────────────────

      editBtn.addEventListener('mousedown', function (e) {
        e.preventDefault()
        e.stopPropagation()
        if (currentAttrs.mode !== 'edit') switchMode('edit')
        else editEl.focus()
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
          clearTimeout(inputTimer)
          clearTimeout(highlightTimer)
        },
      }
    },
  }

  // ── Context menu ──────────────────────────────────────────────────────────────

  DiagramRenderer.buildContextMenuItems = function (ctx) {
    var n = ctx.node, editor = ctx.editor, getPos = ctx.getPos
    var IC = window.SieveIcons || {}

    function del() {
      if (typeof getPos === 'function') {
        var pos = getPos()
        editor.view.dispatch(editor.state.tr.delete(pos, pos + n.nodeSize))
      }
    }

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
      { icon: IC.edit,    label: modeLabel, action: toggleMode },
      { type: 'divider' },
      { icon: IC.copy,    label: 'Copy source', action: copySource },
      { icon: IC.sparkle, label: 'Ask AI…', action: function () {
        if (typeof getPos === 'function') editor.chain().focus().setNodeSelection(getPos()).run()
        else editor.commands.focus()
        var ctx = {
          content:      n.attrs.source || '',
          blockRef:     n.attrs.id || 'doc',
          history:      '',
          contextLabel: 'Diagram',
          imageIds:     [],
        }
        document.dispatchEvent(new CustomEvent('sieve:ai-ask', { detail: { precomputedCtx: ctx } }))
      }},
      { type: 'divider' },
      { icon: IC.trash, label: 'Delete', action: del },
    ]
  }

  T.registerSieveRenderer('diagram', DiagramRenderer)

})()
