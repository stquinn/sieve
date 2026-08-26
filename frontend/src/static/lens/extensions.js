import { T as VENDOR } from './document-editor/surfaces/tiptap-vendor.js'

var Node = VENDOR.Node
var Extension = VENDOR.Extension
var Plugin = VENDOR.Plugin
var PluginKey = VENDOR.PluginKey
var Decoration = VENDOR.Decoration
var DecorationSet = VENDOR.DecorationSet

  var searchPluginKey = new PluginKey('search')

  export var Search = Extension.create({
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
                    // nodeDOM(pos) resolves only when pos sits exactly on a child's start
                    // boundary, and then yields a raw Text node with no .scrollIntoView. domAtPos
                    // resolves any position; climb to the nearest Element and scroll that.
                    var located = view.domAtPos(current.from)
                    var dom = located && located.node
                    while (dom && dom.nodeType !== 1) dom = dom.parentNode
                    // A match can resolve to a DETACHED element — a diagram in render mode
                    // orphans its <code> contentDOM — which has no geometry anywhere up its
                    // chain. Fall back through the doc and scroll the top-level block's
                    // NodeView wrapper, which is attached.
                    var box = dom && dom.getBoundingClientRect()
                    var attached = dom && document.contains(dom) && (box.width || box.height)
                    if (!attached) {
                      var $pos = view.state.doc.resolve(current.from)
                      if ($pos.depth >= 1) {
                        var blockDom = view.nodeDOM($pos.before(1))
                        if (blockDom && blockDom.nodeType === 1) dom = blockDom
                      }
                    }
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

  export var SelectionHighlight = Extension.create({
    name: 'selectionHighlight',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          props: {
            decorations: function (state) {
              var sel = state.selection
              // NodeSelection sets sel.node; an empty TextSelection sets sel.empty — so
              // neither flag means a non-empty text range.
              if (sel.empty || sel.node) return DecorationSet.empty
              var decos = []
              state.doc.nodesBetween(sel.from, sel.to, function (node, pos) {
                if (node.isLeaf && node.type.name.startsWith('sieve-')) {
                  if (pos >= sel.from && pos + node.nodeSize <= sel.to) {
                    // Range tint, NOT ProseMirror-selectednode: that outline is reserved for a
                    // single focused NodeSelection.
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

  // Reads ONLY the AI target the editor already resolved into its SelectionContext
  // (context.target = {kind, ref, range, label}) — no PM walk, no re-derivation.
  export function buildAiContext(context) {
    var t = context.target

    if (t.kind === 'document') return { blockRef: 'doc', contextLabel: 'Document' }
    if (t.kind === 'selection') return { blockRef: t.ref || 'doc', contextLabel: t.label }

    // block → the target's SINGLE id. Go walks the ref back-pointer chain
    // server-side to reconstitute an ai-block thread; never pre-walk it here.
    // Every block kind falls through to this.
    return { blockRef: t.ref || 'doc', contextLabel: t.label }
  }

  // Canonical "mark this selection as the AI target": applies the == highlight mark
  // to the range. Every entry point routes through here, so targets are identical.
  export function applyTargetHighlight(editor, range) {
    // Marks the EXPLICIT range passed in — never re-derive the extent from
    // editor.state.selection, which may have drifted since the label rendered.
    // No range / collapsed → no-op.
    if (!range || range.from == null || range.from === range.to) return
    if (editor.isActive && editor.isActive('highlight')) return // already marked
    editor.chain().setTextSelection({ from: range.from, to: range.to }).setMark('highlight').run()
  }

  // Extends the built-in Highlight extension with tiptap-markdown storage so
  // ==word== round-trips correctly through the markdown serializer/parser.

  export var HighlightMark = VENDOR.Highlight.extend({
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
              md.use(VENDOR.markdownItMark)
            },
          },
        },
      }
    },
  })

  export var AiShortcuts = Extension.create({
    name: 'aiShortcuts',
    addOptions: function() {
      return {
        onExplain: function() {},
      }
    },
    // Only caret-contextual chords the native menu does NOT claim live here. Smart
    // File (Mod+Shift+E), Keep & Smart File (Mod+Shift+Return), Toggle AI Blocks
    // (Mod+J) and Ask (Mod+Shift+A) are owned outside the editor — do not rebind
    // them. See docs/editor-interaction-contract.md.
    addKeyboardShortcuts: function() {
      var self = this
      return {
        'Mod-e': function() { self.options.onExplain(); return true },
        'Mod-E': function() { self.options.onExplain(); return true },
      }
    }
  })
