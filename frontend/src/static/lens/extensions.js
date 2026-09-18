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

  // Confluence-style heading autoformat: `h1. `, `h2. `, `h3. ` (case-insensitive)
  // typed at the start of a textblock converts it to a heading of that level,
  // alongside StarterKit's own `# `/`## `/`### ` rules. Space is the only boundary
  // character, the token must be the whole prefix, and levels are 1–3 only.
  //
  // Hand-rolled rather than a `textblockTypeInputRule`: the vendor bundle exports
  // neither that helper nor `InputRule`. The two guards below are the ones
  // prosemirror-inputrules and that helper apply — a `code` textblock never
  // autoformats, and the heading must be schema-legal where it would land.
  export var HeadingShortcuts = Extension.create({
    name: 'headingShortcuts',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          props: {
            handleTextInput: function (view, from, to, text) {
              if (text !== ' ') return false
              var state = view.state
              var heading = state.schema.nodes.heading
              if (!heading) return false

              var $from = state.doc.resolve(from)
              if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false

              var match = /^h([1-3])\.$/i.exec($from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc'))
              if (!match) return false
              if (!$from.node(-1).canReplaceWith($from.index(-1), $from.indexAfter(-1), heading)) return false

              var start = $from.start()
              // ONE tracked transaction, so a single Ctrl+Z reverts the conversion.
              view.dispatch(state.tr.delete(start, to).setBlockType(start, start, heading, { level: Number(match[1]) }))
              return true
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
    // (Mod+Alt+J) and Ask (Mod+Shift+A) are owned outside the editor — do not
    // rebind them. Explain is an AI verb, so it sits in the generate tier
    // (Mod+Shift) like its siblings. See docs/editor-interaction-contract.md.
    addKeyboardShortcuts: function() {
      var self = this
      return {
        'Mod-Shift-x': function() { self.options.onExplain(); return true },
        'Mod-Shift-X': function() { self.options.onExplain(); return true },
      }
    }
  })
