// sieve-block-extension.js
// One generic TipTap node + a renderer registry keyed by Kind.
// Mirrors Go: BlockProcessor registry ↔ BlockRenderer registry.
//
// BlockRenderer interface:
//   makeNodeView(node)        → TipTap NodeView object
//   parseAttrs(data)          → { key: value } extra data-* attrs for fence parser (optional)

import { esc, isStaleByTime, isJobActive } from './fenced-block-base.js'

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
  // Single-panel, always-editable: gutter (line numbers) + contenteditable <code>.
  // Mirrors the CodeBlockWithAttrs visual layout.
  // Syntax highlighting is applied on blur and on node update when not focused;
  // on focus the spans are stripped back to plain text for clean cursor behaviour.

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

      // ── DOM ──────────────────────────────────────────────────────────────
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

      // flex row: gutter + pre/code
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

      // ── Helpers ──────────────────────────────────────────────────────────
      var _low = null
      function getLow() {
        if (!_low) {
          var T = window.TipTap
          if (T && T.createLowlight && T.common) _low = T.createLowlight(T.common)
        }
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

      function updateGutter(source) {
        var lines = (source || '').split('\n')
        var count = (lines[lines.length - 1] === '') ? lines.length - 1 : lines.length
        count = Math.max(count, 1)
        // Only rebuild DOM when line count changes
        if (gutter.childElementCount !== count) {
          gutter.innerHTML = ''
          for (var i = 1; i <= count; i++) {
            var span = document.createElement('span')
            span.textContent = String(i)
            gutter.appendChild(span)
          }
        }
      }

      function applyHighlight(source, lang) {
        codeEl.textContent = source || ''
        var langClass = (lang && lang !== 'unknown') ? 'language-' + lang : 'language-text'
        codeEl.className = 'sieve-block__source hljs ' + langClass
        var low = getLow()
        if (low && lang && lang !== 'unknown' && lang !== 'text' && source) {
          try { codeEl.innerHTML = hastToHtml(low.highlight(lang, source).children) } catch (_) {}
        }
      }

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

      function render(attrs) {
        currentAttrs = attrs
        updateBadge(attrs)
        if (document.activeElement !== codeEl) {
          applyHighlight(attrs.source || '', attrs.language || '')
          updateGutter(attrs.source || '')
        }
      }

      render(node.attrs)

      // ── Events ───────────────────────────────────────────────────────────
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

      // Strip highlight spans on focus — gives clean plain-text cursor behaviour.
      codeEl.addEventListener('focus', function () {
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
          // Insert two spaces at cursor (works in contenteditable)
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

      return {
        dom: dom,
        contentDOM: null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieveBlock') return false
          render(updatedNode.attrs)
          return true
        },
        // When TipTap selects this atom (arrow-key navigation), focus codeEl so
        // subsequent keystrokes go to the code editor rather than deleting the node.
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

  registerSieveRenderer('code', CodeRenderer)

  // ── Exports ───────────────────────────────────────────────────────────────────
  T.SieveBlock = SieveBlock
  T.registerSieveRenderer = registerSieveRenderer

})()
