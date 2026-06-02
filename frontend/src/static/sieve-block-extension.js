// sieve-block-extension.js
// One generic TipTap node + a renderer registry keyed by Kind.
// Mirrors Go: BlockProcessor registry ↔ BlockRenderer registry.
//
// BlockRenderer interface:
//   makeNodeView(node)        → TipTap NodeView object
//   parseAttrs(data)          → { key: value } extra data-* attrs for fence parser (optional)

import { esc, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── Renderer Registry ────────────────────────────────────────────────────────

  var rendererRegistry = {}

  function registerSieveRenderer(kind, renderer) {
    rendererRegistry[kind] = renderer
  }

  // ── Generic sieveBlock TipTap Node ──────────────────────────────────────────

  var SieveBlock = Node.create({
    name: 'sieveBlock',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,

    addAttributes() {
      return {
        kind:            { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')             || '' } },
        id:              { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')               || '' } },
        rawYaml:         { default: '',        parseHTML: function (el) { return el.getAttribute('data-raw-yaml')         || '' } },
        status:          { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')           || 'PENDING' } },
        language:        { default: '',        parseHTML: function (el) { return el.getAttribute('data-language')         || '' } },
        source:          { default: '',        parseHTML: function (el) { return el.getAttribute('data-source')           || '' } },
        createdAt:       { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at')       || null } },
        detectionMethod: { default: '',        parseHTML: function (el) { return el.getAttribute('data-detection-method') || '' } },
      }
    },

    parseHTML() {
      return [{ tag: 'div[data-type="sieveBlock"]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'sieveBlock' }, HTMLAttributes)]
    },

    addNodeView() {
      return function ({ node }) {
        var renderer = rendererRegistry[node.attrs.kind]
        if (!renderer) {
          var dom = document.createElement('div')
          dom.className = 'sieve-block sieve-block--unknown'
          dom.textContent = '[unknown block kind: ' + (node.attrs.kind || '?') + ']'
          return { dom: dom }
        }
        return renderer.makeNodeView(node)
      }
    },

    addStorage() {
      return {
        markdown: {
          // Serialize: write ```<kind>\n<rawYaml>\n```.
          // Go owns all YAML — JS replays rawYaml verbatim. kind drives the fence info string.
          serialize: function (state, node) {
            state.ensureNewLine()
            if (node.attrs.kind && node.attrs.rawYaml) {
              state.write('```' + node.attrs.kind + '\n' + node.attrs.rawYaml + '\n```')
            } else {
              state.write('```\n\n```')
            }
            state.closeBlock(node)
          },
          parse: {
            // Intercept any fence whose kind has a registered renderer AND whose
            // YAML body contains an id. All other fences fall through unchanged.
            setup: function (markdownit) {
              var defaultFence = markdownit.renderer.rules.fence
              markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                var token = tokens[idx]
                var kind = (token.info || '').trim()

                if (!kind || !rendererRegistry[kind]) {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }

                var data
                try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                if (!data || !data.id) {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }

                var attrs = [
                  'data-type="sieveBlock"',
                  'data-kind="' + esc(kind) + '"',
                  'data-id="' + esc(data.id) + '"',
                  'data-raw-yaml="' + esc(token.content) + '"',
                  'data-status="' + esc(data.status || 'PENDING') + '"',
                ]
                var renderer = rendererRegistry[kind]
                if (renderer && renderer.parseAttrs) {
                  var extra = renderer.parseAttrs(data)
                  Object.keys(extra).forEach(function (k) {
                    var kebab = k.replace(/([a-z0-9]|(?=[A-Z]))([A-Z])/g, '$1-$2').toLowerCase()
                    attrs.push('data-' + kebab + '="' + esc(String(extra[k])) + '"')
                  })
                }
                if (data.createdAt) attrs.push('data-created-at="' + esc(data.createdAt) + '"')
                return '<div ' + attrs.join(' ') + '></div>\n'
              }
            },
          },
        },
      }
    },
  })

  // ── CodeRenderer ─────────────────────────────────────────────────────────────
  // Two-panel design: a read-only display panel (applyHighlighting — gives gutter
  // + syntax colours identical to AI blocks and WebClips) and a <textarea> edit
  // panel shown on click/selectNode. This avoids the "atom node selected → TipTap
  // deletes on keypress" problem and gives proper line numbers + highlighting.

  var CodeRenderer = {
    parseAttrs: function (data) {
      return {
        language: data.language || '',
        source: (typeof data.source === 'string' ? data.source : ''),
        detectionMethod: data.detectionMethod || '',
      }
    },

    makeNodeView: function (node) {
      var currentAttrs = Object.assign({}, node.attrs)
      var isEditing = false

      // ── Outer container ──────────────────────────────────────────────────
      var dom = document.createElement('div')
      dom.className = 'sieve-block sieve-block--code'
      dom.setAttribute('data-block-id', node.attrs.id || '')
      dom.contentEditable = 'false'

      // ── Header ───────────────────────────────────────────────────────────
      var header = document.createElement('div')
      header.className = 'sieve-block__header'
      header.contentEditable = 'false'
      var badge = document.createElement('span')
      badge.className = 'sieve-block__badge'
      header.appendChild(badge)
      dom.appendChild(header)

      // ── Display panel (highlighted, click to edit) ───────────────────────
      var displayEl = document.createElement('div')
      displayEl.className = 'sieve-block__display'
      dom.appendChild(displayEl)

      // ── Edit panel (textarea, shown while editing) ───────────────────────
      var editEl = document.createElement('textarea')
      editEl.className = 'sieve-block__edit'
      editEl.spellcheck = false
      editEl.setAttribute('autocorrect', 'off')
      editEl.setAttribute('autocapitalize', 'off')
      editEl.style.display = 'none'
      dom.appendChild(editEl)

      // ── Render helpers ───────────────────────────────────────────────────
      function updateBadge(attrs) {
        var isPending = attrs.status === 'PENDING'
        var isStale = isPending && !isJobActive(attrs.id) && isStaleByTime(attrs.createdAt)
        var showDetecting = isPending && !isStale && (!attrs.language || attrs.language === '')
        if (showDetecting) {
          badge.textContent = 'detecting…'
          badge.className = 'sieve-block__badge sieve-block__badge--pending'
        } else if (attrs.language && attrs.language !== 'unknown') {
          badge.textContent = attrs.language
          badge.className = 'sieve-block__badge'
        } else {
          badge.textContent = attrs.language || ''
          badge.className = 'sieve-block__badge sieve-block__badge--unknown'
        }
        if (attrs.detectionMethod) {
          badge.setAttribute('data-detection-method', attrs.detectionMethod)
          badge.title = 'Detected via ' + attrs.detectionMethod
        } else {
          badge.removeAttribute('data-detection-method')
          badge.removeAttribute('title')
        }
      }

      function renderDisplay(attrs) {
        var pre = document.createElement('pre')
        var code = document.createElement('code')
        code.textContent = attrs.source || ''
        code.className = (attrs.language && attrs.language !== 'unknown')
          ? 'language-' + attrs.language : 'language-text'
        pre.appendChild(code)
        displayEl.innerHTML = ''
        displayEl.appendChild(pre)
        applyHighlighting(displayEl)
      }

      function render(attrs) {
        currentAttrs = attrs
        updateBadge(attrs)
        if (!isEditing) renderDisplay(attrs)
      }

      render(node.attrs)

      // ── Enter / exit edit mode ───────────────────────────────────────────
      function autoResize() {
        editEl.style.height = 'auto'
        editEl.style.height = Math.max(editEl.scrollHeight, 40) + 'px'
      }

      function enterEdit() {
        if (isEditing) return
        isEditing = true
        editEl.value = currentAttrs.source || ''
        autoResize()
        displayEl.style.display = 'none'
        editEl.style.display = ''
        editEl.focus()
      }

      displayEl.addEventListener('click', function (e) {
        e.stopPropagation()
        enterEdit()
      })

      // ── Edit panel events ────────────────────────────────────────────────
      var inputTimer = null

      function flushSource() {
        clearTimeout(inputTimer)
        document.dispatchEvent(new CustomEvent('sieve:block-update', {
          detail: { id: currentAttrs.id, kind: 'code', attrs: { source: editEl.value } },
        }))
      }

      editEl.addEventListener('input', function () {
        autoResize()
        clearTimeout(inputTimer)
        inputTimer = setTimeout(flushSource, 200)
      })

      editEl.addEventListener('blur', function () {
        flushSource()
        isEditing = false
        currentAttrs = Object.assign({}, currentAttrs, { source: editEl.value })
        renderDisplay(currentAttrs)
        displayEl.style.display = ''
        editEl.style.display = 'none'
      })

      editEl.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault()
          var s = editEl.selectionStart, end = editEl.selectionEnd
          editEl.value = editEl.value.substring(0, s) + '  ' + editEl.value.substring(end)
          editEl.selectionStart = editEl.selectionEnd = s + 2
          clearTimeout(inputTimer)
          inputTimer = setTimeout(flushSource, 200)
          return
        }
        if (e.key === 'Escape') { editEl.blur(); return }
        if (e.metaKey || e.ctrlKey) return
        e.stopPropagation()
      })

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieveBlock') return false
          render(updatedNode.attrs)
          return true
        },
        // When TipTap selects this atom (click or arrow key), enter edit mode
        // immediately so keystrokes go to the textarea, not TipTap's editor.
        selectNode: function () { enterEdit() },
        ignoreMutation: function () { return true },
        stopEvent: function (event) {
          if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
          return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
        },
        destroy: function () { clearTimeout(inputTimer) },
      }
    },
  }

  registerSieveRenderer('code', CodeRenderer)

  // ── Exports ───────────────────────────────────────────────────────────────────
  T.SieveBlock = SieveBlock
  T.registerSieveRenderer = registerSieveRenderer

})()
