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

  function resolveDisplaySrc(src, uuid) {
    if (!src) return ''
    if (src.startsWith('http')) {
      return window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
    }
    if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/')) return src
    
    // Co-located assets: legacy .assets/ prefix or bare filename -> /sieve/UUID/name.png
    if (src.startsWith('.assets/')) {
      return '/sieve/' + uuid + '/' + src.substring(8)
    }
    // Bare co-located filename (images saved directly in doc directory)
    return '/sieve/' + uuid + '/' + src.split('/').pop()
  }

  function srcToBlockId(src) {
    if (!src || src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:')) return ''
    var filename = src.split('/').pop() || ''
    var dot = filename.lastIndexOf('.')
    return dot > 0 ? filename.substring(0, dot) : filename
  }

  function getCleanMarkdown(fullMd) {
    var legacyRegex = /\n*\[!ai\] id="[^"]+" ref="[^"]+"[\s\S]*?\[!ai-end\]\n*/g
    var fencedRegex = /\n*```ai-block\n[\s\S]*?\n```\n*/g
    return fullMd.replace(legacyRegex, '\n\n').replace(fencedRegex, '\n\n').trim()
  }

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
      // This is a custom property we can hook into
      selectNode: () => {
        dom.classList.add('block-ref-active')
      },
      deselectNode: () => {
        dom.classList.remove('block-ref-active')
      },
      ignoreMutation: function (mutation) {
        // Ignore if only the class attribute changed
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          return true
        }
        return false
      }
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
        var currentNode = node
        var wrapper = document.createElement('div')
        wrapper.style.display = 'inline-block'

        var img = document.createElement('img')
        var resizer = document.createElement('div')
        resizer.className = 'image-resizer'

        function applyAttrs(n) {
          var src = n.attrs.src, alt = n.attrs.alt, width = n.attrs.width
          var height = n.attrs.height, summary = n.attrs.summary, id = n.attrs.id
          var activeTabUuid = window.__stashActiveTabUuid || ''
          wrapper.className = 'image-block node-image'
          if (id) wrapper.setAttribute('data-block-id', id)
          else wrapper.removeAttribute('data-block-id')
          if (summary) wrapper.setAttribute('data-tooltip', summary)
          else wrapper.removeAttribute('data-tooltip')
          img.src = resolveDisplaySrc(src, activeTabUuid)
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

        wrapper.addEventListener('contextmenu', function (e) {
          e.preventDefault()
          e.stopPropagation()
          if (typeof getPos === 'function') editor.commands.setNodeSelection(getPos())
          document.dispatchEvent(new CustomEvent('sieve:contextmenu', {
            detail: { x: e.clientX, y: e.clientY, context: { type: 'image', editor: editor, getPos: getPos, node: currentNode } }
          }))
        })

        return {
          dom: wrapper,
          update: function (updatedNode) {
            if (updatedNode.type.name !== node.type.name) return false
            currentNode = updatedNode
            applyAttrs(updatedNode)
            return true
          },
          ignoreMutation: function (mutation) {
            // Ignore if only the class attribute changed
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
              return true
            }
            return false
          }
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

  function collectChainImageIds(doc, refs, uuid) {
    var ids = []
    var seen = new Set()

    if (refs.length === 0 || refs.includes('doc')) {
      doc.descendants(function (node) {
        if (node.type.name === 'image' && node.attrs && node.attrs.src) {
          var id = srcToBlockId(node.attrs.src)
          if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
        }
      })
    } else {
      refs.forEach(function (refId) {
        doc.descendants(function (node) {
          if (node.attrs && node.attrs.id === refId) {
            if (node.type.name === 'image' && node.attrs.src) {
              var id = srcToBlockId(node.attrs.src)
              if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
            }
            if (node.descendants) {
              node.descendants(function (child) {
                if (child.type.name === 'image' && child.attrs && child.attrs.src) {
                  var id = srcToBlockId(child.attrs.src)
                  if (id && !seen.has(id)) { seen.add(id); ids.push(id) }
                }
              })
            }
            return false
          }
        })
      })
    }
    return ids
  }

  function serializeTableNode(tableNode, serializer) {
    var rows = []
    var colCount = 0
    tableNode.forEach(function (row) {
      if (row.type.name !== 'tableRow') return
      var cells = []
      row.forEach(function (cell) {
        var cellText = serializer.serialize(cell).trim().replace(/\n/g, ' ')
        cells.push(cellText)
      })
      rows.push(cells)
      if (cells.length > colCount) colCount = cells.length
    })
    if (rows.length === 0) return ''
    var mdLines = []
    // Header
    var header = rows[0]
    mdLines.push('| ' + header.join(' | ') + ' |')
    // Divider
    var dividers = []
    for (var i = 0; i < colCount; i++) dividers.push('---')
    mdLines.push('| ' + dividers.join(' | ') + ' |')
    // Body
    for (var r = 1; r < rows.length; r++) {
      mdLines.push('| ' + rows[r].join(' | ') + ' |')
    }
    return mdLines.join('\n')
  }

  function buildAiContext(editor, isMarkdownMode, rawMd, uuid) {
    if (isMarkdownMode) {
      var ta = document.querySelector('.markdown-raw')
      var cleanBody = getCleanMarkdown(rawMd)
      if (ta && ta.selectionStart !== ta.selectionEnd) {
        return { content: ta.value.substring(ta.selectionStart, ta.selectionEnd).trim(), blockRef: 'doc', history: '', contextLabel: 'Selection', imageIds: [] }
      }
      return { content: cleanBody, blockRef: 'doc', history: '', contextLabel: 'Document', imageIds: [] }
    }

    var selection = editor.state.selection
    var doc = editor.state.doc
    var from = selection.from, to = selection.to, empty = selection.empty
    var serializer = editor.storage.markdown.serializer

    var aiBlockRef = '', aiBlockId = ''

    // AI blocks are contentEditable:false so TipTap cursor can't enter them.
    // Check native browser selection first — covers the case where the user
    // has highlighted text inside a rendered AI block response.
    var nativeSel = window.getSelection()
    if (nativeSel && !nativeSel.isCollapsed) {
      var anchorEl = nativeSel.anchorNode
      var el = anchorEl && anchorEl.nodeType === 3 ? anchorEl.parentElement : anchorEl
      while (el && !el.classList.contains('ai-block')) el = el.parentElement
      if (el && el.classList.contains('ai-block')) {
        var nativeId = el.getAttribute('data-ai-id') || ''
        doc.descendants(function (node) {
          if (node.type.name === 'aiBlock' && node.attrs.id === nativeId) {
            aiBlockId = nativeId; aiBlockRef = node.attrs.ref || ''; return false
          }
        })
      }
    }

    var $from = editor.state.selection.$from
    if (!aiBlockId) {
      for (var d = $from.depth; d >= 0; d--) {
        var n = $from.node(d)
        if (n.type.name === 'aiBlock') { aiBlockId = n.attrs.id || ''; aiBlockRef = n.attrs.ref || ''; break }
      }
    }
    if (!aiBlockId) {
      doc.nodesBetween(from, to, function (node) {
        if (node.type.name === 'aiBlock') { aiBlockId = node.attrs.id || ''; aiBlockRef = node.attrs.ref || ''; return false }
      })
    }
    // Cursor may be right after an AI block (e.g. in the next paragraph) — check
    // the node immediately preceding the cursor at each ancestor level.
    if (!aiBlockId) {
      var $pos = selection.$from
      for (var d2 = 0; d2 <= $pos.depth; d2++) {
        var idx = $pos.index(d2)
        if (idx > 0) {
          var prevSibling = $pos.node(d2).child(idx - 1)
          if (prevSibling && prevSibling.type.name === 'aiBlock') {
            aiBlockId = prevSibling.attrs.id || ''
            aiBlockRef = prevSibling.attrs.ref || ''
            break
          }
        }
      }
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

      function aiBlockSummary(node) {
        var q = (node.attrs.question || '').trim()
        var r = (node.attrs.response || '').trim()
        if (!q && !r) return serializer.serialize(node).trim()
        var parts = []
        if (q) parts.push('**Q:** ' + q)
        if (r) parts.push('**A:** ' + r)
        return parts.join('\n\n')
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
              intermediateHistory.push('[Turn ' + tc + ']\n' + aiBlockSummary(node))
              return false
            }
          })
        })(refId, turnCount++)
      }

      var currentBlockText = ''
      doc.nodesBetween(from, to, function (node) {
        if (node.type.name === 'aiBlock' && node.attrs && node.attrs.id === aiBlockId) {
          if (!seenIds.has(node.attrs.id)) { currentBlockText = aiBlockSummary(node); seenIds.add(node.attrs.id) }
          return false
        }
      })
      // Cursor was detected as adjacent to the AI block — also search the full selection range
      if (!currentBlockText) {
        doc.descendants(function (node) {
          if (node.type.name === 'aiBlock' && node.attrs.id === aiBlockId && !seenIds.has(aiBlockId)) {
            currentBlockText = aiBlockSummary(node); seenIds.add(aiBlockId); return false
          }
        })
      }
      if (!currentBlockText && !empty) currentBlockText = doc.textBetween(from, to, '\n')

      var historyTurns = [sourceContent ? '[Source Context]\n' + sourceContent : ''].concat(intermediateHistory).filter(Boolean).join('\n\n---\n\n')
      var newRef = aiBlockRef ? aiBlockRef + ',' + aiBlockId : aiBlockId
      var chainRefs = aiBlockRef ? aiBlockRef.split(',') : ['doc']

      return { content: currentBlockText || sourceContent, blockRef: newRef, history: historyTurns, contextLabel: 'Follow-up', imageIds: collectChainImageIds(doc, chainRefs, uuid) }
    }

    var targetNode = null, targetPos = -1
    var scanFrom = (from === to) ? Math.max(0, from - 1) : from
    var scanTo   = (from === to) ? Math.min(doc.content.size, to + 1) : to
    doc.nodesBetween(scanFrom, scanTo, function (node, pos) {
      if (!targetNode && (node.type.name === 'image' || node.type.name === 'codeBlock' || node.type.name === 'table' || node.type.name === 'webClip' || node.type.name === 'sieve-code')) {
        targetNode = node; targetPos = pos; return false
      }
    })

    function labelFor(node) {
      switch (node.type.name) {
        case 'image':      return 'Image'
        case 'codeBlock':  return 'Code Block'
        case 'sieve-code': return 'Code Block'
        case 'table':      return 'Table'
        case 'webClip':    return 'Web Clip'
        default:           return node.type.name
      }
    }

    function textFor(node) {
      if (node.type.name === 'sieve-code') {
        return (node.attrs.source || '').trim()
      }
      if (node.type.name === 'table') return serializeTableNode(node, serializer)
      if (node.type.name === 'webClip') {
        // Give AI the rich content rather than raw YAML
        var a = node.attrs
        var parts = []
        if (a.title) parts.push('# ' + a.title)
        if (a.source) parts.push('Source: ' + a.source)
        if (a.content) parts.push(a.content)
        return parts.join('\n\n').trim() || serializer.serialize(node).trim()
      }
      return serializer.serialize(node).trim()
    }

    var selectedText = '', blockRange = null, contextLabel = ''
    if (targetNode && from === targetPos && to === targetPos + targetNode.nodeSize) {
      selectedText = textFor(targetNode)
      contextLabel = labelFor(targetNode)
    } else if (from !== to) {
      selectedText = serializer.serialize(doc.slice(from, to).content).trim()
      blockRange = selection.$from.blockRange(selection.$to)
      contextLabel = 'Selection'
    } else if (targetNode) {
      selectedText = textFor(targetNode)
      contextLabel = labelFor(targetNode)
    } else {
      selectedText = getCleanMarkdown(editor.storage.markdown.getMarkdown())
      contextLabel = 'Document'
    }

    var existingBlockId = ''
    for (var d = selection.$from.depth; d >= 0; d--) {
      var n = selection.$from.node(d)
      if (n.type.name === 'blockRef') {
        existingBlockId = n.attrs.id || ''
        break
      }
    }
    if (!existingBlockId && targetNode && from >= targetPos && to <= targetPos + targetNode.nodeSize) {
      existingBlockId = targetNode.attrs.id || ''
    } else if (!existingBlockId && blockRange) {
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
          if (targetNode.type.name === 'table') {
            var $from = doc.resolve(targetPos)
            var $to = doc.resolve(targetPos + targetNode.nodeSize)
            var topRange = new NodeRange($from, $to, 0)
            tr.wrap(topRange, [{ type: editor.state.schema.nodes.blockRef, attrs: { id: blockRef } }])
          } else {
            tr.setNodeMarkup(targetPos, undefined, Object.assign({}, targetNode.attrs, { id: blockRef }))
          }
        } else if (blockRange) {
          var topRange = new NodeRange(blockRange.$from, blockRange.$to, 0)
          tr.wrap(topRange, [{ type: editor.state.schema.nodes.blockRef, attrs: { id: blockRef } }])
        }
      } catch (e) {
        // tr.wrap can fail for complex selections; proceed without wrapping
        blockRef = existingBlockId || 'doc'
      }
    }

    var finalImageIds = []
    if (from !== to || targetNode || blockRange) {
      var seenIds = new Set()
      var scanRangeFrom = targetNode ? targetPos : (blockRange ? blockRange.start : from)
      var scanRangeTo   = targetNode ? targetPos + targetNode.nodeSize : (blockRange ? blockRange.end : to)
      doc.nodesBetween(scanRangeFrom, scanRangeTo, function (node) {
        if (node.type.name === 'image' && node.attrs && node.attrs.src) {
          var id = srcToBlockId(node.attrs.src)
          if (id && !seenIds.has(id)) { seenIds.add(id); finalImageIds.push(id) }
        }
      })
    } else {
      finalImageIds = collectChainImageIds(tr.doc, [blockRef], uuid)
    }

    if (tr.docChanged) editor.view.dispatch(tr)

    return {
      content: selectedText,
      blockRef: (from === to && !targetNode && !blockRange) ? 'doc' : blockRef,
      history: '',
      contextLabel: contextLabel,
      imageIds: finalImageIds,
    }
  }

  // ── Expose on window.TipTap ────────────────────────────────────────────────

  T.BlockNode = BlockNode
  T.ImageWithAttrs = ImageWithAttrs
  T.Search = Search
  T.buildAiContext = buildAiContext

})()
