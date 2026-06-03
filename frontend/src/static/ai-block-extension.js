// ai-block-extension.js — fenced YAML ai-block format (canonical).
// Depends on window.TipTap (vendor/tiptap.js) and window.jsyaml (vendor/js-yaml.js).
// Attaches AiBlock, AiShortcuts to window.TipTap.

import { esc, renderMarkdown, applyHighlighting, isStaleByTime, isJobActive } from './fenced-block-base.js'

; (function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var Extension = T.Extension
  var mergeAttributes = T.mergeAttributes

  // ── gatherChain ─────────────────────────────────────────────────────────────

  function gatherChain(startId, startRefs) {
    var ids = new Set()
    function visit(id) {
      if (!id || id === 'doc' || ids.has(id)) return
      ids.add(id)
      var el = document.querySelector('.ai-block[data-ai-id="' + id + '"]')
      if (el) {
        var refs = el.getAttribute('data-ai-ref') || ''
        refs.split(',').forEach(function (r) { visit(r.trim()) })
      }
    }
    visit(startId)
    startRefs.forEach(visit)
    return ids
  }

  // ── isStale ──────────────────────────────────────────────────────────────────

  function isStale(createdAt, id) {
    if (isJobActive(id)) return false
    return isStaleByTime(createdAt)
  }

  // serializeAiBlockYaml is kept for context-menu.js display use; no longer used for persistence.
  T.serializeAiBlockYaml = serializeAiBlockYaml

  // ── yamlScalar ──────────────────────────────────────────────────────────────

  // Quote a flow scalar if it contains YAML-special characters. Mirrors Go's yamlScalar().
  function yamlScalar(s) {
    if (!s) return s
    var needsQuote = /[:#{}[\]|>&*!,]/.test(s) || s[0] === ' ' || s[s.length - 1] === ' '
    if (!needsQuote) return s
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }

  // ── serializeAiBlockYaml ────────────────────────────────────────────────────

  function serializeAiBlockYaml(attrs) {
    var lines = []
    lines.push('id: ' + attrs.id)
    lines.push('ref: ' + (attrs.ref || 'doc'))
    lines.push('status: ' + (attrs.status || 'PENDING'))
    if (attrs.type) lines.push('type: ' + attrs.type)
    if (attrs.model) lines.push('model: ' + yamlScalar(attrs.model))
    if (attrs.createdAt) lines.push('createdAt: ' + yamlScalar(attrs.createdAt))
    if (attrs.completedAt) lines.push('completedAt: ' + yamlScalar(attrs.completedAt))

    var q = attrs.question || ''
    if (q.includes('\n')) {
      // Block scalar — 4-space indent so inner ``` lines can't close the outer fence
      lines.push('question: |')
      q.split('\n').forEach(function (l) { lines.push('    ' + l) })
    } else if (q) {
      // Flow scalar — quote if it contains YAML-special characters
      lines.push('question: ' + yamlScalar(q))
    }

    var r = attrs.response || ''
    if (r) {
      lines.push('response: |')
      r.split('\n').forEach(function (l) { lines.push('    ' + (l || '')) })
    }

    return lines.join('\n')
  }

  // ── NodeView factory ─────────────────────────────────────────────────────────

  function makeNodeView(node, editor, getPos) {
    var currentNode = node
    var dom = document.createElement('div')
    dom.className = 'ai-block'
    dom.setAttribute('data-ai-id', node.attrs.id || '')
    dom.setAttribute('data-ai-ref', node.attrs.ref || 'doc')
    dom.contentEditable = 'false'

    var badge = document.createElement('span')
    badge.className = 'ai-block__badge'

    var contentEl = document.createElement('div')
    contentEl.className = 'ai-block__content'
    contentEl.style.userSelect = 'text'

    dom.appendChild(badge)
    dom.appendChild(contentEl)

    function applyChain(action) {
      var refs = (dom.getAttribute('data-ai-ref') || '').split(',').map(function (r) { return r.trim() }).filter(Boolean)
      var ids = gatherChain(dom.getAttribute('data-ai-id') || '', refs)
      ids.forEach(function (id) {
        if (id === dom.getAttribute('data-ai-id')) return
        var blockEl = document.querySelector('[data-block-id="' + id + '"]')
        if (blockEl) blockEl.classList[action]('block-ref-active')
        var aiEl = document.querySelector('.ai-block[data-ai-id="' + id + '"]')
        if (aiEl) aiEl.classList[action]('ai-block--chain-active')
        var wcEl = document.querySelector('.web-clip-block[data-wc-id="' + id + '"]')
        if (wcEl) wcEl.classList[action]('web-clip-block--chain-active')
      })
    }

    // Prevent ProseMirror from treating a click-drag inside the block as a node drag.
    dom.addEventListener('mousedown', function (e) { e.stopPropagation() })

    dom.addEventListener('contextmenu', function (e) {
      e.preventDefault()
      e.stopPropagation()
      if (typeof getPos === 'function') editor.commands.setNodeSelection(getPos())
      document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
        detail: { x: e.clientX, y: e.clientY, context: { type: 'aiBlock', editor: editor, getPos: getPos, node: currentNode } }
      }))
    })

    dom.addEventListener('mouseenter', function () { applyChain('add') })
    dom.addEventListener('mouseleave', function () { applyChain('remove') })
    dom.addEventListener('focus', function () { applyChain('add') })
    dom.addEventListener('blur', function () { applyChain('remove') })

    function renderQuestion(q, type) {
      if (!q) return
      var qEl = document.createElement('div')
      qEl.className = 'ai-question'
      var qLabel = document.createElement('strong')
      qLabel.textContent = type === 'EXPLAIN' ? 'Explain: ' : 'Ask: '
      qEl.appendChild(qLabel)
      qEl.appendChild(document.createTextNode(q))
      contentEl.appendChild(qEl)
    }

    function render(n) {
      contentEl.innerHTML = ''
      dom.setAttribute('data-ai-id', n.attrs.id || '')
      dom.setAttribute('data-ai-ref', n.attrs.ref || 'doc')

      var status = n.attrs.status || 'PENDING'

      if (status === 'PENDING' || status === 'DISPATCHED') {
        if (isStale(n.attrs.createdAt, n.attrs.id)) {
          badge.className = 'ai-block__badge ai-block__badge--error'
          badge.textContent = 'AI'
          renderQuestion(n.attrs.question, n.attrs.type)
          var errEl = document.createElement('p')
          errEl.className = 'ai-block__timeout'
          errEl.textContent = 'Request timed out. (Right-click to Retry)'
          contentEl.appendChild(errEl)
        } else {
          badge.className = 'ai-block__badge ai-block__badge--thinking'
          badge.textContent = 'AI'
          renderQuestion(n.attrs.question, n.attrs.type)
          var thinking = document.createElement('p')
          var em = document.createElement('em')
          em.textContent = '(thinking…)'
          thinking.appendChild(em)
          contentEl.appendChild(thinking)
        }
      } else if (status === 'COMPLETE') {
        badge.className = 'ai-block__badge'
        badge.textContent = 'AI'

        renderQuestion(n.attrs.question, n.attrs.type)

        if (n.attrs.response) {
          var responseEl = document.createElement('div')
          responseEl.className = 'ai-block__response'
          responseEl.innerHTML = renderMarkdown(n.attrs.response, editor)
          applyHighlighting(responseEl)
          contentEl.appendChild(responseEl)
        }
      } else {
        // TIMEOUT, ERROR, or unknown status
        badge.className = 'ai-block__badge ai-block__badge--error'
        badge.textContent = 'AI'

        renderQuestion(n.attrs.question, n.attrs.type)

        var errEl2 = document.createElement('p')
        errEl2.className = 'ai-block__timeout'
        errEl2.textContent = 'Request timed out. (Right-click to Retry)'
        contentEl.appendChild(errEl2)
      }
    }

    render(node)

    return {
      dom: dom,
      contentDOM: null,
      update: function (updatedNode) {
        if (updatedNode.type.name !== 'aiBlock') return false
        currentNode = updatedNode
        render(updatedNode)
        return true
      },
      ignoreMutation: function () { return true },
      stopEvent: function (event) {
        // Let modifier+key shortcuts through so Cmd+E / Cmd+Shift+A still work
        if (event.type === 'keydown' && (event.metaKey || event.ctrlKey)) return false
        // Block everything else — prevents accidental deletion when text is selected inside
        return event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress'
      },
    }
  }

  // ── AiBlock Node ─────────────────────────────────────────────────────────────

  var AiBlock = Node.create({
    name: 'aiBlock',
    group: 'block',
    selectable: true,
    draggable: false,
    addAttributes() {
      return {
        rawYaml:     { default: '', parseHTML: function (el) { return el.getAttribute('data-raw-yaml') || '' } },
        id:          { default: '', parseHTML: function (el) { return el.getAttribute('data-id') || '' } },
        ref:         { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
        status:      { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status') || 'PENDING' } },
        type:        { default: null, parseHTML: function (el) { return el.getAttribute('data-block-type') || null } },
        model:       { default: null, parseHTML: function (el) { return el.getAttribute('data-model') || null } },
        createdAt:   { default: null, parseHTML: function (el) { return el.getAttribute('data-created-at') || null } },
        completedAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
        question:    { default: '', parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
        response:    { default: null, parseHTML: function (el) { return el.getAttribute('data-response') || null } },
      }
    },

    parseHTML() {
      return [{ tag: 'div[data-type="aiBlock"]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'aiBlock' }, HTMLAttributes)]
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
            state.write('```ai-block\n' + raw + '\n```')
            state.closeBlock(node)
          },
          parse: {
            setup: function (markdownit) {
              var defaultFence = markdownit.renderer.rules.fence
              markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                var token = tokens[idx]
                if (token.info.trim() !== 'ai-block') {
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }
                var data
                try { data = window.jsyaml.load(token.content) } catch (e) { data = null }
                if (!data || !data.id) {
                  // Non-destructive: leave as default fence render if unparseable
                  return defaultFence
                    ? defaultFence(tokens, idx, options, env, self)
                    : self.renderToken(tokens, idx, options)
                }
                // Store raw YAML so the serializer can replay it without regenerating.
                var attrs = [
                  'data-type="aiBlock"',
                  'data-raw-yaml="' + esc(token.content) + '"',
                  'data-id="' + esc(data.id) + '"',
                  'data-ref="' + esc(data.ref || 'doc') + '"',
                  'data-status="' + esc(data.status || 'PENDING') + '"',
                ]
                if (data.type)        attrs.push('data-block-type="' + esc(data.type) + '"')
                if (data.model)       attrs.push('data-model="' + esc(data.model) + '"')
                if (data.createdAt)   attrs.push('data-created-at="' + esc(data.createdAt) + '"')
                if (data.completedAt) attrs.push('data-completed-at="' + esc(data.completedAt) + '"')
                if (data.question)    attrs.push('data-question="' + esc(data.question) + '"')
                if (data.response)    attrs.push('data-response="' + esc((data.response || '').trim()) + '"')
                return '<div ' + attrs.join(' ') + '></div>\n'
              }
            },
          },
        },
      }
    },
  })

  // ── AiShortcuts ──────────────────────────────────────────────────────────────

  var AiShortcuts = Extension.create({
    name: 'aiShortcuts',
    addKeyboardShortcuts() {
      var opts = this.options
      return {
        'Mod-e': function () { opts.onExplain && opts.onExplain(); return true },
        'Mod-Shift-a': function () { opts.onAsk && opts.onAsk(); return true },
        'Mod-Shift-A': function () { opts.onAsk && opts.onAsk(); return true },
        'Mod-j': function () { opts.onToggleAiBlocks && opts.onToggleAiBlocks(); return true },
        'Mod-J': function () { opts.onToggleAiBlocks && opts.onToggleAiBlocks(); return true },
      }
    },
  })

  // ── Expose ───────────────────────────────────────────────────────────────────

  T.AiBlock = AiBlock
  T.AiShortcuts = AiShortcuts

})()
