// Renders gutter chrome (line number + drag handle + rail) for every top-level
// block, plus drag-reorder. Two strategies, because PM owns different DOM:
//
//   A — prose/native nodes (p, h1, ul, blockquote, …): PM owns their DOM, so a
//       manually injected <div> is foreign DOM that PM reconciles, and loops.
//       A Decoration.widget at offset+1 with side:-1 is tracked natively instead.
//
//   B — Sieve atom nodes: sieve-block-extension.js injects a .block-chrome-host
//       slot into every NodeView, whose ignoreMutation suppresses reconciliation
//       of its own DOM. view.update() finds that slot and populates it.
import { T as VENDOR } from './surfaces/tiptap-vendor.js'

var Extension = VENDOR.Extension
var Plugin = VENDOR.Plugin
var PluginKey = VENDOR.PluginKey
var Decoration = VENDOR.Decoration
var DecorationSet = VENDOR.DecorationSet

  var blockChromeKey = new PluginKey('blockChrome')

  // { from: number }; cleared on drop or dragend.
  var dragState = null

  // Tracks last handle-clicked block for shift-range selection
  var lastSelectedOffset = null

  // Given a clientY and the EditorView, finds the nearest top-level boundary
  // (before a node, or after the last). Returns a doc position or null.
  function nearestBoundary(view, clientY) {
    var doc = view.state.doc
    var positions = []
    doc.forEach(function (node, offset) {
      positions.push(offset)                      // before this node
    })
    if (positions.length > 0) {
      var last = positions[positions.length - 1]
      var lastNode = doc.nodeAt(last)
      if (lastNode) positions.push(last + lastNode.nodeSize)  // after last node
    }
    if (!positions.length) return null

    var bestPos = null
    var bestDist = Infinity
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i]
      var safeP = Math.max(0, Math.min(p, doc.content.size))
      var domCoords = null
      try { domCoords = view.coordsAtPos(safeP) } catch (_) { continue }
      if (!domCoords) continue
      var dist = Math.abs(domCoords.top - clientY)
      if (dist < bestDist) {
        bestDist = dist
        bestPos = p
      }
    }
    return bestPos
  }

  // Identity is the node TYPE: every structured Sieve block is a `sieve-*` node.
  // Prose/native nodes (paragraph, heading, proseGroup, …) never carry that prefix.

  function isSieveNode(node) {
    return !!(node && node.type && node.type.name.indexOf('sieve-') === 0)
  }

  // blockIndex is 1-based. offset is the doc offset of the node (for drag pos).
  // getPos is the PM widget factory's callback (may be null in fallback).

  function createChromeHostWidget(blockIndex, offset, view, getPos) {
    var host = document.createElement('div')
    host.className = 'block-chrome-host'
    host.setAttribute('contenteditable', 'false')
    host.setAttribute('data-chrome-strategy', 'prose')

    var num = document.createElement('span')
    num.className = 'block-chrome-linenum'
    num.textContent = String(blockIndex)

    var handle = document.createElement('span')
    handle.className = 'block-chrome-handle'
    handle.setAttribute('draggable', 'true')
    handle.textContent = '⠿'   // 2×3 drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    handle.addEventListener('mousedown', function (e) {
      // stopPropagation, NOT preventDefault: this suppresses PM's spurious
      // TextSelection while leaving the browser free to start a drag gesture.
      e.stopPropagation()
      var editor = window.__tiptap
      if (!editor) return

      if (e.shiftKey && lastSelectedOffset != null) {
        var doc = editor.state.doc
        var a = lastSelectedOffset
        var b = offset
        var lo = Math.min(a, b)
        var hi = Math.max(a, b)
        var hiNode = doc.nodeAt(hi)
        var to = hi + (hiNode ? hiNode.nodeSize : 1)
        // Our own plugin-state range, NOT setTextSelection — that snaps its endpoints
        // off the contentEditable=false sieve atoms, dropping them.
        editor.view.dispatch(editor.state.tr.setMeta(blockChromeKey, { range: { from: lo, to: to } }))
      } else {
        lastSelectedOffset = offset
        editor.commands.setNodeSelection(offset)
      }
      view.focus()
    })

    handle.addEventListener('dragstart', function (e) {
      dragState = { from: offset }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(offset))
      // stopImmediatePropagation keeps PM's bubble-phase dragstart from starting its
      // own NodeSelection drag (double-insert). preventDefault would cancel the drag.
      e.stopImmediatePropagation()
      try {
        var domNode = view.nodeDOM(offset)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    handle.addEventListener('dragend', function () {
      dragState = null
    })

    return host
  }

  // blockIndex is 1-based.
  function populateChromeHost(host, blockIndex, pos, view) {
    var linenum = host.querySelector('.block-chrome-linenum')
    if (linenum && linenum.textContent === String(blockIndex)) return

    while (host.firstChild) host.removeChild(host.firstChild)

    var num = document.createElement('span')
    num.className = 'block-chrome-linenum'
    num.textContent = String(blockIndex)

    var handle = document.createElement('span')
    handle.className = 'block-chrome-handle'
    handle.setAttribute('draggable', 'true')
    handle.textContent = '⠿'   // 2×3 drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    handle.addEventListener('mousedown', function (e) {
      e.stopPropagation()
      var editor = window.__tiptap
      if (!editor) return

      if (e.shiftKey && lastSelectedOffset != null) {
        var doc = editor.state.doc
        var a = lastSelectedOffset
        var b = pos
        var lo = Math.min(a, b)
        var hi = Math.max(a, b)
        var hiNode = doc.nodeAt(hi)
        var to = hi + (hiNode ? hiNode.nodeSize : 1)
        editor.view.dispatch(editor.state.tr.setMeta(blockChromeKey, { range: { from: lo, to: to } }))
      } else {
        lastSelectedOffset = pos
        editor.commands.setNodeSelection(pos)
      }
      view.focus()
    })

    handle.addEventListener('dragstart', function (e) {
      dragState = { from: pos }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(pos))
      e.stopImmediatePropagation()
      try {
        var domNode = view.nodeDOM(pos)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    handle.addEventListener('dragend', function () {
      dragState = null
    })
  }

  // The authoritative range for block-level selection + copy. Prefers our own
  // plugin-state range (handle click / shift-click / gutter drag), which unlike a
  // PM TextSelection does not snap off contentEditable=false sieve atoms; falls
  // back to the live PM selection for a plain caret / NodeSelection / prose drag.
  function effectiveRange(state) {
    var ps = blockChromeKey.getState(state)
    if (ps && ps.range) {
      return { from: ps.range.from, to: ps.range.to, active: ps.range.to > ps.range.from, isBlockRange: true, isNodeSelection: false }
    }
    var s = state.selection
    return { from: s.from, to: s.to, active: !s.empty, isBlockRange: false, isNodeSelection: !!s.node }
  }

  function buildDecorations(state) {
    var decos = []
    var index = 0
    var er = effectiveRange(state)

    state.doc.forEach(function (node, offset) {
      var i = index++   // capture for closure
      var from = offset
      var to   = offset + node.nodeSize

      // block-in-selection drives a FULL-NODE tint, but only for blocks that cannot show
      // a native selection highlight: content-less atoms (smart-card, smart-image), whose
      // DOM is contentEditable=false. Content-bearing sieve blocks render real editable
      // content and get the browser's own sub-text highlight — tinting the whole node
      // there makes a partial text drag look like (and copy as) a whole-block selection.
      // A single NodeSelection exactly on this block already has .ProseMirror-selectednode,
      // so it is not double-tinted.
      var isSingleNodeSel = !er.isBlockRange && er.isNodeSelection && er.from === from
      var tintWhole = isSieveNode(node) && (node.isAtom || er.isBlockRange)
      var inSel = tintWhole && er.active && er.from < to && er.to > from && !isSingleNodeSel
      decos.push(
        Decoration.node(from, to, { class: inSel ? 'block-with-chrome block-in-selection' : 'block-with-chrome' })
      )

      // Strategy A: prose/native nodes only. The widget sits at `offset` (BEFORE the
      // node) with side:1, so it renders as a DOM sibling preceding the block rather
      // than inside the <p>: draggable="true" inside a nested contenteditable is
      // unreliable across browsers, but works as a contenteditable=false sibling.
      if (!isSieveNode(node)) {
        decos.push(
          Decoration.widget(
            offset,
            function (widgetView, getPos) {
              return createChromeHostWidget(i + 1, offset, widgetView, getPos)
            },
            { side: 1, key: 'chrome-' + offset }
          )
        )
      }
    })

    return DecorationSet.create(state.doc, decos)
  }

  // Called from view.update(). ONLY fills the .block-chrome-host slot that
  // sieve-block-extension.js injected; prose nodes are Strategy A's.

  function syncSieveChrome(editorView) {
    var index = 0
    editorView.state.doc.forEach(function (node, offset) {
      var i = index++
      if (!isSieveNode(node)) return   // prose node — Decoration.widget handles it

      var nodeDOM = editorView.nodeDOM(offset)
      if (!nodeDOM) return

      // The slot should already be the NodeView's first child. If it is missing (the
      // renderer recreated its root, or injection raced a state update), inject it
      // here so chrome is always present.
      var host = nodeDOM.querySelector(':scope > .block-chrome-host')
      if (!host) {
        host = document.createElement('div')
        host.className = 'block-chrome-host'
        host.setAttribute('contenteditable', 'false')
        nodeDOM.insertBefore(host, nodeDOM.firstChild)
      }

      populateChromeHost(host, i + 1, offset, editorView)
    })
  }

  export var BlockChrome = Extension.create({
    name: 'blockChrome',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: blockChromeKey,

          // A real {from,to} pair of doc positions spanning whole blocks, set via
          // setMeta(blockChromeKey, { range }). Unlike a PM TextSelection it never snaps
          // off the sieve atoms, so it is the authoritative multi-block range.
          state: {
            init: function () { return { range: null } },
            apply: function (tr, prev) {
              var meta = tr.getMeta(blockChromeKey)
              if (meta && Object.prototype.hasOwnProperty.call(meta, 'range')) {
                return { range: meta.range }
              }
              // A normal selection change (plain click, typing, arrows) ends the
              // block-selection gesture → drop the range.
              if (tr.selectionSet) return { range: null }
              // Keep the range valid across doc edits (e.g. drag-reorder).
              if (prev.range && tr.docChanged) {
                return { range: { from: tr.mapping.map(prev.range.from), to: tr.mapping.map(prev.range.to) } }
              }
              return prev
            },
          },

          props: {
            decorations: function (state) {
              return buildDecorations(state)
            },

            // A whole-block selection lives in OUR plugin state, not in the PM selection, so
            // PM's own deleteSelection sees a collapsed caret and Backspace would be a
            // no-op on the highlighted blocks. Own the keystroke when — and only when — a
            // block-range is active; a plain text selection falls through to PM.
            handleKeyDown: function (view, event) {
              if (event.key !== 'Backspace' && event.key !== 'Delete') return false
              var er = effectiveRange(view.state)
              if (!er.isBlockRange || !er.active) return false
              event.preventDefault()
              var tr = view.state.tr.delete(er.from, er.to)
              tr.setMeta(blockChromeKey, { range: null })
              view.dispatch(tr.scrollIntoView())
              return true
            },

            handleDOMEvents: {

              dragover: function (view, event) {
                if (!dragState) return false
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                return true
              },

              drop: function (view, event) {
                if (!dragState) return false
                event.preventDefault()

                var from = dragState.from
                dragState = null

                var targetPos = nearestBoundary(view, event.clientY)
                if (targetPos == null) return true

                var doc = view.state.doc
                var node = doc.nodeAt(from)
                if (!node) return true

                var nodeSize = node.nodeSize
                if (targetPos === from || targetPos === from + nodeSize) return true

                // Single transaction: delete source + map insert position. One tr = one undo step.
                var tr = view.state.tr
                tr.delete(from, from + nodeSize)
                tr.insert(tr.mapping.map(targetPos), node)
                view.dispatch(tr)
                return true
              },
            },
          },

          view: function (editorView) {
            requestAnimationFrame(function () { syncSieveChrome(editorView) })

            // CSS :hover stops updating once the browser captures the mouse for a drag, so
            // the block under the cursor is found with elementFromPoint and marked directly.
            var dragHoverEl = null

            function clearDragHover() {
              if (dragHoverEl) {
                dragHoverEl.classList.remove('drag-hover')
                dragHoverEl = null
              }
            }

            function onMouseMove(e) {
              if (!dragState) { clearDragHover(); return }
              var el = document.elementFromPoint(e.clientX, e.clientY)
              var blockEl = null
              while (el && el !== editorView.dom) {
                if (el.classList && el.classList.contains('block-with-chrome')) {
                  blockEl = el; break
                }
                el = el.parentElement
              }
              if (blockEl !== dragHoverEl) {
                clearDragHover()
                if (blockEl) { blockEl.classList.add('drag-hover'); dragHoverEl = blockEl }
              }
            }

            function onMouseUp() {
              clearDragHover()
            }

            document.addEventListener('mousemove', onMouseMove)
            document.addEventListener('mouseup', onMouseUp)

            return {
              update: function (view) {
                // has-selection lets CSS and JS suppress hover-driven highlights (chain glows)
                // while a selection is active.
                view.dom.classList.toggle('has-selection', !view.state.selection.empty)

                // Expand the gutter for documents with many blocks, or line numbers wrap and
                // push the rail. 54px is the base width in editor.css (up to 99 blocks).
                var digits = String(view.state.doc.childCount).length
                var chromeW = 54
                if (digits > 2) {
                  chromeW = 54 + (digits - 2) * 8
                }
                view.dom.style.setProperty('--chrome-w', chromeW + 'px')

                requestAnimationFrame(function () { syncSieveChrome(view) })
              },
              destroy: function () {
                document.removeEventListener('mousemove', onMouseMove)
                document.removeEventListener('mouseup', onMouseUp)
              },
            }
          },
        }),
      ]
    },
  })

  // Authoritative block-selection range for the copy handler. isBlockRange=true means
  // our own multi-block range is set (shift-click / gutter drag); false means the
  // live PM selection (caret / single NodeSelection / native prose drag).
  export var getBlockSelectionRange = function (view) { return effectiveRange(view.state) }
