// block-chrome.js — BlockChrome TipTap extension.
// Adds a ProseMirror plugin that renders gutter chrome (drag handle + rail)
// as widget decorations on every top-level block node, plus drag-reorder.
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

  // ── Chrome widget factory ────────────────────────────────────────────────────
  // Returns a single Decoration.widget for the top-level node at `pos` (offset).
  // `view` is received as a parameter by the Decoration.widget toDOM callback.
  // The pos captured in closure is the raw doc offset of the top-level node.

  function chromeWidget(pos) {
    return Decoration.widget(
      pos + 1,   // place the widget at the start of the node's content
      function toDOM(view) {
        var wrap = document.createElement('div')
        wrap.className = 'block-chrome'
        wrap.setAttribute('contenteditable', 'false')

        var handle = document.createElement('span')
        handle.className = 'block-chrome-handle'
        handle.setAttribute('draggable', 'true')
        handle.textContent = '⠷'   // braille drag-dots glyph

        var rail = document.createElement('span')
        rail.className = 'block-chrome-rail'

        wrap.appendChild(handle)
        wrap.appendChild(rail)

        // ── mousedown: select the entire top-level node ────────────────────
        // NodeSelection is not exported from the vendor bundle, so we use the
        // TipTap setNodeSelection command exposed via window.__tiptap.
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
            var domNode = view.nodeDOM(pos + 1)
            var imgEl = domNode && (domNode.parentElement || domNode)
            if (imgEl && imgEl.nodeType === 1) e.dataTransfer.setDragImage(imgEl, 0, 0)
          } catch (_) {}
        })

        // ── dragend: clean up (fires even if drop was outside editor) ──────
        handle.addEventListener('dragend', function () {
          if (dragState) {
            dragState = null
            // Clear indicator (view may have changed state since dragstart)
            try {
              view.dispatch(
                view.state.tr.setMeta(blockChromeKey, { indicatorPos: null })
              )
            } catch (_) {}
          }
        })

        return wrap
      },
      { side: -1, key: 'chrome-' + pos }
    )
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
              var decos = []

              // Chrome widgets for every top-level node
              state.doc.forEach(function (node, offset) {
                decos.push(chromeWidget(offset))
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
        }),
      ]
    },
  })

  T.BlockChrome = BlockChrome
})()
