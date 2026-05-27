// ai-block-extension.js — fenced YAML ai-block format (canonical).
// Depends on window.TipTap (vendor/tiptap.js) and window.jsyaml (vendor/js-yaml.js).
// Attaches AiBlock, AiShortcuts to window.TipTap.

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

  // serializeAiBlockYaml is used by both the markdown serializer and context-menu.js
  T.serializeAiBlockYaml = serializeAiBlockYaml

  // ── serializeAiBlockYaml ────────────────────────────────────────────────────

  function serializeAiBlockYaml(attrs) {
    var lines = []
    lines.push('id: ' + attrs.id)
    lines.push('ref: ' + (attrs.ref || 'doc'))
    lines.push('status: ' + (attrs.status || 'PENDING'))
    if (attrs.type) lines.push('type: ' + attrs.type)
    if (attrs.model) lines.push('model: ' + attrs.model)
    if (attrs.createdAt) lines.push('createdAt: ' + attrs.createdAt)
    if (attrs.completedAt) lines.push('completedAt: ' + attrs.completedAt)

    var q = attrs.question || ''
    if (q.includes('\n')) {
      lines.push('question: |')
      q.split('\n').forEach(function (l) { lines.push('  ' + l) })
    } else if (q) {
      lines.push('question: ' + q)
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

    function renderMarkdown(text) {
      try {
        var md = editor && editor.storage && editor.storage.markdown
        if (md && md.parser && md.parser.md) {
          return md.parser.md.render(text.trim())
        }
      } catch (e) { /* fall through */ }
      var div = document.createElement('div')
      div.textContent = text
      return div.innerHTML
    }

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

      if (status === 'PENDING') {
        badge.className = 'ai-block__badge ai-block__badge--thinking'
        badge.textContent = 'AI'

        renderQuestion(n.attrs.question, n.attrs.type)

        var thinking = document.createElement('p')
        var em = document.createElement('em')
        em.textContent = '(thinking…)'
        thinking.appendChild(em)
        contentEl.appendChild(thinking)
      } else if (status === 'COMPLETE') {
        badge.className = 'ai-block__badge'
        badge.textContent = 'AI'

        renderQuestion(n.attrs.question, n.attrs.type)

        if (n.attrs.response) {
          var responseEl = document.createElement('div')
          responseEl.className = 'ai-block__response'
          responseEl.innerHTML = renderMarkdown(n.attrs.response)
          contentEl.appendChild(responseEl)
        }
      } else {
        // TIMEOUT or unknown status
        badge.className = 'ai-block__badge ai-block__badge--error'
        badge.textContent = 'AI'

        renderQuestion(n.attrs.question, n.attrs.type)

        var errEl = document.createElement('p')
        errEl.className = 'ai-block__timeout'
        errEl.textContent = 'Request timed out. (Right-click to Retry)'
        contentEl.appendChild(errEl)
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
        id: { default: '', parseHTML: function (el) { return el.getAttribute('data-id') || '' } },
        ref: { default: 'doc', parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' } },
        status: { default: 'PENDING', parseHTML: function (el) { return el.getAttribute('data-status') || 'PENDING' } },
        type: { default: null, parseHTML: function (el) { return el.getAttribute('data-block-type') || null } },
        model: { default: null, parseHTML: function (el) { return el.getAttribute('data-model') || null } },
        createdAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-created-at') || null } },
        completedAt: { default: null, parseHTML: function (el) { return el.getAttribute('data-completed-at') || null } },
        question: { default: '', parseHTML: function (el) { return el.getAttribute('data-question') || '' } },
        response: { default: null, parseHTML: function (el) { return el.getAttribute('data-response') || null } },
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
          serialize: function (state, node) {
            state.ensureNewLine()
            state.write('```ai-block\n' + serializeAiBlockYaml(node.attrs) + '\n```')
            state.closeBlock(node)
          },
          parse: {
            // updateDOM converts <pre><code class="language-ai-block"> produced by
            // markdown-it into <div data-type="aiBlock"> for the DOMParser to pick up.
            updateDOM: function (element) {
              var codes = Array.from(element.querySelectorAll('code.language-ai-block'))
              codes.forEach(function (code) {
                var pre = code.parentElement
                if (!pre || pre.tagName !== 'PRE') return
                var yamlText = code.textContent || ''
                var data
                try {
                  data = window.jsyaml.load(yamlText)
                } catch (e) {
                  return // leave original <pre> intact — renders as code block
                }
                if (!data || !data.id) return
                var div = document.createElement('div')
                div.setAttribute('data-type', 'aiBlock')
                div.setAttribute('data-id', data.id || '')
                div.setAttribute('data-ref', data.ref || 'doc')
                div.setAttribute('data-status', data.status || 'PENDING')
                if (data.type) div.setAttribute('data-block-type', data.type)
                if (data.model) div.setAttribute('data-model', data.model)
                if (data.createdAt) div.setAttribute('data-created-at', data.createdAt)
                if (data.completedAt) div.setAttribute('data-completed-at', data.completedAt)
                if (data.question) div.setAttribute('data-question', data.question)
                if (data.response) div.setAttribute('data-response', data.response)
                if (pre.parentNode) pre.parentNode.replaceChild(div, pre)
              })
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
