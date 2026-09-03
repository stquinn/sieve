import { T as VENDOR } from './document-editor/surfaces/tiptap-vendor.js'

var Node = VENDOR.Node
var Extension = VENDOR.Extension
var Plugin = VENDOR.Plugin
var PluginKey = VENDOR.PluginKey
var Decoration = VENDOR.Decoration
var DecorationSet = VENDOR.DecorationSet


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
