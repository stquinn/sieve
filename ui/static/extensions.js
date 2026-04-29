// extensions.js — vanilla JS TipTap custom extensions.
// Depends on window.TipTap (ui/static/vendor/tiptap.js) being loaded first.
// Augments window.TipTap with custom extensions so editor.js finds them as T.*

;(function () {
  'use strict'

  var T = window.TipTap
  var Node = T.Node
  var Extension = T.Extension
  var mergeAttributes = T.mergeAttributes
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey
  var Decoration = T.Decoration
  var DecorationSet = T.DecorationSet

  // ── Helpers ────────────────────────────────────────────────────────────────

  function resolveDisplaySrc(src, activeTabPath) {
    if (!src) return ''
    if (src.startsWith('http')) {
      return window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
    }
    if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/')) return src
    if (src.includes('dash/') || src.includes('store/') || src.startsWith('.assets/') || src.includes('/buffers/')) {
      var cleanSrc = src.startsWith('/') ? src.substring(1) : src
      return '/sieve/' + cleanSrc
    }
    if (!activeTabPath) return src
    var tabDir = activeTabPath.split('/').slice(0, -1)
    var srcParts = src.split('/')
    var parts = tabDir.slice()
    for (var i = 0; i < srcParts.length; i++) {
      var part = srcParts[i]
      if (part === '..') { parts.pop() }
      else if (part !== '.') { parts.push(part) }
    }
    return '/sieve/' + parts.join('/')
  }

  function mdSrcToStoreRelPath(src, tabPath) {
    if (!src || src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:')) return ''
    if (src.startsWith('/')) return src.substring(1)
    var tabDir = tabPath.split('/').slice(0, -1)
    var parts = tabDir.slice()
    var srcParts = src.split('/')
    for (var i = 0; i < srcParts.length; i++) {
      var part = srcParts[i]
      if (part === '..') parts.pop()
      else if (part !== '.') parts.push(part)
    }
    return parts.join('/')
  }

  function getCleanMarkdown(fullMd) {
    var regex = /\n*\[!ai\] id="[^"]+" ref="[^"]+"[\s\S]*?\[!ai-end\]\n*/g
    return fullMd.replace(regex, '\n\n').trim()
  }

  // ── AiQuestion ─────────────────────────────────────────────────────────────

  var AiQuestion = Node.create({
    name: 'aiQuestion',
    group: 'block',
    content: 'block+',
    selectable: false,
    parseHTML() {
      return [{ tag: 'div[data-type="aiQuestion"]' }]
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'aiQuestion', class: 'ai-question' }), 0]
    },
  })

  // ── AiBlock ────────────────────────────────────────────────────────────────

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

  function makeAiBlockNodeView({ node }) {
    var dom = document.createElement('div')
    dom.className = 'ai-block'
    dom.setAttribute('data-ai-id', node.attrs.id || '')
    dom.setAttribute('data-ai-ref', node.attrs.ref || 'doc')

    var badge = document.createElement('span')
    badge.className = 'ai-block__badge' + (node.textContent.includes('(thinking\u2026)') ? ' ai-block__badge--thinking' : '')
    badge.textContent = 'AI'

    var contentEl = document.createElement('div')
    contentEl.className = 'ai-block__content'

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
      })
    }

    dom.addEventListener('mouseenter', function () { applyChain('add') })
    dom.addEventListener('mouseleave', function () { applyChain('remove') })
    dom.addEventListener('focus',      function () { applyChain('add') })
    dom.addEventListener('blur',       function () { applyChain('remove') })

    return {
      dom: dom,
      contentDOM: contentEl,
      update: function (updatedNode) {
        if (updatedNode.type.name !== 'aiBlock') return false
        dom.setAttribute('data-ai-id', updatedNode.attrs.id || '')
        dom.setAttribute('data-ai-ref', updatedNode.attrs.ref || 'doc')
        badge.className = 'ai-block__badge' + (updatedNode.textContent.includes('(thinking\u2026)') ? ' ai-block__badge--thinking' : '')
        return true
      },
    }
  }

  var AiBlock = Node.create({
    name: 'aiBlock',
    group: 'block',
    content: '(aiQuestion | block)+',
    defining: true,

    addAttributes() {
      return {
        id: {
          default: '',
          parseHTML: function (el) { return el.getAttribute('data-id') || '' },
          renderHTML: function (attrs) { return { 'data-id': attrs.id } },
        },
        ref: {
          default: 'doc',
          parseHTML: function (el) { return el.getAttribute('data-ref') || 'doc' },
          renderHTML: function (attrs) { return { 'data-ref': attrs.ref } },
        },
      }
    },

    parseHTML() {
      return [{ tag: 'div[data-type="aiBlock"]' }]
    },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'aiBlock' }, HTMLAttributes), 0]
    },

    addNodeView() {
      return makeAiBlockNodeView
    },

    addStorage() {
      return {
        markdown: {
          serialize: function (state, node) {
            state.ensureNewLine()
            state.write('[!ai] id="' + node.attrs.id + '" ref="' + node.attrs.ref + '"')
            state.closeBlock(node)
            node.content.forEach(function (child) {
              if (child.type.name === 'aiQuestion') {
                child.content.forEach(function (inner) { state.render(inner) })
              } else {
                state.render(child)
              }
            })
            state.ensureNewLine()
            state.write('[!ai-end]')
            state.closeBlock(node)
          },
          parse: {
            updateDOM: function (element) {
              function processEl(el) {
                var changed = true
                while (changed) {
                  changed = false
                  var children = Array.from(el.children)
                  for (var i = 0; i < children.length; i++) {
                    var child = children[i]
                    if (child.tagName !== 'P') continue
                    var text = (child.textContent || '').trim()
                    if (!text.startsWith('[!ai]') || text.startsWith('[!ai-end]')) continue
                    var endIdx = -1
                    for (var j = i + 1; j < children.length; j++) {
                      if (children[j].tagName === 'P' && (children[j].textContent || '').startsWith('[!ai-end]')) {
                        endIdx = j; break
                      }
                    }
                    if (endIdx === -1) break
                    var idMatch = text.match(/id="([^"]+)"/)
                    var refMatch = text.match(/ref="([^"]+)"/)
                    var wrapper = document.createElement('div')
                    wrapper.setAttribute('data-type', 'aiBlock')
                    wrapper.setAttribute('data-id', idMatch ? idMatch[1] : '')
                    wrapper.setAttribute('data-ref', refMatch ? refMatch[1] : 'doc')
                    for (var k = i + 1; k < endIdx; k++) wrapper.appendChild(children[k])
                    var firstChild = wrapper.firstChild
                    if (firstChild &&
                        firstChild.getAttribute &&
                        firstChild.getAttribute('data-type') !== 'aiQuestion' &&
                        (firstChild.textContent || '').trim().startsWith('Ask: ')) {
                      var qWrapper = document.createElement('div')
                      qWrapper.setAttribute('data-type', 'aiQuestion')
                      if (wrapper.querySelector('hr')) {
                        while (wrapper.firstChild &&
                               wrapper.firstChild instanceof HTMLElement &&
                               wrapper.firstChild.tagName !== 'HR') {
                          qWrapper.appendChild(wrapper.firstChild)
                        }
                      } else {
                        while (wrapper.firstChild && wrapper.firstChild instanceof HTMLElement) {
                          var t = (wrapper.firstChild.textContent || '').trim()
                          if (t === '' || t.length > 120) break
                          qWrapper.appendChild(wrapper.firstChild)
                        }
                      }
                      wrapper.insertBefore(qWrapper, wrapper.firstChild)
                    }
                    el.insertBefore(wrapper, child)
                    child.remove()
                    children[endIdx].remove()
                    changed = true
                    break
                  }
                }
                // Recurse into nested block containers (e.g. blockRef divs)
                Array.from(el.children).forEach(function (c) {
                  if (c.tagName === 'DIV' && c.children.length > 0) processEl(c)
                })
              }
              processEl(element)
            },
          },
        },
      }
    },
  })

  // ── AiShortcuts ────────────────────────────────────────────────────────────

  var AiShortcuts = Extension.create({
    name: 'aiShortcuts',
    addKeyboardShortcuts() {
      var opts = this.options
      return {
        'Mod-e':       function () { opts.onExplain        && opts.onExplain();        return true },
        'Mod-Shift-a': function () { opts.onAsk            && opts.onAsk();            return true },
        'Mod-Shift-A': function () { opts.onAsk            && opts.onAsk();            return true },
        'Mod-j':       function () { opts.onToggleAiBlocks && opts.onToggleAiBlocks(); return true },
        'Mod-J':       function () { opts.onToggleAiBlocks && opts.onToggleAiBlocks(); return true },
      }
    },
  })

  // ── BlockNode ──────────────────────────────────────────────────────────────

  function makeBlockNodeView({ node }) {
    var dom = document.createElement('div')
    dom.className = 'block-node'
    dom.setAttribute('data-block-id', node.attrs.id || '')
    var contentEl = document.createElement('div')
    dom.appendChild(contentEl)
    return {
      dom: dom,
      contentDOM: contentEl,
      update: function (updatedNode) {
        if (updatedNode.type.name !== 'blockRef') return false
        dom.setAttribute('data-block-id', updatedNode.attrs.id || '')
        return true
      },
    }
  }

  var BlockNode = Node.create({
    name: 'blockRef',
    group: 'block',
    content: 'block+',
    defining: true,

    addAttributes() {
      return {
        id: {
          default: '',
          parseHTML: function (el) { return el.getAttribute('data-id') || '' },
          renderHTML: function (attrs) { return { 'data-id': attrs.id } },
        },
      }
    },

    parseHTML() { return [{ tag: 'div[data-type="blockRef"]' }] },

    renderHTML({ HTMLAttributes }) {
      return ['div', mergeAttributes({ 'data-type': 'blockRef' }, HTMLAttributes), 0]
    },

    addNodeView() { return makeBlockNodeView },

    addStorage() {
      return {
        markdown: {
          serialize: function (state, node) {
            state.write('[!block] id="' + node.attrs.id + '"')
            state.closeBlock(node)
            state.renderContent(node)
            state.write('[!block-end]')
            state.closeBlock(node)
          },
          parse: {
            updateDOM: function (element) {
              var changed = true
              while (changed) {
                changed = false
                var children = Array.from(element.children)
                for (var i = 0; i < children.length; i++) {
                  var child = children[i]
                  if (child.tagName !== 'P') continue
                  var text = child.textContent || ''
                  if (!text.startsWith('[!block]')) continue
                  var endIdx = -1
                  for (var j = i + 1; j < children.length; j++) {
                    if (children[j].tagName === 'P' && (children[j].textContent || '').startsWith('[!block-end]')) {
                      endIdx = j; break
                    }
                  }
                  if (endIdx === -1) break
                  var idMatch = text.match(/id="([^"]+)"/)
                  var wrapper = document.createElement('div')
                  wrapper.setAttribute('data-type', 'blockRef')
                  wrapper.setAttribute('data-id', idMatch ? idMatch[1] : '')
                  for (var k = i + 1; k < endIdx; k++) wrapper.appendChild(children[k])
                  element.insertBefore(wrapper, child)
                  child.remove()
                  children[endIdx].remove()
                  changed = true
                  break
                }
              }
            },
          },
        },
      }
    },
  })

  // ── CodeBlockWithAttrs ─────────────────────────────────────────────────────

  function parseInfoString(info) {
    var trimmed = info.trim()
    var language = trimmed.split(/\s/)[0] || ''
    var idMatch = trimmed.match(/\bid="([^"]*)"/)
    var detectMatch = trimmed.match(/\bdetect="([^"]*)"/)
    return {
      language: language,
      id: idMatch ? idMatch[1] : null,
      detect: detectMatch ? detectMatch[1] : null,
    }
  }

  var CodeBlockWithAttrs = T.CodeBlockLowlight.extend({
    addAttributes() {
      return Object.assign({}, this.parent ? this.parent() : {}, {
        id: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-block-id') },
          renderHTML: function (attrs) { return attrs.id ? { 'data-block-id': attrs.id } : {} },
        },
        detect: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-detect') },
          renderHTML: function (attrs) { return attrs.detect ? { 'data-detect': attrs.detect } : {} },
        },
      })
    },

    addKeyboardShortcuts() {
      var self = this
      return {
        Tab: function () {
          if (!self.editor.isActive(self.name)) return false
          return self.editor.commands.command(function ({ tr, state }) {
            tr.insertText('\t', state.selection.from, state.selection.to)
            return true
          })
        },
        'Shift-Tab': function () {
          if (!self.editor.isActive(self.name)) return false
          return self.editor.commands.command(function ({ tr, state }) {
            var blockStart = state.selection.$from.start()
            var cursorPos  = state.selection.$from.pos
            var textBefore = state.doc.textBetween(blockStart, cursorPos)
            var lineStart  = blockStart + textBefore.lastIndexOf('\n') + 1
            if (state.doc.textBetween(lineStart, lineStart + 1) !== '\t') return false
            tr.delete(lineStart, lineStart + 1)
            return true
          })
        },
      }
    },

    addNodeView() {
      return function ({ node }) {
        var wrapper = document.createElement('div')
        wrapper.className = 'code-block'
        if (node.attrs.id) wrapper.setAttribute('data-block-id', node.attrs.id)

        var gutter = document.createElement('div')
        gutter.className = 'code-block__gutter'
        gutter.contentEditable = 'false'
        gutter.setAttribute('aria-hidden', 'true')

        var code = document.createElement('code')

        function updateGutter(text) {
          var lines = text.split('\n')
          var lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
          gutter.innerHTML = ''
          for (var i = 0; i < Math.max(lineCount, 1); i++) {
            var span = document.createElement('span')
            span.textContent = String(i + 1)
            gutter.appendChild(span)
          }
        }

        updateGutter(node.textContent)
        wrapper.appendChild(gutter)
        wrapper.appendChild(code)

        return {
          dom: wrapper,
          contentDOM: code,
          update: function (updatedNode) {
            if (updatedNode.type.name !== node.type.name) return false
            if (updatedNode.attrs.id) wrapper.setAttribute('data-block-id', updatedNode.attrs.id)
            updateGutter(updatedNode.textContent)
            return true
          },
        }
      }
    },

    addStorage() {
      var parentStorage = this.parent ? this.parent() : {}
      return Object.assign({}, parentStorage, {
        markdown: {
          serialize: function (state, node) {
            var lang = node.attrs.language || ''
            var id = node.attrs.id ? ' id="' + node.attrs.id + '"' : ''
            var detect = node.attrs.detect ? ' detect="' + node.attrs.detect + '"' : ''
            state.write('```' + lang + id + detect + '\n')
            state.text(node.textContent, false)
            state.ensureNewLine()
            state.write('```')
            state.closeBlock(node)
          },
          parse: {
            setup: function (markdownit) {
              markdownit.set({ langPrefix: 'language-' })
              var upstream = markdownit.renderer.rules.fence && markdownit.renderer.rules.fence.bind(markdownit.renderer)
              markdownit.renderer.rules.fence = function (tokens, idx, options, env, self) {
                var token = tokens[idx]
                var info = token.info
                var parsed = parseInfoString(info)
                token.info = parsed.language
                var html = upstream
                  ? upstream(tokens, idx, options, env, self)
                  : self.renderToken(tokens, idx, options)
                token.info = info
                if (!parsed.id && !parsed.detect) return html
                var dataAttrs = [
                  parsed.id ? 'data-block-id="' + parsed.id + '"' : '',
                  parsed.detect ? 'data-detect="' + parsed.detect + '"' : '',
                ].filter(Boolean).join(' ')
                return html.replace('<pre>', '<pre ' + dataAttrs + '>')
              }
            },
            updateDOM: function (element) {
              element.innerHTML = element.innerHTML.replace(/\n<\/code><\/pre>/g, '</code></pre>')
            },
          },
        },
      })
    },
  })

  // ── ImageWithAttrs ─────────────────────────────────────────────────────────

  var ImageWithAttrs = T.Image.extend({
    addAttributes() {
      return Object.assign({}, this.parent ? this.parent() : {}, {
        id: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-block-id') },
          renderHTML: function (attrs) { return attrs.id ? { 'data-block-id': attrs.id } : {} },
        },
        detect: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-detect') },
          renderHTML: function (attrs) { return attrs.detect ? { 'data-detect': attrs.detect } : {} },
        },
        summary: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-summary') },
          renderHTML: function (attrs) { return attrs.summary ? { 'data-summary': attrs.summary } : {} },
        },
        width: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-width') },
          renderHTML: function (attrs) { return attrs.width ? { 'data-width': attrs.width } : {} },
        },
        height: {
          default: null,
          parseHTML: function (element) { return element.getAttribute('data-height') },
          renderHTML: function (attrs) { return attrs.height ? { 'data-height': attrs.height } : {} },
        },
      })
    },

    addNodeView() {
      return function ({ node, editor, getPos }) {
        var wrapper = document.createElement('div')
        wrapper.style.display = 'inline-block'

        var img = document.createElement('img')
        var resizer = document.createElement('div')
        resizer.className = 'image-resizer'

        function applyAttrs(n) {
          var src = n.attrs.src, alt = n.attrs.alt, width = n.attrs.width
          var height = n.attrs.height, summary = n.attrs.summary, id = n.attrs.id
          var activeTabPath = window.__stashActiveTabPath || ''
          wrapper.className = 'image-block node-image'
          if (id) wrapper.setAttribute('data-block-id', id)
          else wrapper.removeAttribute('data-block-id')
          if (summary) wrapper.setAttribute('data-tooltip', summary)
          else wrapper.removeAttribute('data-tooltip')
          img.src = resolveDisplaySrc(src, activeTabPath)
          img.alt = alt || ''
          img.style.maxWidth = '100%'
          img.style.display = 'block'
          img.style.width  = width  ? (width.match(/^[0-9]+$/)  ? width + 'px'  : width)  : ''
          img.style.height = height ? (height.match(/^[0-9]+$/) ? height + 'px' : height) : ''
        }

        applyAttrs(node)

        resizer.addEventListener('mousedown', function (e) {
          e.preventDefault(); e.stopPropagation()
          var startX = e.clientX, startW = img.clientWidth, startH = img.clientHeight
          var ratio = startW / startH
          function onMove(ev) {
            var w = Math.max(40, startW + ev.clientX - startX)
            var h = Math.round(w / ratio)
            img.style.width = w + 'px'; img.style.height = h + 'px'
            if (typeof getPos === 'function') {
                var pos = getPos()
                editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs, { width: String(w), height: String(h) })))
            }
          }
          function onUp() {
            window.removeEventListener('mousemove', onMove)
            window.removeEventListener('mouseup', onUp)
            document.body.style.cursor = ''
          }
          document.body.style.cursor = 'nwse-resize'
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        })

        wrapper.appendChild(img)
        wrapper.appendChild(resizer)

        return {
          dom: wrapper,
          update: function (updatedNode) {
            if (updatedNode.type.name !== node.type.name) return false
            applyAttrs(updatedNode)
            return true
          },
        }
      }
    },

    addStorage() {
      var parentStorage = this.parent ? this.parent() : {}
      return Object.assign({}, parentStorage, {
        activeTabPath: '',
        markdown: {
          serialize: function (state, node) {
            var alt = state.esc(node.attrs.alt || '')
            var src = node.attrs.src || ''
            var title = node.attrs.title ? ' ' + state.quote(node.attrs.title) : ''
            var idAttr = node.attrs.id ? 'id="' + node.attrs.id + '"' : ''
            var detectAttr = node.attrs.detect ? 'detect="' + node.attrs.detect + '"' : ''
            var summaryAttr = node.attrs.summary ? 'summary="' + node.attrs.summary + '"' : ''
            var widthAttr = node.attrs.width ? 'width="' + node.attrs.width + '"' : ''
            var heightAttr = node.attrs.height ? 'height="' + node.attrs.height + '"' : ''
            var attrs = [idAttr, detectAttr, summaryAttr, widthAttr, heightAttr].filter(Boolean).join(' ')
            var attrsSuffix = attrs ? '{' + attrs + '}' : ''
            state.write('![' + alt + '](' + src + title + ')' + attrsSuffix)
            state.closeBlock(node)
          },
          parse: {
            setup: function (markdownit) {
              markdownit.core.ruler.after('inline', 'image_attrs', function (state) {
                for (var ti = 0; ti < state.tokens.length; ti++) {
                  var token = state.tokens[ti]
                  if (token.type !== 'inline') continue
                  for (var i = 0; i < token.children.length; i++) {
                    var child = token.children[i]
                    if (child.type === 'image') {
                      var next = token.children[i + 1]
                      if (next && next.type === 'text' && next.content.trim().startsWith('{')) {
                        var match = next.content.match(/^\s*\{([^}]+)\}/)
                        if (match) {
                          var attrsStr = match[1]
                          var idMatch = attrsStr.match(/\bid="([^"]*)"/)
                          var detectMatch = attrsStr.match(/\bdetect="([^"]*)"/)
                          var summaryMatch = attrsStr.match(/\bsummary="([^"]*)"/)
                          var widthMatch = attrsStr.match(/\bwidth="([^"]*)"/)
                          var heightMatch = attrsStr.match(/\bheight="([^"]*)"/)
                          if (idMatch) child.attrPush(['data-block-id', idMatch[1]])
                          if (detectMatch) child.attrPush(['data-detect', detectMatch[1]])
                          if (summaryMatch) child.attrPush(['data-summary', summaryMatch[1]])
                          if (widthMatch) child.attrPush(['data-width', widthMatch[1]])
                          if (heightMatch) child.attrPush(['data-height', heightMatch[1]])
                          next.content = next.content.substring(match[0].length)
                        }
                      }
                    }
                  }
                }
              })
            },
            tokens: {
              image: {
                node: 'image',
                getAttrs: function (token) {
                  return {
                    src: token.attrGet('src'),
                    title: token.attrGet('title') || null,
                    alt: (token.children && token.children[0] && token.children[0].content) || '',
                    id: token.attrGet('data-block-id') || null,
                    detect: token.attrGet('data-detect') || null,
                    summary: token.attrGet('data-summary') || null,
                    width: token.attrGet('data-width') || null,
                    height: token.attrGet('data-height') || null,
                  }
                },
              },
            },
          },
        },
      })
    },
  })

  // ── Search ─────────────────────────────────────────────────────────────────

  var searchPluginKey = new PluginKey('search')

  var Search = Extension.create({
    name: 'search',

    addOptions() {
      return { searchClass: 'search-result', currentClass: 'search-result-current' }
    },

    addStorage() {
      return { searchTerm: '', results: [], currentIndex: 0 }
    },

    addCommands() {
      return {
        setSearchTerm: function (searchTerm) {
          return function ({ tr, dispatch }) {
            if (dispatch) tr.setMeta(searchPluginKey, { searchTerm: searchTerm, updateCurrent: true })
            return true
          }
        },
        nextSearchResult: function () {
          return function ({ tr, dispatch }) {
            if (dispatch) tr.setMeta(searchPluginKey, { next: true })
            return true
          }
        },
        prevSearchResult: function () {
          return function ({ tr, dispatch }) {
            if (dispatch) tr.setMeta(searchPluginKey, { prev: true })
            return true
          }
        },
        clearSearch: function () {
          return function ({ tr, dispatch }) {
            if (dispatch) tr.setMeta(searchPluginKey, { searchTerm: '' })
            return true
          }
        },
      }
    },

    addProseMirrorPlugins() {
      var searchClass = this.options.searchClass
      var currentClass = this.options.currentClass
      var storage = this.storage

      return [
        new Plugin({
          key: searchPluginKey,
          state: {
            init: function () {
              return { searchTerm: '', results: [], currentIndex: 0 }
            },
            apply: function (tr, oldState) {
              var meta = tr.getMeta(searchPluginKey)
              var searchTerm = oldState.searchTerm
              var results = oldState.results
              var currentIndex = oldState.currentIndex

              var docChanged = tr.docChanged
              var termChanged = meta && meta.searchTerm !== undefined

              if (termChanged) searchTerm = meta.searchTerm

              if (docChanged || termChanged) {
                results = []
                if (searchTerm) {
                  var lowerTerm = searchTerm.toLowerCase()
                  var termLen = lowerTerm.length
                  tr.doc.descendants(function (node, pos) {
                    if (node.isText && node.text) {
                      var text = node.text.toLowerCase()
                      var idx = text.indexOf(lowerTerm)
                      while (idx !== -1) {
                        results.push({ from: pos + idx, to: pos + idx + termLen })
                        idx = text.indexOf(lowerTerm, idx + termLen)
                      }
                    }
                  })
                }
                if (termChanged || (meta && meta.updateCurrent) || currentIndex >= results.length) {
                  currentIndex = 0
                }
              }

              if (meta && meta.next && results.length > 0) currentIndex = (currentIndex + 1) % results.length
              if (meta && meta.prev && results.length > 0) currentIndex = (currentIndex - 1 + results.length) % results.length

              return { searchTerm: searchTerm, results: results, currentIndex: currentIndex }
            },
          },
          view: function (editorView) {
            return {
              update: function (view, prevState) {
                var state = searchPluginKey.getState(view.state)
                storage.searchTerm = state.searchTerm
                storage.results = state.results
                storage.currentIndex = state.currentIndex

                var oldState = searchPluginKey.getState(prevState)
                if (state.results.length > 0 &&
                    (state.currentIndex !== (oldState && oldState.currentIndex) ||
                     state.searchTerm !== (oldState && oldState.searchTerm))) {
                  var current = state.results[state.currentIndex]
                  if (current) {
                    var dom = view.nodeDOM(current.from)
                    if (dom && dom.scrollIntoView) {
                      dom.scrollIntoView({ behavior: 'smooth', block: 'center' })
                    }
                  }
                }
              },
            }
          },
          props: {
            decorations: function (state) {
              var pluginState = searchPluginKey.getState(state)
              if (!pluginState.results.length) return DecorationSet.empty
              var decos = pluginState.results.map(function (res, idx) {
                var isCurrent = idx === pluginState.currentIndex
                return Decoration.inline(res.from, res.to, {
                  class: isCurrent ? searchClass + ' ' + currentClass : searchClass,
                })
              })
              return DecorationSet.create(state.doc, decos)
            },
          },
        }),
      ]
    },
  })

  // ── buildAiContext ─────────────────────────────────────────────────────────

  function collectChainImagePaths(doc, refs, tabPath) {
    var paths = []
    var seen = new Set()

    if (refs.length === 0 || refs.includes('doc')) {
      doc.descendants(function (node) {
        if (node.type.name === 'image' && node.attrs && node.attrs.src) {
          var p = mdSrcToStoreRelPath(node.attrs.src, tabPath)
          if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
        }
      })
    } else {
      refs.forEach(function (refId) {
        doc.descendants(function (node) {
          if (node.attrs && node.attrs.id === refId) {
            if (node.type.name === 'image' && node.attrs.src) {
              var p = mdSrcToStoreRelPath(node.attrs.src, tabPath)
              if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
            }
            if (node.descendants) {
              node.descendants(function (child) {
                if (child.type.name === 'image' && child.attrs && child.attrs.src) {
                  var p = mdSrcToStoreRelPath(child.attrs.src, tabPath)
                  if (p && !seen.has(p)) { seen.add(p); paths.push(p) }
                }
              })
            }
            return false
          }
        })
      })
    }
    return paths
  }

  function buildAiContext(editor, isMarkdownMode, rawMd, tabPath) {
    if (isMarkdownMode) {
      var ta = document.querySelector('.markdown-raw')
      var cleanBody = getCleanMarkdown(rawMd)
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        return { content: ta.value.substring(ta.selectionStart, ta.selectionEnd).trim(), blockRef: 'doc', history: '', contextLabel: 'Selection', imagePaths: [] }
      }
      return { content: cleanBody, blockRef: 'doc', history: '', contextLabel: 'Document', imagePaths: [] }
    }

    var selection = editor.state.selection
    var doc = editor.state.doc
    var from = selection.from, to = selection.to, empty = selection.empty
    var serializer = editor.storage.markdown.serializer

    var aiBlockRef = '', aiBlockId = ''
    var $from = editor.state.selection.$from
    for (var d = $from.depth; d >= 0; d--) {
      var n = $from.node(d)
      if (n.type.name === 'aiBlock') { aiBlockId = n.attrs.id || ''; aiBlockRef = n.attrs.ref || ''; break }
    }
    if (!aiBlockId) {
      doc.nodesBetween(from, to, function (node) {
        if (node.type.name === 'aiBlock') { aiBlockId = node.attrs.id || ''; aiBlockRef = node.attrs.ref || ''; return false }
      })
    }

    if (aiBlockId) {
      var refs = aiBlockRef.split(',')
      var sourceRef = refs[0]
      var sourceContent = ''
      if (sourceRef && sourceRef !== 'doc') {
        doc.descendants(function (node) {
          if (node.attrs && node.attrs.id === sourceRef) { sourceContent = serializer.serialize(node); return false }
        })
      } else {
        sourceContent = getCleanMarkdown(editor.storage.markdown.getMarkdown())
      }

      var intermediateHistory = []
      var seenIds = new Set()
      var turnCount = 1
      for (var i = 1; i < refs.length; i++) {
        var refId = (refs[i] || '').trim()
        if (!refId || seenIds.has(refId)) continue
        seenIds.add(refId);
        (function (rid, tc) {
          doc.descendants(function (node) {
            if (node.attrs && node.attrs.id === rid) {
              intermediateHistory.push('[Turn ' + tc + ']\n' + serializer.serialize(node))
              return false
            }
          })
        })(refId, turnCount++)
      }

      var currentBlockText = ''
      doc.nodesBetween(from, to, function (node) {
        if (node.type.name === 'aiBlock' && node.attrs && node.attrs.id === aiBlockId) {
          if (!seenIds.has(node.attrs.id)) { currentBlockText = serializer.serialize(node); seenIds.add(node.attrs.id) }
          return false
        }
      })
      if (!currentBlockText && !empty) currentBlockText = doc.textBetween(from, to, '\n')

      var historyTurns = [sourceContent ? '[Source Context]\n' + sourceContent : ''].concat(intermediateHistory).filter(Boolean).join('\n\n---\n\n')
      var newRef = aiBlockRef ? aiBlockRef + ',' + aiBlockId : aiBlockId
      var chainRefs = aiBlockRef ? aiBlockRef.split(',') : ['doc']

      return { content: currentBlockText || sourceContent, blockRef: newRef, history: historyTurns, contextLabel: 'Follow-up', imagePaths: collectChainImagePaths(doc, chainRefs, tabPath) }
    }

    var targetNode = null, targetPos = -1
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (!targetNode && (node.type.name === 'image' || node.type.name === 'codeBlock')) {
        targetNode = node; targetPos = pos; return false
      }
    })

    var selectedText = '', blockRange = null, contextLabel = ''
    if (targetNode && from === targetPos && to === targetPos + targetNode.nodeSize) {
      selectedText = serializer.serialize(targetNode).trim()
      contextLabel = targetNode.type.name === 'image' ? 'Image' : 'Code Block'
    } else if (from !== to) {
      selectedText = serializer.serialize(doc.slice(from, to).content).trim()
      blockRange = selection.$from.blockRange(selection.$to)
      contextLabel = 'Selection'
    } else if (targetNode) {
      selectedText = serializer.serialize(targetNode).trim()
      contextLabel = targetNode.type.name === 'image' ? 'Image' : 'Code Block'
    } else {
      selectedText = getCleanMarkdown(editor.storage.markdown.getMarkdown())
      contextLabel = 'Document'
    }

    var existingBlockId = ''
    if (targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
      existingBlockId = targetNode.attrs.id
    } else if (blockRange) {
      doc.nodesBetween(blockRange.start, blockRange.end, function (node) {
        if (!existingBlockId && node.type.name === 'blockRef' && node.attrs.id) {
          existingBlockId = node.attrs.id; return false
        }
      })
    }

    var blockRef = existingBlockId || 'blk-' + Math.random().toString(16).substring(2, 6)
    var tr = editor.state.tr
    var NodeRange = T.NodeRange

    if (!existingBlockId) {
      try {
        if (targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
          tr.setNodeMarkup(targetPos, undefined, Object.assign({}, targetNode.attrs, { id: blockRef }))
        } else if (blockRange) {
          var topRange = new NodeRange(blockRange.$from, blockRange.$to, 0)
          tr.wrap(topRange, [{ type: editor.state.schema.nodes.blockRef, attrs: { id: blockRef } }])
        }
      } catch (e) {
        // tr.wrap can fail for complex selections; proceed without wrapping
        blockRef = existingBlockId || 'doc'
      }
    }

    var finalImagePaths = []
    if (from !== to || targetNode || blockRange) {
      var seenPaths = new Set()
      var scanRangeFrom = targetNode ? targetPos : (blockRange ? blockRange.start : from)
      var scanRangeTo   = targetNode ? targetPos + targetNode.nodeSize : (blockRange ? blockRange.end : to)
      doc.nodesBetween(scanRangeFrom, scanRangeTo, function (node) {
        if (node.type.name === 'image' && node.attrs && node.attrs.src) {
          var p = mdSrcToStoreRelPath(node.attrs.src, tabPath)
          if (p && !seenPaths.has(p)) { seenPaths.add(p); finalImagePaths.push(p) }
        }
      })
    } else {
      finalImagePaths = collectChainImagePaths(tr.doc, [blockRef], tabPath)
    }

    if (tr.docChanged) editor.view.dispatch(tr)

    return {
      content: selectedText,
      blockRef: (from === to && !targetNode && !blockRange) ? 'doc' : blockRef,
      history: '',
      contextLabel: contextLabel,
      imagePaths: finalImagePaths,
    }
  }

  // ── Expose on window.TipTap ────────────────────────────────────────────────

  T.AiQuestion = AiQuestion
  T.AiBlock = AiBlock
  T.AiShortcuts = AiShortcuts
  T.BlockNode = BlockNode
  T.CodeBlockWithAttrs = CodeBlockWithAttrs
  T.ImageWithAttrs = ImageWithAttrs
  T.Search = Search
  T.buildAiContext = buildAiContext

})()
