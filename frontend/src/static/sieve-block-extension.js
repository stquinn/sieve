// sieve-block-extension.js
//
// Renderer interface (each BlockRenderer must supply):
//   nodeConfig   { atom, selectable, draggable }   TipTap node schema overrides
//   attrs        { [key]: TipTap attr definition }  kind-specific attrs (merged with base)
//   parseAttrs   (data) → { key: value }            HTML data-* attrs from YAML for fence parser
//   makeNodeView (node) → TipTap NodeView           how the block renders
//
// registerSieveRenderer(kind, renderer) creates one TipTap node per kind.
// getSieveNodes() returns them all; editor.js spreads them into the extensions array.

import { esc, isStaleByTime, isJobActive } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── Base attributes present on every sieve block kind ────────────────────────

  var BASE_ATTRS = {
    kind:      { default: '', parseHTML: function (el) { return el.getAttribute('data-kind')       || '' } },
    id:        { default: '', parseHTML: function (el) { return el.getAttribute('data-id')         || '' } },
    rawYaml:   { default: '', parseHTML: function (el) { return el.getAttribute('data-raw-yaml')   || '' } },
    status:    { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status')    || 'PENDING' } },
    createdAt: { default: null,      parseHTML: function (el) { return el.getAttribute('data-created-at') || null } },
  }

  // Default node schema overrides (suitable for display-only blocks such as AI/WebClip).
  var DEFAULT_NODE_CONFIG = { atom: true, selectable: true, draggable: true }

  // ── Node factory ─────────────────────────────────────────────────────────────

  function createSieveNode(kind, renderer) {
    var cfg      = Object.assign({}, DEFAULT_NODE_CONFIG, renderer.nodeConfig || {})
    var nodeName = 'sieve-' + kind    // e.g. 'sieve-code', 'sieve-ai-block'
    var dataType = 'sieve-' + kind    // data-type="sieve-code" in HTML

    return Node.create({
      name:       nodeName,
      group:      'block',
      atom:       cfg.atom,
      selectable: cfg.selectable,
      draggable:  cfg.draggable,

      addAttributes() {
        // Base attrs + renderer-supplied kind-specific attrs
        return Object.assign({}, BASE_ATTRS, renderer.attrs || {})
      },

      parseHTML() {
        return [{ tag: 'div[data-type="' + dataType + '"]' }]
      },

      renderHTML({ HTMLAttributes }) {
        return ['div', mergeAttributes({ 'data-type': dataType }, HTMLAttributes)]
      },

      addNodeView() {
        return function ({ node }) { return renderer.makeNodeView(node) }
      },

      addStorage() {
        return {
          markdown: {
            // Serialise: replay rawYaml verbatim inside a ```kind fence.
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
              // Wrap the fence rule; only intercept fences whose info string matches
              // this kind and whose YAML body contains an id. All other fences fall
              // through to the next handler in the chain.
              setup: function (markdownit) {
                var prevFence = markdownit.renderer.rules.fence
                markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                  var token     = tokens[idx]
                  var tokenKind = (token.info || '').trim()

                  if (tokenKind !== kind) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self)
                      : self.renderToken(tokens, idx, options)
                  }

                  var data
                  try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                  if (!data || !data.id) {
                    return prevFence
                      ? prevFence(tokens, idx, options, env, self)
                      : self.renderToken(tokens, idx, options)
                  }

                  var htmlAttrs = [
                    'data-type="' + dataType + '"',
                    'data-kind="'     + esc(kind) + '"',
                    'data-id="'       + esc(data.id) + '"',
                    'data-raw-yaml="' + esc(token.content) + '"',
                    'data-status="'   + esc(data.status || 'PENDING') + '"',
                  ]
                  if (renderer.parseAttrs) {
                    var extra = renderer.parseAttrs(data)
                    Object.keys(extra).forEach(function (k) {
                      var kebab = k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
                      htmlAttrs.push('data-' + kebab + '="' + esc(String(extra[k] != null ? extra[k] : '')) + '"')
                    })
                  }
                  if (data.createdAt) {
                    htmlAttrs.push('data-created-at="' + esc(data.createdAt) + '"')
                  }
                  return '<div ' + htmlAttrs.join(' ') + '></div>\n'
                }
              },
            },
          },
        }
      },
    })
  }

  // ── Registry ─────────────────────────────────────────────────────────────────

  var nodeRegistry = {}  // kind → TipTap Node

  function registerSieveRenderer(kind, renderer) {
    nodeRegistry[kind] = createSieveNode(kind, renderer)
  }

  function getSieveNodes() {
    return Object.keys(nodeRegistry).map(function (k) { return nodeRegistry[k] })
  }

  // ── CodeRenderer ─────────────────────────────────────────────────────────────

  var CodeRenderer = {
    // Code blocks should not be draggable as a unit (drag = text selection)
    // and should not capture clicks as a NodeSelection (blocks inner focus).
    nodeConfig: {
      atom:       true,
      selectable: false,
      draggable:  false,
    },

    // Kind-specific TipTap attribute definitions (merged with BASE_ATTRS by the factory).
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

      // flex row: line-number gutter + pre/code
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

      // ── Lowlight ─────────────────────────────────────────────────────────
      var _low = null
      function getLow() {
        if (!_low) {
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

      // ── Gutter ───────────────────────────────────────────────────────────
      function updateGutter(source) {
        var lines = (source || '').split('\n')
        var count = (lines[lines.length - 1] === '') ? lines.length - 1 : lines.length
        count = Math.max(count, 1)
        if (gutter.childElementCount === count) return
        gutter.innerHTML = ''
        for (var i = 1; i <= count; i++) {
          var span = document.createElement('span')
          span.textContent = String(i)
          gutter.appendChild(span)
        }
      }

      // ── Highlighting ─────────────────────────────────────────────────────
      function applyHighlight(source, lang) {
        codeEl.textContent = source || ''
        var langClass = (lang && lang !== 'unknown') ? 'language-' + lang : 'language-text'
        codeEl.className = 'sieve-block__source hljs ' + langClass
        var low = getLow()
        if (low && lang && lang !== 'unknown' && lang !== 'text' && source) {
          try { codeEl.innerHTML = hastToHtml(low.highlight(lang, source).children) } catch (_) {}
        }
      }

      // ── Badge ────────────────────────────────────────────────────────────
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

      // ── Render ───────────────────────────────────────────────────────────
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

      // Strip highlight spans on focus — clean plain-text cursor behaviour.
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
        dom:         dom,
        contentDOM:  null,
        update: function (updatedNode) {
          if (updatedNode.type.name !== 'sieve-code') return false
          render(updatedNode.attrs)
          return true
        },
        // When TipTap selects the atom via keyboard navigation, immediately focus
        // the code element so keystrokes go there rather than deleting the block.
        selectNode:    function () { codeEl.focus() },
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
  T.getSieveNodes        = getSieveNodes
  T.registerSieveRenderer = registerSieveRenderer

})()
