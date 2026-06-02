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
        kind:      { default: '',        parseHTML: function (el) { return el.getAttribute('data-kind')       || '' } },
        id:        { default: '',        parseHTML: function (el) { return el.getAttribute('data-id')         || '' } },
        rawYaml:   { default: '',        parseHTML: function (el) { return el.getAttribute('data-raw-yaml')   || '' } },
        status:    { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')     || 'PENDING' } },
        language:  { default: '',        parseHTML: function (el) { return el.getAttribute('data-language')   || '' } },
        source:    { default: '',        parseHTML: function (el) { return el.getAttribute('data-source')     || '' } },
        createdAt: { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at') || null } },
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
                    attrs.push('data-' + k + '="' + esc(String(extra[k])) + '"')
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

  var CodeRenderer = {
    parseAttrs: function (data) {
      return {
        language: data.language || '',
        source: (typeof data.source === 'string' ? data.source.trim() : ''),
      }
    },

    makeNodeView: function (node) {
      var currentAttrs = Object.assign({}, node.attrs)

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

      var pre = document.createElement('pre')
      pre.className = 'sieve-block__pre not-prose'

      var codeEl = document.createElement('code')
      codeEl.className = 'sieve-block__source'
      codeEl.contentEditable = 'true'
      codeEl.spellcheck = false
      codeEl.setAttribute('autocorrect', 'off')
      codeEl.setAttribute('autocapitalize', 'off')
      pre.appendChild(codeEl)
      dom.appendChild(header)
      dom.appendChild(pre)

      function render(attrs) {
        currentAttrs = attrs
        var isPending = attrs.status === 'PENDING'
        var isStale = isPending && !isJobActive(attrs.id) && isStaleByTime(attrs.createdAt)
        // Show "detecting…" only when pending AND heuristics gave no language yet.
        // If heuristics already set a language in InitAttrs, show it immediately —
        // the AI is enriching silently in the background.
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

        if (document.activeElement !== codeEl) {
          codeEl.textContent = attrs.source || ''
          var langClass = (attrs.language && attrs.language !== 'unknown')
            ? 'language-' + attrs.language : 'language-text'
          codeEl.className = 'sieve-block__source ' + langClass
          applyHighlighting(pre)
        }
      }

      render(node.attrs)

      var inputTimer = null
      codeEl.addEventListener('input', function () {
        clearTimeout(inputTimer)
        inputTimer = setTimeout(function () {
          document.dispatchEvent(new CustomEvent('sieve:block-update', {
            detail: { id: currentAttrs.id, kind: 'code', attrs: { source: codeEl.textContent } },
          }))
        }, 200)
      })

      codeEl.addEventListener('keydown', function (e) {
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
