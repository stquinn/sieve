// block-chrome.js — BlockChrome TipTap extension.
// Adds a ProseMirror plugin that renders gutter chrome (line number + drag handle + rail)
// for every top-level block node, plus drag-reorder.
//
// Strategy:
//   1. Decoration.node(from, to, { class: 'block-with-chrome' }) — applies to the outermost
//      DOM element for BOTH prose nodes AND atom NodeViews (Sieve blocks).
//   2. view.update() scan — after each state update, walks every .block-with-chrome element
//      and ensures its .block-chrome-host child is populated with line-number + handle + rail.
//      Sieve blocks already have a .block-chrome-host injected by sieve-block-extension.js;
//      prose nodes get one created here.
//
// Depends on window.TipTap (vendor/tiptap.js) loaded first.
;(function () {
  'use strict'

  var T = window.TipTap
  var Extension = T.Extension
  var Plugin = T.Plugin
  var PluginKey = T.PluginKey
  var Decoration = T.Decoration
  var DecorationSet = T.DecorationSet

  var blockChromeKey = new PluginKey('blockChrome')

  // ── Drag state ──────────────────────────────────────────────────────────────
  // Module-level; cleared on drop or dragend.  { from: number }
  var dragState = null

  // ── Top-level boundary helpers ──────────────────────────────────────────────

  // Given a clientY and the EditorView, find the nearest top-level boundary
  // (doc position: before a node or after the last node).
  // Returns a doc position integer or null.
  function nearestBoundary(view, clientY) {
    var doc = view.state.doc
    // Collect boundary doc positions: before each top-level node, plus after last.
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
      // Clamp to valid range for coordsAtPos
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

  // ── Build Decoration.node set ────────────────────────────────────────────────
  // Applies class 'block-with-chrome' to the outermost DOM element of every
  // top-level node.  Decoration.node works for both prose nodes AND atom NodeViews.

  function buildDecorations(state) {
    var decos = []

    state.doc.forEach(function (node, offset) {
      var from = offset
      var to   = offset + node.nodeSize
      decos.push(
        Decoration.node(from, to, { class: 'block-with-chrome' })
      )
    })

    // Drop indicator (only during drag)
    var pluginState = blockChromeKey.getState(state)
    if (pluginState && pluginState.indicatorPos != null) {
      var iPos = pluginState.indicatorPos
      var maxPos = state.doc.content.size
      var clampedPos = Math.max(0, Math.min(iPos, maxPos))
      decos.push(indicatorWidget(clampedPos))
    }

    return DecorationSet.create(state.doc, decos)
  }

  // ── Drop indicator widget ────────────────────────────────────────────────────

  function indicatorWidget(pos) {
    return Decoration.widget(
      pos,
      function () {
        var line = document.createElement('div')
        line.className = 'block-chrome-drop-indicator'
        line.setAttribute('contenteditable', 'false')
        return line
      },
      { side: -1, key: 'drop-indicator' }
    )
  }

  // ── Populate a single .block-chrome-host element ─────────────────────────────
  // Creates (or reuses) the line number, handle, and rail children.
  // blockIndex is 1-based.

  function populateChromeHost(host, blockIndex, pos, view) {
    // Idempotency: if already populated with the correct index, skip.
    var linenum = host.querySelector('.block-chrome-linenum')
    if (linenum && linenum.textContent === String(blockIndex)) return

    // Clear any stale content.
    while (host.firstChild) host.removeChild(host.firstChild)

    var num = document.createElement('span')
    num.className = 'block-chrome-linenum'
    num.textContent = String(blockIndex)

    var handle = document.createElement('span')
    handle.className = 'block-chrome-handle'
    handle.setAttribute('draggable', 'true')
    handle.textContent = '⠷'   // braille drag-dots glyph

    var rail = document.createElement('span')
    rail.className = 'block-chrome-rail'

    host.appendChild(num)
    host.appendChild(handle)
    host.appendChild(rail)

    // ── mousedown: select the entire top-level node ────────────────────
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault()
      var editor = window.__tiptap
      if (editor) {
        editor.commands.setNodeSelection(pos)
        view.focus()
      }
    })

    // ── dragstart: record source pos ───────────────────────────────────
    handle.addEventListener('dragstart', function (e) {
      dragState = { from: pos }
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('application/x-sieve-block', String(pos))
      // Set drag image to the block's DOM row
      try {
        var domNode = view.nodeDOM(pos)
        var imgEl = domNode && (domNode.nodeType === 1 ? domNode : domNode.parentElement)
        if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
      } catch (_) {}
    })

    // ── dragend: clean up (fires even if drop was outside editor) ──────
    handle.addEventListener('dragend', function () {
      if (dragState) {
        dragState = null
        try {
          view.dispatch(
            view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
          )
        } catch (_) {}
      }
    })
  }

  // ── Scan the editor DOM and ensure every .block-with-chrome has chrome ───────
  // Called from view.update() on every state change.
  //
  // We build a parallel list of top-level doc positions from state.doc so we
  // can pass the correct PM pos to each chrome host without relying on posAtDOM
  // (which is unreliable for atom NodeViews).

  function syncChromeDOM(editorView) {
    var doc = editorView.state.doc
    var editorDom = editorView.dom

    // Build an ordered list of { pos, nodeSize } for every top-level node.
    var topLevelPositions = []
    doc.forEach(function (node, offset) {
      topLevelPositions.push(offset)
    })

    var blocks = editorDom.querySelectorAll('.block-with-chrome')

    // blocks and topLevelPositions should have the same length.
    // If they don't (e.g. PM hasn't applied decorations yet), bail gracefully.
    var count = Math.min(blocks.length, topLevelPositions.length)

    for (var i = 0; i < count; i++) {
      var blockEl = blocks[i]
      var blockIndex = i + 1          // 1-based line number
      var pos = topLevelPositions[i]  // doc offset of this top-level node

      // Find or create the chrome host.
      // Sieve blocks already have one injected by sieve-block-extension.js.
      // Prose nodes need one created as their first child.
      var host = blockEl.querySelector(':scope > .block-chrome-host')
      if (!host) {
        host = document.createElement('div')
        host.className = 'block-chrome-host'
        host.setAttribute('contenteditable', 'false')
        blockEl.insertBefore(host, blockEl.firstChild)
      }

      populateChromeHost(host, blockIndex, pos, editorView)
    }
  }

  // ── Plugin ─────────────────────────────────────────────────────────────────

  var BlockChrome = Extension.create({
    name: 'blockChrome',
    addProseMirrorPlugins: function () {
      return [
        new Plugin({
          key: blockChromeKey,

          // Plugin state: { indicatorPos: number | null }
          state: {
            init: function () { return { indicatorPos: null } },
            apply: function (tr, prev) {
              var meta = tr.getMeta(blockChromeKey)
              if (meta && meta.indicatorPos !== undefined) {
                return { indicatorPos: meta.indicatorPos }
              }
              return prev
            },
          },

          props: {
            // ── Decorations ───────────────────────────────────────────────
            decorations: function (state) {
              return buildDecorations(state)
            },

            // ── DOM event handlers ─────────────────────────────────────────
            handleDOMEvents: {

              // dragover: update indicator to nearest boundary
              dragover: function (view, event) {
                if (!dragState) return false
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'

                var targetPos = nearestBoundary(view, event.clientY)
                if (targetPos == null) return true

                var currentState = blockChromeKey.getState(view.state)
                if (!currentState || currentState.indicatorPos !== targetPos) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: targetPos })
                  )
                }
                return true
              },

              // dragleave: clear indicator when cursor leaves the editor DOM
              dragleave: function (view, event) {
                if (!dragState) return false
                var related = event.relatedTarget
                if (!related || !view.dom.contains(related)) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                }
                return false
              },

              // drop: single-transaction reorder
              drop: function (view, event) {
                if (!dragState) return false
                event.preventDefault()

                var from = dragState.from
                dragState = null

                var targetPos = nearestBoundary(view, event.clientY)

                // Always clear the indicator — embed it in the same transaction
                // as the move (or a no-op transaction if no move).
                if (targetPos == null) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                  return true
                }

                var doc = view.state.doc
                var node = doc.nodeAt(from)
                if (!node) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                  return true
                }

                var nodeSize = node.nodeSize

                // If dropping back onto the same position, just clear indicator
                if (targetPos === from || targetPos === from + nodeSize) {
                  view.dispatch(
                    view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
                  )
                  return true
                }

                // ── Single transaction: clear indicator + delete + map + insert
                // Both the indicator clear and the doc mutation go in one tr —
                // critical for single-Mod+Z undo integrity.
                var tr = view.state.tr
                tr.setMeta(blockChromeKey, { indicatorPos: null })
                tr.delete(from, from + nodeSize)
                var insertAt = tr.mapping.map(targetPos)
                tr.insert(insertAt, node)
                view.dispatch(tr)

                return true
              },
            },
          },

          // ── view() callback: sync chrome DOM after every state update ────────
          view: function (editorView) {
            return {
              update: function (view) {
                // Use rAF to run after PM has applied its own DOM mutations.
                requestAnimationFrame(function () {
                  syncChromeDOM(view)
                })
              },
            }
          },
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
