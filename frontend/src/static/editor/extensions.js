// extensions.js — vanilla JS TipTap custom extensions.
// Depends on the vendor TipTap bundle (ui/static/vendor/tiptap.js) being loaded first.

import { T as VENDOR } from '../base/tiptap-vendor.js'

var Node = VENDOR.Node
var Extension = VENDOR.Extension
var Plugin = VENDOR.Plugin
var PluginKey = VENDOR.PluginKey
var Decoration = VENDOR.Decoration
var DecorationSet = VENDOR.DecorationSet

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

  // ── Search ─────────────────────────────────────────────────────────────────

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

  export var SelectionHighlight = Extension.create({
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
                if (node.isLeaf && node.type.name.startsWith('sieve-')) {
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
  // P3.C/P3.D: reads ONLY the resolved AI target the editor STORED in its
  // SelectionContext (context.target = {kind, ref, range, label}) — no PM walk, no
  // node, no per-field re-derivation. For an ai-block follow-up target.ref is the
  // ai-block's own single id and target.label is already 'Follow-up'; Go walks the
  // block's ref back-pointer chain server-side (the frontend never pre-walks it).
  export function buildAiContext(context) {
    var t = context.target

    if (t.kind === 'document') return { blockRef: 'doc', contextLabel: 'Document' }
    // selection → the ref chain of every top-level block the selection crosses
    // (D-r.7 bug-1 fix); each block already carries an id, no blockRef wrap.
    if (t.kind === 'selection') return { blockRef: t.ref || 'doc', contextLabel: t.label }

    // block → the target's SINGLE id (P3.D). For an ai-block follow-up this is the
    // ai-block's own id and t.label is already 'Follow-up' (resolved in the surface):
    // Go walks the block's ref back-pointer chain and reconstitutes the thread. The
    // frontend never pre-walks the chain — sending "<ref>,<id>" did Go's job
    // incompletely. Every block kind falls through here.
    return { blockRef: t.ref || 'doc', contextLabel: t.label }
  }

  // ── applyTargetHighlight ─────────────────────────────────────────────────────
  // Canonical "mark this selection as the AI target". D-r.7: every top-level block
  // already carries an id (D-r.4 minting), so the AI target resolves by id and the
  // legacy blockRef wrap is no longer needed — we simply apply the == highlight
  // mark to the selected words. (The blockRef node type itself is retired in Stage
  // E; here it just stops being created.) Single source of truth shared by the
  // context menu's "Highlight Target" item and the Ask AI / Explain handler in
  // editor.js, so every entry point produces an identical target.
  export function applyTargetHighlight(editor, range) {
    // D-5: mark an EXPLICIT range {from,to} (a SelectionContext coordinate) — the
    // words the label named — and NEVER re-derive the extent from
    // editor.state.selection (which may have drifted since the label rendered).
    // Shared by askAi (context.target.range) and the context menu's "Highlight
    // Target" (its live-selection extent, passed in). No range / collapsed → no-op.
    if (!range || range.from == null || range.from === range.to) return
    if (editor.isActive && editor.isActive('highlight')) return // already marked
    editor.chain().setTextSelection({ from: range.from, to: range.to }).setMark('highlight').run()
  }

  // ── HighlightMark ──────────────────────────────────────────────────────────
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

  // BlockId (the prose identity attr) now lives in prose-block.js — the cohesive
  // prose block KIND definition — exported from there.

  export var AiShortcuts = Extension.create({
    name: 'aiShortcuts',
    addOptions: function() {
      return {
        onExplain: function() {},
      }
    },
    // Only caret-contextual chords the native menu does NOT claim live here.
    // Smart File (Mod+Shift+E), Keep & Smart File (Mod+Shift+Return) and Toggle
    // AI Blocks (Mod+J) are owned by the menu (App-Level Chords, see
    // docs/editor-interaction-contract.md) — do not rebind them in the editor.
    // ASK (Mod+Shift+A) LEFT the editor keymap in P4.E (D-5): the Ask panel is a
    // Workspace child and its document-level listener owns the chord wholesale (it
    // is a chrome action, not a caret-contextual edit). EXPLAIN (Mod+E) STAYS — it
    // is caret-contextual, so it is a legitimate editor chord.
    addKeyboardShortcuts: function() {
      var self = this
      return {
        'Mod-e': function() { self.options.onExplain(); return true },
        'Mod-E': function() { self.options.onExplain(); return true },
      }
    }
  })
