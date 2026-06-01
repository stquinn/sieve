// web-clip-extension.js — fenced YAML web-clip block (machine artefact, Category 3).
// Depends on window.TipTap and window.jsyaml.

import { esc, renderMarkdown, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var mergeAttributes = T.mergeAttributes

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function extractDomain(url) {
    try { return new URL(url).hostname } catch (_) { return url }
  }

  function isStale(createdAt, id) {
    if (isJobActive(id)) return false
    return isStaleByTime(createdAt)
  }

  // Quote a scalar value if it contains YAML-special characters. Mirrors Go's yamlScalar().
  function yamlScalar(s) {
    if (!s) return s
    var needsQuote = /[:#{}[\]|>&*!,]/.test(s) || s[0] === ' ' || s[s.length - 1] === ' '
    if (!needsQuote) return s
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  function serializeWebClipYaml(attrs) {
    var lines = []
    lines.push('id: ' + (attrs.id || ''))
    lines.push('source: ' + yamlScalar(attrs.source || ''))
    if (attrs.title) {
      lines.push('title: |-')
      ;(attrs.title || '').split('\n').forEach(function (l) { lines.push('    ' + l) })
    }
    lines.push('mode: ' + (attrs.mode || 'fetch'))
    lines.push('status: ' + (attrs.status || 'PENDING'))
    if (attrs.model) lines.push('model: ' + yamlScalar(attrs.model))
    if (attrs.createdAt) lines.push('createdAt: ' + yamlScalar(attrs.createdAt))
    if (attrs.completedAt) lines.push('completedAt: ' + yamlScalar(attrs.completedAt))
    if (attrs.content) {
      lines.push('content: |')
      attrs.content.split('\n').forEach(function (l) { lines.push('    ' + (l || '')) })
    }
    if (attrs.error) {
      lines.push('error: |')
      attrs.error.split('\n').forEach(function (l) { lines.push('    ' + (l || '')) })
    }
    return lines.join('\n')
  }

  // Expose so context-menu.js can call it
  T.serializeWebClipYaml = serializeWebClipYaml

  // ── NodeView ─────────────────────────────────────────────────────────────────

  function makeNodeView(node, editor, getPos) {
    var currentNode = node

    var dom = document.createElement('div')
    dom.className = 'web-clip-block'
    dom.contentEditable = 'false'
    dom.setAttribute('draggable', 'false')
    dom.setAttribute('data-wc-id', node.attrs.id || '')
    dom.style.userSelect = 'text'

    function applyReverseChain(action) {
      var id = dom.getAttribute('data-wc-id') || ''
      if (!id) return
      document.querySelectorAll('.ai-block').forEach(function (el) {
        var refs = (el.getAttribute('data-ai-ref') || '').split(',').map(function (r) { return r.trim() })
        if (refs.indexOf(id) !== -1) el.classList[action]('ai-block--chain-active')
      })
    }

    dom.addEventListener('dragstart', function (e) { e.preventDefault() })
    dom.addEventListener('mousedown', function (e) { e.stopPropagation() })
    dom.addEventListener('mouseenter', function () { applyReverseChain('add') })
    dom.addEventListener('mouseleave', function () { applyReverseChain('remove') })

    dom.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      if (typeof getPos === 'function') editor.commands.setNodeSelection(getPos())
      document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
        detail: { x: e.clientX, y: e.clientY, context: { type: 'webClip', editor: editor, getPos: getPos, node: currentNode } }
      }))
    })

    function makeRetryBtn(blkId, source, mode) {
      var btn = document.createElement('button')
      btn.className = 'web-clip-block__retry'
      btn.textContent = 'Retry'
      btn.addEventListener('click', function () {
        document.dispatchEvent(new CustomEvent('sieve:webclip-retry', {
          detail: { id: blkId, source: source, mode: mode }
        }))
      })
      return btn
    }

    function render(n) {
      dom.innerHTML = ''
      dom.setAttribute('data-wc-id', n.attrs.id || '')
      var attrs = n.attrs
      var status = attrs.status || 'PENDING'
      var domain = extractDomain(attrs.source || '')
      var modeLabel = attrs.mode === 'summarise' ? 'Summarising' : 'Fetching'
      var completeModeLabel = attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'

      var header = document.createElement('div')
      header.className = 'web-clip-block__header'

      if (status === 'PENDING') {
        var stale = isStale(attrs.createdAt, attrs.id)
        if (stale) {
          header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--warn">⚠</span>' +
            '<span class="web-clip-block__label">' + modeLabel.replace('ing', '') + ' interrupted — ' + domain + '</span>'
          dom.appendChild(header)
          dom.appendChild(makeRetryBtn(attrs.id, attrs.source, attrs.mode))
        } else {
          header.innerHTML = '<span class="web-clip-block__spinner"></span>' +
            '<span class="web-clip-block__label">' + modeLabel + ' from ' + domain + '…</span>'
          dom.appendChild(header)
        }

      } else if (status === 'COMPLETE') {
        var badge = document.createElement('span')
        badge.className = 'web-clip-block__badge'
        badge.textContent = completeModeLabel + ' — '
        header.appendChild(badge)
        var srcLink = document.createElement('a')
        srcLink.className = 'web-clip-block__source-link'
        srcLink.href = attrs.source || ''
        srcLink.textContent = attrs.source || domain
        srcLink.target = '_blank'
        srcLink.rel = 'noopener noreferrer'
        header.appendChild(srcLink)
        if (attrs.title) {
          var titleEl = document.createElement('span')
          titleEl.className = 'web-clip-block__title'
          titleEl.textContent = attrs.title
          header.appendChild(titleEl)
        }
        dom.appendChild(header)
        if (attrs.content) {
          var contentEl = document.createElement('div')
          contentEl.className = 'web-clip-block__content'
          contentEl.innerHTML = renderMarkdown(attrs.content, editor)
          applyHighlighting(contentEl)
          dom.appendChild(contentEl)
        }

      } else if (status === 'TIMEOUT') {
        header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--warn">⚠</span>' +
          '<span class="web-clip-block__label">Timed out — ' + domain + '</span>'
        dom.appendChild(header)
        dom.appendChild(makeRetryBtn(attrs.id, attrs.source, attrs.mode))

      } else if (status === 'ERROR') {
        var errMsg = (attrs.error || 'Unknown error').trim()
        header.innerHTML = '<span class="web-clip-block__icon web-clip-block__icon--error">✕</span>' +
          '<span class="web-clip-block__label">' + errMsg + '</span>'
        dom.appendChild(header)
        dom.appendChild(makeRetryBtn(attrs.id, attrs.source, attrs.mode))
      }
    }

    render(node)

    return {
      dom: dom,
      contentDOM: null,
      update: function (updatedNode) {
        if (updatedNode.type.name !== 'webClip') return false
        currentNode = updatedNode
        render(updatedNode)
        return true
      },
      ignoreMutation: function () { return true },
      stopEvent: function (event) {
        if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
        return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
      },
    }
  }

  // ── WebClip Node ──────────────────────────────────────────────────────────────

  var WebClip = Node.create({
    name: 'webClip',
    group: 'block',
    selectable: true,
    draggable: false,

    addAttributes() {
      return {
        id:          { default: '' },
        source:      { default: '' },
        title:       { default: null },
        mode:        { default: 'fetch' },
        status:      { default: 'PENDING' },
        model:       { default: null },
        createdAt:   { default: null },
        completedAt: { default: null },
        content:     { default: null },
        error:       { default: null },
      }
    },

    parseHTML() {
      return [{ tag: 'div[data-type="webClip"]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'webClip' }, HTMLAttributes)]
    },

    addNodeView() {
      var self = this
      return function ({ node, getPos }) {
        return makeNodeView(node, self.editor, getPos)
      }
    },

    addStorage() {
      return {
        markdown: {
          // Replay the Go-generated YAML verbatim — JS never generates YAML.
          serialize: function (state, node) {
            state.ensureNewLine()
            var raw = node.attrs.rawYaml
            state.write('```web-clip\n' + raw + '\n```')
            state.closeBlock(node)
          },
          parse: {
            setup: function (markdownit) {
              var defaultFence = markdownit.renderer.rules.fence
              markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                var token = tokens[idx]
                if (token.info.trim() !== 'web-clip') {
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
                // Store raw YAML so the serializer can replay it without regenerating.
                var attrs = [
                  'data-type="webClip"',
                  'data-raw-yaml="' + esc(token.content) + '"',
                  'data-id="' + esc(data.id) + '"',
                  'data-source="' + esc(data.source || '') + '"',
                  'data-mode="' + esc(data.mode || 'fetch') + '"',
                  'data-status="' + esc(data.status || 'PENDING') + '"',
                ]
                if (data.title)       attrs.push('data-title="' + esc(data.title) + '"')
                if (data.model)       attrs.push('data-model="' + esc(data.model) + '"')
                if (data.createdAt)   attrs.push('data-created-at="' + esc(data.createdAt) + '"')
                if (data.completedAt) attrs.push('data-completed-at="' + esc(data.completedAt) + '"')
                if (data.content)     attrs.push('data-content="' + esc((data.content || '').trim()) + '"')
                if (data.error)       attrs.push('data-error="' + esc((data.error || '').trim()) + '"')
                return '<div ' + attrs.join(' ') + '></div>\n'
              }
            },
          },
        },
      }
    },
  })

  // The parseHTML() expects data-* attributes because the fence hook produces raw HTML.
  // Override addAttributes to also parse from data-* HTML attributes:
  // (We do this by augmenting parseHTML handlers after Node.create)
  WebClip = WebClip.extend({
    addAttributes() {
      return {
        rawYaml:     { default: '', parseHTML: function(el) { return el.getAttribute('data-raw-yaml') || '' } },
        id:          { default: '', parseHTML: function(el) { return el.getAttribute('data-id') || '' } },
        source:      { default: '', parseHTML: function(el) { return el.getAttribute('data-source') || '' } },
        title:       { default: null, parseHTML: function(el) { return el.getAttribute('data-title') || null } },
        mode:        { default: 'fetch', parseHTML: function(el) { return el.getAttribute('data-mode') || 'fetch' } },
        status:      { default: 'PENDING', parseHTML: function(el) { return el.getAttribute('data-status') || 'PENDING' } },
        model:       { default: null, parseHTML: function(el) { return el.getAttribute('data-model') || null } },
        createdAt:   { default: null, parseHTML: function(el) { return el.getAttribute('data-created-at') || null } },
        completedAt: { default: null, parseHTML: function(el) { return el.getAttribute('data-completed-at') || null } },
        content:     { default: null, parseHTML: function(el) { return el.getAttribute('data-content') || null } },
        error:       { default: null, parseHTML: function(el) { return el.getAttribute('data-error') || null } },
      }
    },
  })

  T.WebClip = WebClip
})()
