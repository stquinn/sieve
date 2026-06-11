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

  // ── BlockNode ──────────────────────────────────────────────────────────────

  function makeBlockNodeView({ node }) {
    var dom = document.createElement('div')
    dom.className = 'block-node'
    dom.setAttribute('data-id', node.attrs.id || '')
    var contentEl = document.createElement('div')
    dom.appendChild(contentEl)
    return {
      dom: dom,
      contentDOM: contentEl,
      update: function (updatedNode) {
        if (updatedNode.type.name !== 'blockRef') return false
        dom.setAttribute('data-id', updatedNode.attrs.id || '')
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

  // ── SelectionHighlight ─────────────────────────────────────────────────────

  var SelectionHighlight = Extension.create({
    name: 'selectionHighlight',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          props: {
            decorations: function (state) {
              var sel = state.selection
              // sel.node is defined for NodeSelection. sel.empty is true for empty TextSelection.
              // So if it's not empty and has no node, it's a TextSelection (or AllSelection)
              if (sel.empty || sel.node) return DecorationSet.empty
              var decos = []
              state.doc.nodesBetween(sel.from, sel.to, function (node, pos) {
                if (node.isLeaf && (node.type.name.startsWith('sieve-') || node.type.name === 'blockRef')) {
                  if (pos >= sel.from && pos + node.nodeSize <= sel.to) {
                    // A sieve block that is part of a multi-block RANGE selection.
                    // Use the range tint (background) — NOT ProseMirror-selectednode,
                    // whose outline is reserved for a single focused NodeSelection.
                    decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'block-in-selection' }))
                  }
                }
              })
              return DecorationSet.create(state.doc, decos)
            }
          }
        })
      ]
    }
  })

  // ── buildAiContext ─────────────────────────────────────────────────────────

  function buildAiContext(editor, isMarkdownMode, rawMd, uuid) {
    var t = T.resolveAiTarget(editor, isMarkdownMode)

    if (t.kind === 'document') return { blockRef: 'doc', contextLabel: 'Document' }
    if (t.kind === 'selection') return { blockRef: t.blockRef || 'doc', contextLabel: t.label }

    // sieveBlock / anchor → reference the existing id (no mutation).
    var n = t.node
    if (n && (n.type.name === 'aiBlock' || n.type.name === 'sieve-ai-block')) {
      // Follow-up: chain this AI block onto its own ref so Go assembles history.
      var aiBlockId = n.attrs.id || ''
      var aiBlockRef = n.attrs.ref || ''
      var newRef = aiBlockRef && aiBlockRef !== 'doc' ? aiBlockRef + ',' + aiBlockId : aiBlockId
      return { blockRef: newRef, contextLabel: 'Follow-up' }
    }
    return { blockRef: t.id || 'doc', contextLabel: t.label }
  }

  // ── getAiTargetLabel ───────────────────────────────────────────────────────
  // Read-only label for the live Ask panel. Single source: resolveAiTarget.
  function getAiTargetLabel(editor, isMarkdownMode) {
    return T.resolveAiTarget(editor, isMarkdownMode).label
  }

  // ── applyTargetHighlight ─────────────────────────────────────────────────────
  // Canonical "mark this selection as the AI target": wraps the parent block in a
  // BlockAnchor (blockRef) and applies the == highlight mark, so the target is both
  // visible and resolvable by buildAiContext. Single source of truth shared by the
  // context menu's "Highlight Target" item and by the Ask AI / Explain event handler
  // in editor.js — so every entry point produces an identical target.
  function wrapInBlockAnchor(editor) {
    var s = editor.state
    var sel = s.selection
    var blockRef = 'blk-' + Math.random().toString(16).substring(2, 6)
    var blockRange = sel.$from.blockRange(sel.$to)
    if (!blockRange) return
    var topRange = new T.NodeRange(blockRange.$from, blockRange.$to, 0)
    var tr = s.tr
    try {
      tr.wrap(topRange, [{ type: s.schema.nodes.blockRef, attrs: { id: blockRef } }])
      editor.view.dispatch(tr)
    } catch (e) { /* selection too complex to wrap */ }
  }

  function applyTargetHighlight(editor) {
    var s = editor.state
    var sel = s.selection
    if (sel.empty) return

    // Detect if the selection covers the entire parent node (discounting whitespace)
    var $from = sel.$from
    var nodeStart = $from.start($from.depth)
    var nodeEnd = $from.end($from.depth)
    var coversNode =
      s.doc.textBetween(sel.from, sel.to).trim() ===
      s.doc.textBetween(nodeStart, nodeEnd).trim()

    // Detect if already inside a BlockAnchor (blockRef node)
    var inBlockAnchor = false
    for (var d = $from.depth; d >= 0; d--) {
      if ($from.node(d).type.name === 'blockRef') { inBlockAnchor = true; break }
    }

    if (coversNode && inBlockAnchor) return            // block already defines the target
    if (coversNode && !inBlockAnchor) { wrapInBlockAnchor(editor); return } // wrap node, no mark

    // Word/phrase selected: wrap parent in BlockAnchor (if needed) then apply == mark.
    if (!inBlockAnchor) wrapInBlockAnchor(editor)
    editor.commands.setMark('highlight')
  }
  T.applyTargetHighlight = applyTargetHighlight

  // ── HighlightMark ──────────────────────────────────────────────────────────
  // Extends the built-in Highlight extension with tiptap-markdown storage so
  // ==word== round-trips correctly through the markdown serializer/parser.

  var HighlightMark = T.Highlight.extend({
    addStorage: function () {
      return {
        markdown: {
          serialize: {
            open: '==',
            close: '==',
            mixable: true,
            expelEnclosingWhitespace: true,
          },
          parse: {
            setup: function (md) {
              md.use(T.markdownItMark)
            },
          },
        },
      }
    },
  })

  var AiShortcuts = Extension.create({
    name: 'aiShortcuts',
    addOptions: function() {
      return {
        onExplain: function() {},
        onAsk: function() {},
        onSmartFile: function() {},
        onKeepAndSmartFile: function() {},
        onToggleAiBlocks: function() {},
      }
    },
    addKeyboardShortcuts: function() {
      var self = this
      return {
        'Mod-e': function() { self.options.onExplain(); return true },
        'Mod-E': function() { self.options.onExplain(); return true },
        'Mod-Shift-a': function() { self.options.onAsk(); return true },
        'Mod-Shift-A': function() { self.options.onAsk(); return true },
        'Mod-Shift-e': function() { self.options.onSmartFile(); return true },
        'Mod-Shift-E': function() { self.options.onSmartFile(); return true },
        'Mod-Shift-w': function() { self.options.onKeepAndSmartFile(); return true },
        'Mod-Shift-W': function() { self.options.onKeepAndSmartFile(); return true },
        'Mod-j': function() { self.options.onToggleAiBlocks(); return true },
        'Mod-J': function() { self.options.onToggleAiBlocks(); return true },
      }
    }
  })

  // ── Expose on window.TipTap ────────────────────────────────────────────────

  T.BlockNode = BlockNode
  T.Search = Search
  T.SelectionHighlight = SelectionHighlight
  T.buildAiContext = buildAiContext
  T.getAiTargetLabel = getAiTargetLabel
  T.HighlightMark = HighlightMark
  T.AiShortcuts = AiShortcuts

})()
